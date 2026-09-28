import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

async function startApp(t, fetchImpl) {
  const app = createApp({ config: { baseUrl: BASE, keyId: 'id', keySecret: 'secret' }, client: makeClient(fetchImpl) });
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP: generate retorna só { request_id } e status repassa /requests/{id}/status', async (t) => {
  const statusPayload = { status: 'completed', request_id: 'r1', video: { url: 'https://cdn/v.mp4' } };
  const fetchImpl = fakeFetch([() => submitted(), () => jsonResponse(200, statusPayload)]);
  const base = await startApp(t, fetchImpl);

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
  assert.deepEqual(await status.json(), statusPayload);
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
