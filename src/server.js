// Servidor HTTP da aplicação (sem dependências externas).
//
//   GET  /                                   interface web (public/index.html)
//   GET  /api/presets                        lista os presets configurados
//   POST /api/presets/:name/generate         dispara a geração e retorna { request_id }
//   GET  /api/presets/status/:request_id     repassa GET /requests/{request_id}/status
//   GET  /api/presets/:name/catalog          presets de marca do Marketing Studio (preset_id)
//
// O browser só fala com estas rotas; a chave da Higgsfield fica no servidor.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createClient, HiggsfieldError } from './higgsfieldClient.js';
import { listPresets } from './presets.js';
import { fetchPresetCatalog, generatePreset, PresetInputError } from './generatePreset.js';

const MAX_BODY_BYTES = 1024 * 1024;
const INDEX_HTML = fileURLToPath(new URL('../public/index.html', import.meta.url));

export function createApp({ config = loadConfig(), client, fetchImpl = globalThis.fetch } = {}) {
  client ??= createClient({ baseUrl: config.baseUrl, keyId: config.keyId, keySecret: config.keySecret, fetchImpl });

  const routes = [
    ['GET', /^\/$/, async () => [200, await readFile(INDEX_HTML, 'utf8'), 'text/html; charset=utf-8']],

    ['GET', /^\/api\/presets$/, async () => [200, { presets: listPresets() }]],

    ['POST', /^\/api\/presets\/([^/]+)\/generate$/, async (req, url, [name]) => {
      const inputs = await readJson(req);
      // Só submete (uma vez); o polling é feito pelo frontend via /api/presets/status/:request_id.
      const out = await generatePreset(decodeURIComponent(name), inputs, { client, wait: false });
      return [200, { request_id: out.submission.request_id }];
    }],

    ['GET', /^\/api\/presets\/status\/([A-Za-z0-9_-]+)$/, async (req, url, [requestId]) => [
      200,
      await client.get(`/requests/${requestId}/status`),
    ]],

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
        const [status, body, contentType] = await fn(req, url, match.slice(1));
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
