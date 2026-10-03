import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient, HiggsfieldError } from '../src/higgsfieldClient.js';
import { buildPresetRequest, generatePreset, PresetInputError, pollStatus, fetchPresetCatalog } from '../src/generatePreset.js';
import { resolvePreset, PRESETS } from '../src/presets.js';
import { createApp } from '../src/server.js';

const BASE = 'https://api.higgsfield.ai';

function jsonResponse(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = handlers.shift();
    if (!handler) throw new Error(`chamada inesperada: ${init.method} ${u.pathname}`);
    return handler(u, init);
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};
const makeClient = (fetchImpl) => createClient({ baseUrl: BASE, keyId: 'id', keySecret: 'secret', fetchImpl, sleep: noSleep });
const submitted = (id = 'r1') => jsonResponse(200, { status: 'queued', request_id: id, status_url: `${BASE}/requests/${id}/status` });

test('resolve preset por slug ou nome com acento', () => {
  assert.equal(resolvePreset('imagem-de-produto').key, 'imagem-de-produto');
  assert.equal(resolvePreset('Imagem de produto').key, 'imagem-de-produto');
  assert.equal(resolvePreset('B-roll de tela').key, 'b-roll-de-tela');
  assert.equal(resolvePreset('nao-existe'), null);
});

test('Corte para Reels: endpoint Kling e image_url obrigatório', () => {
  assert.throws(() => buildPresetRequest('corte-para-reels', { prompt: 'x' }), (err) => {
    assert.ok(err instanceof PresetInputError);
    assert.deepEqual(err.details.missing, ['image_url']);
    return true;
  });
  const r = buildPresetRequest('corte-para-reels', { prompt: 'estrada costeira', image_url: 'https://cdn/f.jpg' });
  assert.equal(r.path, '/kling-video/v2.5-turbo/standard/image-to-video');
  assert.deepEqual(r.body, { prompt: 'estrada costeira', image_url: 'https://cdn/f.jpg' });
});

test('prompt é obrigatório em todos os presets', () => {
  for (const [key, preset] of Object.entries(PRESETS)) {
    const inputs = { prompt: '   ', ...(preset.fields.image_url ? { image_url: 'https://cdn/f.jpg' } : {}) };
    assert.throws(() => buildPresetRequest(key, inputs), (err) => {
      assert.ok(err.details.missing.includes('prompt'));
      return true;
    });
  }
});

test('Imagem de produto: bodyBase mantido quando não fornecido, sobrescrito quando fornecido', () => {
  const r = buildPresetRequest('imagem-de-produto', { prompt: 'vaso', aspect_ratio: '4:5' });
  assert.equal(r.path, '/marketing-studio/image/flare');
  assert.equal(r.body.resolution, '2k');
  assert.equal(r.body.quality, 'high');
  assert.equal(r.body.enhance_prompt, false);
  assert.equal(r.body.aspect_ratio, '4:5');
});

test('Imagem de produto com preset de marca: exige image_urls (1–2) e liga enhance_prompt', () => {
  assert.throws(() => buildPresetRequest('imagem-de-produto', { prompt: 'x', preset_id: 'p1' }), /image_urls/);
  assert.throws(() => buildPresetRequest('imagem-de-produto', { prompt: 'x', preset_id: 'p1', image_urls: ['a', 'b', 'c'] }), PresetInputError);
  const r = buildPresetRequest('imagem-de-produto', { prompt: 'x', preset_id: 'p1', image_urls: ['https://cdn/p.png'] });
  assert.equal(r.body.enhance_prompt, true);
  assert.equal(r.body.preset_id, 'p1');
  const explicit = buildPresetRequest('imagem-de-produto', { prompt: 'x', preset_id: 'p1', image_urls: ['u'], enhance_prompt: false });
  assert.equal(explicit.body.enhance_prompt, false);
});

test('B-roll de tela: só prompt', () => {
  const r = buildPresetRequest('b-roll-de-tela', { prompt: 'dashboard' });
  assert.equal(r.path, '/minimax/hailuo-2.3/standard/text-to-video');
  assert.deepEqual(Object.keys(r.body), ['prompt']);
});

test('rejeita campos não documentados e tipos errados', () => {
  assert.throws(() => buildPresetRequest('b-roll-de-tela', { prompt: 'x', duration: 10 }), (err) => {
    assert.deepEqual(err.details.unknown, ['duration']);
    return true;
  });
  assert.throws(() => buildPresetRequest('imagem-de-produto', { enhance_prompt: 'yes' }), PresetInputError);
});

