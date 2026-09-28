// Servidor HTTP da aplicação (sem dependências externas).
//
//   GET  /api/presets                        lista os presets configurados
//   POST /api/presets/:name/generate         gera (?wait=false para só submeter)
//   GET  /api/presets/:name/catalog          presets de marca do Marketing Studio (preset_id)
//   GET  /api/requests/:requestId/status     re-consulta o status (?wait=true continua o polling)

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createClient, HiggsfieldError } from './higgsfieldClient.js';
import { listPresets } from './presets.js';
import { fetchPresetCatalog, generatePreset, PresetInputError, pollStatus } from './generatePreset.js';

const MAX_BODY_BYTES = 1024 * 1024;

export function createApp({ config = loadConfig(), client, fetchImpl = globalThis.fetch, poll = {} } = {}) {
  client ??= createClient({ baseUrl: config.baseUrl, keyId: config.keyId, keySecret: config.keySecret, fetchImpl });
  const pollOptions = { timeoutMs: config.pollTimeoutMs, ...poll };

  const routes = [
    ['GET', /^\/api\/presets$/, async () => [200, { presets: listPresets() }]],

    ['POST', /^\/api\/presets\/([^/]+)\/generate$/, async (req, url, [name]) => {
      const inputs = await readJson(req);
      const wait = url.searchParams.get('wait') !== 'false';
      const out = await generatePreset(decodeURIComponent(name), inputs, { client, wait, poll: pollOptions });
      const requestId = out.submission.request_id;
      const body = { ...out, request_id: requestId, status: out.result?.status ?? out.submission.status };
      if (!wait || out.result?.timedOut) {
        return [202, { ...body, poll: `/api/requests/${encodeURIComponent(requestId)}/status` }];
      }
      return [200, body];
    }],

    ['GET', /^\/api\/presets\/([^/]+)\/catalog$/, async (req, url, [name]) => [
      200,
      await fetchPresetCatalog(decodeURIComponent(name), { client }),
    ]],

    ['GET', /^\/api\/requests\/([A-Za-z0-9_-]+)\/status$/, async (req, url, [requestId]) => {
      // wait=true: continua o polling de uma geração já submetida (nunca re-submete).
      if (url.searchParams.get('wait') === 'true') {
        return [200, await pollStatus(client, { request_id: requestId }, pollOptions)];
      }
      return [200, await client.get(`/requests/${requestId}/status`)];
    }],
  ];

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      for (const [method, pattern, fn] of routes) {
        const match = url.pathname.match(pattern);
        if (!match || req.method !== method) continue;
        const [status, body] = await fn(req, url, match.slice(1));
        return send(res, status, body);
      }
      return send(res, 404, { error: 'rota não encontrada' });
    } catch (err) {
      const [status, body] = toErrorResponse(err);
      if (status >= 500) console.error(err);
      return send(res, status, body);
    }
  };
}

export function toErrorResponse(err) {
  if (err instanceof PresetInputError) return [400, { error: err.message, ...err.details }];
  if (err instanceof HiggsfieldError) {
    if (err.ambiguous) {
      return [502, {
        error: 'Resultado da submissão desconhecido (timeout/rede/5xx). A geração pode ter sido aceita: ' +
          'o POST não foi repetido; confira antes de tentar de novo.',
        kind: err.kind,
        upstreamStatus: err.status,
      }];
    }
    if (err.kind === 'auth') {
      return [502, { error: 'Credenciais da Higgsfield rejeitadas (verifique HF_API_KEY_ID/HF_API_KEY_SECRET no servidor).', upstreamStatus: err.status }];
    }
    if (err.kind === 'validation') return [422, { error: 'A Higgsfield rejeitou a requisição.', upstreamStatus: err.status, upstream: err.body }];
    return [502, { error: 'Higgsfield indisponível no momento.', kind: err.kind, upstreamStatus: err.status }];
  }
  if (err instanceof SyntaxError) return [400, { error: 'JSON inválido no corpo da requisição.' }];
  if (err?.statusCode === 413) return [413, { error: 'Corpo da requisição muito grande.' }];
  return [500, { error: 'Erro interno.' }];
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
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
  server.listen(config.port, () => console.log(`Presets API em http://localhost:${config.port}`));
}
