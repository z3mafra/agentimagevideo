// Configuração lida exclusivamente de variáveis de ambiente do servidor.
// As credenciais nunca são expostas em respostas HTTP nem enviadas ao browser.

export function loadConfig(env = process.env) {
  return {
    baseUrl: (env.HF_API_BASE_URL || 'https://api.higgsfield.ai').replace(/\/+$/, ''),
    keyId: env.HF_API_KEY_ID || '',
    keySecret: env.HF_API_KEY_SECRET || '',
    port: Number(env.PORT || 3000),
    pollTimeoutMs: Number(env.POLL_TIMEOUT_MS || 10 * 60 * 1000),
  };
}
