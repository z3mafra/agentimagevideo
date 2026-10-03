// Configuração lida exclusivamente de variáveis de ambiente do servidor.
// As credenciais nunca são expostas em respostas HTTP nem enviadas ao browser.

import { fileURLToPath } from 'node:url';

const DEFAULT_DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));

export function loadConfig(env = process.env) {
  return {
    baseUrl: (env.HF_API_BASE_URL || 'https://api.higgsfield.ai').replace(/\/+$/, ''),
    keyId: env.HF_API_KEY_ID || '',
    keySecret: env.HF_API_KEY_SECRET || '',
    port: Number(env.PORT || 3000),
    // Histórico (history.json) e cópias das mídias geradas.
    dataDir: env.DATA_DIR || DEFAULT_DATA_DIR,
  };
}
