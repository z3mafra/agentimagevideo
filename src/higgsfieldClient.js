// Cliente HTTP mínimo para a Higgsfield API.
//
// Política de retry:
// - POST (submissão de geração): NUNCA é repetido automaticamente. Se houver
//   timeout, erro de rede ou 5xx, a submissão é marcada como `ambiguous` —
//   ela pode ter sido aceita — e o chamador deve apenas consultar status.
// - GET (status, catálogo): backoff exponencial limitado somente para erros
//   de rede/timeout/5xx. Auth (401/403), validação (400/422) e qualquer
//   outro 4xx falham imediatamente.

export class HiggsfieldError extends Error {
  constructor(message, { kind, status = null, body = null, ambiguous = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HiggsfieldError';
    this.kind = kind; // 'auth' | 'validation' | 'server' | 'network' | 'timeout'
    this.status = status;
    this.body = body;
    this.ambiguous = ambiguous;
  }

  get transient() {
    return TRANSIENT_KINDS.has(this.kind);
  }
}

const TRANSIENT_KINDS = new Set(['server', 'network', 'timeout']);

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server';
  return 'validation';
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createClient({
  baseUrl,
  keyId,
  keySecret,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 30_000,
  retry = { maxRetries: 5, baseDelayMs: 1_000, maxDelayMs: 30_000 },
  sleep = defaultSleep,
} = {}) {
  if (!keyId || !keySecret) {
    throw new Error('HF_API_KEY_ID e HF_API_KEY_SECRET precisam estar definidos no ambiente do servidor.');
  }
  const origin = new URL(baseUrl).origin;
  const authorization = `Key ${keyId}:${keySecret}`;

  function toUrl(pathOrUrl) {
    const url = /^https?:\/\//i.test(pathOrUrl) ? new URL(pathOrUrl) : new URL(`${baseUrl}${pathOrUrl}`);
    // As credenciais só podem ir para a própria API: nunca seguir URLs de outro host.
    if (url.origin !== origin) {
      throw new HiggsfieldError(`URL fora da API configurada recusada: ${url.origin}`, { kind: 'validation' });
    }
    return url;
  }

  async function send(method, url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        throw new HiggsfieldError(`${method} ${url.pathname}: HTTP ${res.status}`, {
          kind: classifyStatus(res.status),
          status: res.status,
          body: data,
        });
      }
      return data;
    } catch (err) {
      if (err instanceof HiggsfieldError) throw err;
      const kind = err?.name === 'AbortError' ? 'timeout' : 'network';
      throw new HiggsfieldError(`${method} ${url.pathname}: ${kind}`, { kind, cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  async function get(pathOrUrl) {
    const url = toUrl(pathOrUrl);
    for (let attempt = 0; ; attempt++) {
      try {
        return await send('GET', url);
      } catch (err) {
        if (!(err instanceof HiggsfieldError) || !err.transient || attempt >= retry.maxRetries) throw err;
        const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
        await sleep(backoff / 2 + Math.random() * (backoff / 2));
      }
    }
  }

  async function post(path, body) {
    const url = toUrl(path);
    try {
      return await send('POST', url, body);
    } catch (err) {
      // Sem retry: timeout/rede/5xx deixam o resultado desconhecido.
      if (err instanceof HiggsfieldError && err.transient) err.ambiguous = true;
      throw err;
    }
  }

  return { get, post, baseUrl, origin };
}