test('generatePreset: POST único com auth, polling até completed e URL do vídeo', async () => {
  const fetchImpl = fakeFetch([
    () => submitted(),
    () => jsonResponse(200, { status: 'in_progress' }),
    () => jsonResponse(503, { detail: 'busy' }),
    () => jsonResponse(200, { status: 'completed', video: { url: 'https://cdn/v.mp4' } }),
  ]);
  const out = await generatePreset('corte-para-reels', { prompt: 'x', image_url: 'https://cdn/f.jpg' }, { client: makeClient(fetchImpl), poll: { sleep: noSleep } });
  assert.equal(out.result.status, 'completed');
  assert.equal(out.outputUrl, 'https://cdn/v.mp4');
  assert.equal(fetchImpl.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Key id:secret');
  assert.equal(fetchImpl.calls[0].headers['Content-Type'], 'application/json');
  assert.equal(fetchImpl.calls[1].path, '/requests/r1/status');
});

test('imagem: outputUrl vem de images[0].url', async () => {
  const fetchImpl = fakeFetch([() => submitted(), () => jsonResponse(200, { status: 'completed', images: [{ url: 'https://cdn/i.png' }] })]);
  const out = await generatePreset('imagem-de-produto', { prompt: 'vaso' }, { client: makeClient(fetchImpl), poll: { sleep: noSleep } });
  assert.equal(out.outputUrl, 'https://cdn/i.png');
});

test('POST com 500 ou timeout não é repetido e é marcado como ambíguo', async () => {
  for (const handler of [() => jsonResponse(500, {}), () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }]) {
    const fetchImpl = fakeFetch([handler]);
    await assert.rejects(
      generatePreset('b-roll-de-tela', { prompt: 'x' }, { client: makeClient(fetchImpl) }),
      (err) => err instanceof HiggsfieldError && err.ambiguous === true,
    );
    assert.equal(fetchImpl.calls.length, 1);
  }
});

test('POST com 422 não é ambíguo nem repetido', async () => {
  const fetchImpl = fakeFetch([() => jsonResponse(422, { detail: 'bad' })]);
  await assert.rejects(generatePreset('b-roll-de-tela', { prompt: 'x' }, { client: makeClient(fetchImpl) }), (err) => err.kind === 'validation' && !err.ambiguous);
  assert.equal(fetchImpl.calls.length, 1);
});

test('erros de auth/validação no polling não são repetidos', async () => {
  for (const status of [401, 403, 400, 422]) {
    const fetchImpl = fakeFetch([() => jsonResponse(status, {})]);
    await assert.rejects(pollStatus(makeClient(fetchImpl), { request_id: 'r1' }, { sleep: noSleep }), HiggsfieldError);
    assert.equal(fetchImpl.calls.length, 1);
  }
});

test('backoff de GET é limitado', async () => {
  const fetchImpl = fakeFetch(Array.from({ length: 6 }, () => () => jsonResponse(502, {})));
  await assert.rejects(makeClient(fetchImpl).get('/requests/r1/status'), (err) => err.kind === 'server');
  assert.equal(fetchImpl.calls.length, 6); // 1 + 5 retries
});

test('timeout do polling devolve último status sem re-submeter', async () => {
  let t = 0;
  const fetchImpl = fakeFetch([() => jsonResponse(200, { status: 'in_progress' }), () => jsonResponse(200, { status: 'in_progress' })]);
  const out = await pollStatus(makeClient(fetchImpl), { request_id: 'r1', status_url: `${BASE}/requests/r1/status` }, {
    timeoutMs: 3000,
    sleep: async (ms) => { t += ms; },
    now: () => t,
  });
  assert.equal(out.timedOut, true);
  assert.equal(out.request_id, 'r1');
  assert.ok(fetchImpl.calls.every((c) => c.method === 'GET'));
});

test('status_url de outro host não recebe as credenciais', async () => {
  const fetchImpl = fakeFetch([() => jsonResponse(200, { status: 'completed' })]);
  await pollStatus(makeClient(fetchImpl), { request_id: 'r1', status_url: 'https://evil.example/requests/r1/status' }, { sleep: noSleep });
  assert.equal(fetchImpl.calls[0].path, '/requests/r1/status');
});

