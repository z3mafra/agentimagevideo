// Servidor HTTP da aplicação (sem dependências externas).
//
//   GET  /                                   interface web (public/index.html)
//   GET  /api/presets                        lista os presets configurados
//   POST /api/presets/:name/generate         dispara a geração e retorna { request_id }
//   GET  /api/presets/status/:request_id     repassa GET /requests/{request_id}/status
//   GET  /api/presets/:name/catalog          presets de marca do Marketing Studio (preset_id)
//   GET  /api/history                        gerações anteriores (mais recentes primeiro)
//   DELETE /api/history/:request_id          apaga o registro e a cópia local
//   GET  /media/:file                        cópia local da mídia gerada
//
// O browser só fala com estas rotas; a chave da Higgsfield fica no servidor.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createClient, HiggsfieldError } from './higgsfieldClient.js';
import { listPresets, resolvePreset } from './presets.js';
import { fetchPresetCatalog, generatePreset, PresetInputError } from './generatePreset.js';
import { createHistory } from './history.js';

const MAX_BODY_BYTES = 1024 * 1024;
const INDEX_HTML = fileURLToPath(new URL('../public/index.html', import.meta.url));

export function createApp({ config = loadConfig(), client, history, fetchImpl = globalThis.fetch } = {}) {
  client ??= createClient({ baseUrl: config.baseUrl, keyId: config.keyId, keySecret: config.keySecret, fetchImpl });
  history ??= createHistory({ dataDir: config.dataDir, fetchImpl });

  const routes = [
    ['GET', /^\/$/, async () => [200, await readFile(INDEX_HTML, 'utf8'), 'text/html; charset=utf-8']],

    ['GET', /^\/api\/presets$/, async () => [200, { presets: listPresets() }]],

    ['POST', /^\/api\/presets\/([^/]+)\/generate$/, async (req, url, [name]) => {
      const inputs = await readJson(req);
      // Só submete (uma vez); o polling é feito pelo frontend via /api/presets/status/:request_id.
      const out = await generatePreset(decodeURIComponent(name), inputs, { client, wait: false });
      const requestId = out.submission.request_id;
      try {
        const preset = resolvePreset(out.preset);
        await history.add({ request_id: requestId, preset: preset.key, presetName: preset.name, mediaType: preset.mediaType, inputs });
      } catch (err) {
        // A geração já foi aceita: falha no histórico não pode virar erro (o usuário reenviaria).
        console.error('Falha ao registrar no histórico:', err);
      }
      return [200, { request_id: requestId }];
    }],

    ['GET', /^\/api\/presets\/status\/([A-Za-z0-9_-]+)$/, async (req, url, [requestId]) => {
      const payload = await client.get(`/requests/${requestId}/status`);
      let entry = null;
      try {
        const known = await history.find(requestId);
        const preset = known && resolvePreset(known.preset);
        const outputUrl = preset && payload?.status === 'completed' ? preset.outputUrl(payload) : null;
        entry = await history.recordStatus(requestId, payload, outputUrl);
      } catch (err) {
        console.error('Falha ao atualizar o histórico:', err);
      }
      return [200, { ...payload, local_url: entry?.file ? `/media/${entry.file}` : null }];
    }],

    ['GET', /^\/api\/history$/, async () => [
      200,
      { items: (await history.list()).map((e) => ({ ...e, local_url: e.file ? `/media/${e.file}` : null })) },
    ]],

    ['DELETE', /^\/api\/history\/([A-Za-z0-9_-]+)$/, async (req, url, [requestId]) => (
      (await history.remove(requestId)) ? [200, { deleted: requestId }] : [404, { error: 'registro não encontrado', retryable: false }]
    )],

    ['GET', /^\/media\/([^/]+)$/, async (req, url, [name], res) => {
      const media = await history.mediaPath(name);
      if (!media) return [404, { error: 'arquivo não encontrado', retryable: false }];
      sendFile(req, res, media);
      return null;
    }],

    ['GET', /^\/api\/presets\/([^/]+)\/catalog$/, async (req, url, [name]) => [
      200,
      await fetchPresetCatalog(decodeURIComponent(name), { client }),
    ]],
  ];

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      for (const [method, pattern, fn] of routes) {
        const match = url.pathname.match(pattern);
        if (!match || req.method !== method) continue;
        const out = await fn(req, url, match.slice(1), res);
        if (!out) return; // a rota já respondeu (arquivo em stream)
        const [status, body, contentType] = out;
        return send(res, status, body, contentType);
      }
      return send(res, 404, { error: 'rota não encontrada', retryable: false });
    } catch (err) {
      const [status, body] = toErrorResponse(err);
      if (status >= 500) console.error(err);
      return send(res, status, body);
    }
  };
}

// `retryable` diz ao frontend se vale consultar de novo (rede/5xx) ou se deve parar (auth/validação).
export function toErrorResponse(err) {
  if (err instanceof PresetInputError) return [400, { error: err.message, retryable: false, ...err.details }];
  if (err instanceof HiggsfieldError) {
    if (err.ambiguous) {
      return [502, {
        error: 'Resultado da submissão desconhecido (timeout/rede/5xx). A geração pode ter sido aceita: ' +
          'o POST não foi repetido; confira antes de tentar de novo.',
        retryable: false,
        kind: err.kind,
        upstreamStatus: err.status,
      }];
    }
    if (err.kind === 'auth') {
      return [502, {
        error: 'Credenciais da Higgsfield rejeitadas (verifique HF_API_KEY_ID/HF_API_KEY_SECRET no servidor).',
        retryable: false,
        upstreamStatus: err.status,
      }];
    }
    if (err.kind === 'validation') {
      return [422, { error: 'A Higgsfield rejeitou a requisição.', retryable: false, upstreamStatus: err.status, upstream: err.body }];
    }
    return [502, { error: 'Higgsfield indisponível no momento.', retryable: true, kind: err.kind, upstreamStatus: err.status }];
  }
  if (err instanceof SyntaxError) return [400, { error: 'JSON inválido no corpo da requisição.', retryable: false }];
  if (err?.statusCode === 413) return [413, { error: 'Corpo da requisição muito grande.', retryable: false }];
  return [500, { error: 'Erro interno.', retryable: false }];
}

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

// Serve um arquivo de mídia com suporte a Range (necessário para avançar/voltar no <video>).
function sendFile(req, res, { full, size, type }) {
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
  }
  if (req.method === 'HEAD' || size === 0) return res.end();
  createReadStream(full, { start, end }).on('error', () => res.destroy()).pipe(res);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('payload too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const config = loadConfig();
  const server = http.createServer(createApp({ config }));
  server.listen(config.port, () => console.log(`Abra http://localhost:${config.port} no navegador`));
}
