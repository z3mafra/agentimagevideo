// Histórico de gerações e cópia local das mídias.
//
// - data/history.json: um registro por geração (preset, prompt, status, arquivo local).
// - data/media/<request_id>.<ext>: cópia da mídia, baixada assim que o status vira
//   `completed` (os links da Higgsfield podem expirar).
//
// As escritas no JSON são serializadas e atômicas (arquivo temporário + rename).

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};
const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', ...Object.fromEntries(Object.entries(MEDIA_TYPES).map(([e, t]) => [t, e])) };
export const MEDIA_FILE_RE = new RegExp(`^[A-Za-z0-9_-]+\\.(${Object.keys(MEDIA_TYPES).join('|')})$`);

const MAX_ENTRIES = 500;

function pickExtension(contentType, url, mediaType) {
  const fromType = EXT_BY_TYPE[String(contentType || '').split(';')[0].trim().toLowerCase()];
  if (fromType) return fromType;
  const fromUrl = path.extname(new URL(url).pathname).slice(1).toLowerCase().replace('jpeg', 'jpg');
  if (MEDIA_TYPES[fromUrl]) return fromUrl;
  return mediaType === 'image' ? 'png' : 'mp4';
}

export function createHistory({
  dataDir,
  fetchImpl = globalThis.fetch,
  downloadTimeoutMs = 5 * 60 * 1000,
  maxDownloadBytes = 500 * 1024 * 1024,
  now = () => new Date().toISOString(),
} = {}) {
  const mediaDir = path.join(dataDir, 'media');
  const file = path.join(dataDir, 'history.json');
  let entries = null;
  let writeChain = Promise.resolve();
  const saving = new Map(); // request_id → promessa do download em andamento

  async function load() {
    if (entries) return entries;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      entries = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('history.json ilegível; começando vazio.', err);
      entries = [];
    }
    return entries;
  }

  function persist() {
    const snapshot = JSON.stringify(entries, null, 2);
    writeChain = writeChain.then(async () => {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, file);
    });
    return writeChain;
  }

  async function find(requestId) {
    return (await load()).find((e) => e.request_id === requestId) ?? null;
  }

  async function update(requestId, patch) {
    const entry = await find(requestId);
    if (!entry) return null;
    Object.assign(entry, patch, { updated_at: now() });
    await persist();
    return entry;
  }

  async function list() {
    return [...(await load())].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async function add({ request_id, preset, presetName, mediaType, inputs }) {
    const all = await load();
    const existing = all.find((e) => e.request_id === request_id);
    if (existing) return existing;
    const entry = {
      request_id,
      preset,
      presetName,
      mediaType,
      prompt: inputs.prompt ?? '',
      inputs,
      status: 'queued',
      created_at: now(),
      updated_at: now(),
      remote_url: null,
      file: null,
      error: null,
    };
    all.push(entry);
    // Mantém só os mais recentes no registro (os arquivos antigos ficam no disco).
    if (all.length > MAX_ENTRIES) all.splice(0, all.length - MAX_ENTRIES);
    await persist();
    return entry;
  }

  async function download(entry, url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), downloadTimeoutMs);
    // Sem credenciais: é um link público de CDN, não a API.
    const res = await fetchImpl(url, { signal: controller.signal });
    try {
      if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > maxDownloadBytes) throw new Error('arquivo grande demais');
      const ext = pickExtension(res.headers.get('content-type'), url, entry.mediaType);
      const name = `${entry.request_id}.${ext}`;
      await mkdir(mediaDir, { recursive: true });
      const target = path.join(mediaDir, name);
      const tmp = `${target}.part`;
      let size = 0;
      const limit = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          cb(size > maxDownloadBytes ? new Error('arquivo grande demais') : null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(res.body), limit, createWriteStream(tmp));
        await rename(tmp, target);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      return name;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Registra um status vindo da Higgsfield. Em `completed`, baixa a mídia (uma vez,
   * mesmo com consultas simultâneas). Devolve o registro atualizado ou null se o
   * request_id não foi gerado por este servidor.
   */
  async function recordStatus(requestId, statusPayload, outputUrl) {
    const entry = await find(requestId);
    if (!entry) return null;
    const status = statusPayload?.status;
    if (status !== 'completed') {
      if (status && status !== entry.status) await update(requestId, { status });
      return entry;
    }
    if (entry.file) return entry;
    if (!outputUrl) return update(requestId, { status, error: 'resposta sem link da mídia' });
    if (!saving.has(requestId)) {
      const job = (async () => {
        try {
          const name = await download(entry, outputUrl);
          return update(requestId, { status, remote_url: outputUrl, file: name, error: null });
        } catch (err) {
          return update(requestId, { status, remote_url: outputUrl, error: `cópia local falhou: ${err.message}` });
        }
      })().finally(() => saving.delete(requestId));
      saving.set(requestId, job);
    }
    return saving.get(requestId);
  }

  async function remove(requestId) {
    const all = await load();
    const index = all.findIndex((e) => e.request_id === requestId);
    if (index === -1) return false;
    const [entry] = all.splice(index, 1);
    await persist();
    if (entry.file && MEDIA_FILE_RE.test(entry.file)) await rm(path.join(mediaDir, entry.file), { force: true });
    return true;
  }

  /** Caminho absoluto de um arquivo de mídia, ou null se o nome não for válido / não existir. */
  async function mediaPath(name) {
    if (!MEDIA_FILE_RE.test(name)) return null;
    const full = path.join(mediaDir, name);
    try {
      const info = await stat(full);
      return info.isFile() ? { full, size: info.size, type: MEDIA_TYPES[path.extname(name).slice(1)] } : null;
    } catch {
      return null;
    }
  }

  return { add, list, find, recordStatus, remove, mediaPath, flush: () => writeChain };
}