test('catálogo de presets de marca', async () => {
  const fetchImpl = fakeFetch([() => jsonResponse(200, { items: [] })]);
  await fetchPresetCatalog('imagem-de-produto', { client: makeClient(fetchImpl) });
  assert.equal(fetchImpl.calls[0].path, '/marketing-studio/image/presets');
  await assert.rejects(fetchPresetCatalog('b-roll-de-tela', { client: makeClient(fetchImpl) }), PresetInputError);
});

async function startApp(t, fetchImpl, { cdnFetch = async () => { throw new Error('download inesperado'); } } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aiv-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = createApp({
    config: { baseUrl: BASE, keyId: 'id', keySecret: 'secret', dataDir },
    client: makeClient(fetchImpl),
    fetchImpl: cdnFetch,
  });
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP: generate retorna só { request_id } e status repassa /requests/{id}/status', async (t) => {
  const statusPayload = { status: 'completed', request_id: 'r1', video: { url: 'https://cdn/v.mp4' } };
  const fetchImpl = fakeFetch([() => submitted(), () => jsonResponse(200, statusPayload)]);
  const base = await startApp(t, fetchImpl, { cdnFetch: async () => new Response('vid', { headers: { 'content-type': 'video/mp4' } }) });

  const ok = await fetch(`${base}/api/presets/b-roll-de-tela/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'ondas' }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { request_id: 'r1' });
  assert.equal(fetchImpl.calls.length, 1); // não faz polling no servidor
  assert.equal(fetchImpl.calls[0].path, '/minimax/hailuo-2.3/standard/text-to-video');
  assert.deepEqual(fetchImpl.calls[0].body, { prompt: 'ondas' });

  const status = await fetch(`${base}/api/presets/status/r1`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { ...statusPayload, local_url: '/media/r1.mp4' });
  assert.equal(fetchImpl.calls[1].path, '/requests/r1/status');

  const bad = await fetch(`${base}/api/presets/corte-para-reels/generate`, { method: 'POST', body: '{"prompt":"x"}' });
  assert.equal(bad.status, 400);
  assert.deepEqual((await bad.json()).missing, ['image_url']);

  const list = await (await fetch(`${base}/api/presets`)).json();
  assert.equal(list.presets.length, 3);
  assert.deepEqual(list.presets.map((p) => p.requiresImage), [true, false, false]);
  assert.ok(!JSON.stringify(list).includes('secret'));
});

test('HTTP: erros de status indicam se vale consultar de novo', async (t) => {
  const fetchImpl = fakeFetch([
    () => jsonResponse(401, {}),
    ...Array.from({ length: 6 }, () => () => jsonResponse(503, {})),
  ]);
  const base = await startApp(t, fetchImpl);

  const auth = await fetch(`${base}/api/presets/status/r1`);
  assert.equal(auth.status, 502);
  assert.equal((await auth.json()).retryable, false);

  const down = await fetch(`${base}/api/presets/status/r1`);
  assert.equal(down.status, 502);
  assert.equal((await down.json()).retryable, true);
});

test('HTTP: serve a interface em / sem expor a chave', async (t) => {
  const base = await startApp(t, fakeFetch([]));
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /\/api\/presets\/status\//);
  assert.ok(!html.includes('api.higgsfield.ai'));
});

test('HTTP: lista opções e catálogo; generate repassa opções e preset de marca', async (t) => {
  const catalog = { items: [{ id: 'p1', name: 'Minimalista' }] };
  const fetchImpl = fakeFetch([() => jsonResponse(200, catalog), () => submitted()]);
  const base = await startApp(t, fetchImpl);

  const { presets } = await (await fetch(`${base}/api/presets`)).json();
  const produto = presets.find((p) => p.key === 'imagem-de-produto');
  assert.equal(produto.hasCatalog, true);
  assert.deepEqual(produto.options.map((o) => o.field), ['aspect_ratio', 'resolution', 'quality', 'enhance_prompt']);
  assert.equal(produto.options.find((o) => o.field === 'resolution').default, '2k');
  assert.equal(produto.options.find((o) => o.field === 'enhance_prompt').default, false);
  assert.deepEqual(presets.find((p) => p.key === 'b-roll-de-tela').options, []);
  for (const p of Object.values(PRESETS)) {
    for (const field of Object.keys(p.options ?? {})) assert.ok(field in p.fields, `${field} precisa estar em fields`);
  }

  const cat = await fetch(`${base}/api/presets/imagem-de-produto/catalog`);
  assert.deepEqual(await cat.json(), catalog);
  assert.equal(fetchImpl.calls[0].path, '/marketing-studio/image/presets');

  const res = await fetch(`${base}/api/presets/imagem-de-produto/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'vaso', aspect_ratio: '9:16', preset_id: 'p1', image_urls: ['https://cdn/p.png'] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(fetchImpl.calls[1].body, {
    prompt: 'vaso', resolution: '2k', aspect_ratio: '9:16', quality: 'high', enhance_prompt: true,
    preset_id: 'p1', image_urls: ['https://cdn/p.png'],
  });
});

test('histórico: registra, baixa a mídia uma vez, serve com Range e apaga', async (t) => {
  const done = { status: 'completed', request_id: 'r9', images: [{ url: 'https://cdn.example/out/img' }] };
  const fetchImpl = fakeFetch([() => submitted('r9'), () => jsonResponse(200, { status: 'in_progress' }), () => jsonResponse(200, done), () => jsonResponse(200, done)]);
  const downloads = [];
  const cdnFetch = async (url) => {
    downloads.push(url);
    return new Response('0123456789', { headers: { 'content-type': 'image/png', 'content-length': '10' } });
  };
  const base = await startApp(t, fetchImpl, { cdnFetch });
  const post = (body) => fetch(`${base}/api/presets/imagem-de-produto/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  assert.equal((await post({ prompt: 'vaso azul' })).status, 200);
  let { items } = await (await fetch(`${base}/api/history`)).json();
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'queued');
  assert.equal(items[0].prompt, 'vaso azul');
  assert.equal(items[0].presetName, 'Imagem de produto');

  assert.equal((await (await fetch(`${base}/api/presets/status/r9`)).json()).local_url, null);
  const [a, b] = await Promise.all([fetch(`${base}/api/presets/status/r9`), fetch(`${base}/api/presets/status/r9`)]);
  assert.equal((await a.json()).local_url, '/media/r9.png');
  assert.equal((await b.json()).local_url, '/media/r9.png');
  assert.deepEqual(downloads, ['https://cdn.example/out/img']); // baixou só uma vez

  ({ items } = await (await fetch(`${base}/api/history`)).json());
  assert.equal(items[0].status, 'completed');
  assert.equal(items[0].remote_url, 'https://cdn.example/out/img');
  assert.equal(items[0].local_url, '/media/r9.png');

  const full = await fetch(`${base}/media/r9.png`);
  assert.equal(full.headers.get('content-type'), 'image/png');
  assert.equal(await full.text(), '0123456789');
  const part = await fetch(`${base}/media/r9.png`, { headers: { range: 'bytes=2-4' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(await part.text(), '234');

  for (const bad of ['..%2Fhistory.json', 'r9.png.part', 'r9.html', 'nao-existe.png']) {
    assert.equal((await fetch(`${base}/media/${bad}`)).status, 404, bad);
  }

  assert.equal((await fetch(`${base}/api/history/r9`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/media/r9.png`)).status, 404);
  assert.deepEqual((await (await fetch(`${base}/api/history`)).json()).items, []);
  assert.equal((await fetch(`${base}/api/history/r9`, { method: 'DELETE' })).status, 404);
});

test('histórico: falha no download não quebra o status e mantém o link remoto', async (t) => {
  const done = { status: 'completed', video: { url: 'https://cdn.example/v.mp4' } };
  const fetchImpl = fakeFetch([() => submitted('r5'), () => jsonResponse(200, done)]);
  const base = await startApp(t, fetchImpl, { cdnFetch: async () => new Response('', { status: 403 }) });
  await fetch(`${base}/api/presets/b-roll-de-tela/generate`, { method: 'POST', body: '{"prompt":"mar"}' });
  const status = await fetch(`${base}/api/presets/status/r5`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).local_url, null);
  const [item] = (await (await fetch(`${base}/api/history`)).json()).items;
  assert.equal(item.status, 'completed');
  assert.equal(item.remote_url, 'https://cdn.example/v.mp4');
  assert.match(item.error, /cópia local falhou/);
});

test('histórico: persiste em disco entre reinícios', async () => {
  const { createHistory } = await import('../src/history.js');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aiv-test-'));
  try {
    const h1 = createHistory({ dataDir });
    await h1.add({ request_id: 'r1', preset: 'b-roll-de-tela', presetName: 'B-roll de tela', mediaType: 'video', inputs: { prompt: 'x' } });
    await h1.flush();
    const saved = JSON.parse(await readFile(path.join(dataDir, 'history.json'), 'utf8'));
    assert.equal(saved[0].request_id, 'r1');
    const h2 = createHistory({ dataDir });
    assert.equal((await h2.list())[0].prompt, 'x');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
