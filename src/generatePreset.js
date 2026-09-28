// generatePreset(presetName, inputs): resolve preset → monta o request
// (endpoint + bodyBase + inputs) → submete uma única vez → polling do status_url.

import { HiggsfieldError } from './higgsfieldClient.js';
import { resolvePreset } from './presets.js';

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'nsfw', 'canceled']);

export class PresetInputError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PresetInputError';
    this.details = details;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function checkType(field, spec, value) {
  if (spec.type === 'array') {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return `${field}: esperado array de strings`;
    if (spec.minItems !== undefined && value.length < spec.minItems) return `${field}: mínimo de ${spec.minItems} item(ns)`;
    if (spec.maxItems !== undefined && value.length > spec.maxItems) return `${field}: máximo de ${spec.maxItems} item(ns)`;
    return null;
  }
  return typeof value === spec.type ? null : `${field}: esperado ${spec.type}`;
}

/** Monta { preset, path, body } sem chamar a API. */
export function buildPresetRequest(presetName, inputs) {
  const preset = resolvePreset(presetName);
  if (!preset) throw new PresetInputError(`Preset desconhecido: ${presetName}`);
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new PresetInputError('O corpo deve ser um objeto JSON.');
  }

  const unknown = Object.keys(inputs).filter((k) => !(k in preset.fields));
  if (unknown.length) {
    throw new PresetInputError('Campos não documentados para este preset.', { unknown, accepted: Object.keys(preset.fields) });
  }
  const errors = Object.entries(inputs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => checkType(k, preset.fields[k], v))
    .filter(Boolean);
  if (errors.length) throw new PresetInputError('Entradas inválidas.', { errors });

  // Merge: inputs fornecidos sobre o bodyBase; campos não fornecidos mantêm o valor do preset.
  const body = { ...preset.bodyBase };
  for (const [k, v] of Object.entries(inputs)) if (v !== undefined) body[k] = typeof v === 'string' ? v.trim() : v;

  const missing = Object.entries(preset.fields)
    .filter(([k, spec]) => spec.required && (body[k] === undefined || body[k] === ''))
    .map(([k]) => k);
  if (missing.length) throw new PresetInputError('Campos obrigatórios ausentes.', { missing });

  const finalizeError = preset.finalize?.(body, inputs);
  if (finalizeError) throw new PresetInputError(finalizeError);

  return { preset, path: preset.endpoint, body };
}

// Usa o status_url devolvido pela API; se ele apontar para outro host (as
// credenciais não podem sair da API), cai em /requests/{id}/status.
function statusUrlFor(client, submission) {
  const fallback = `/requests/${encodeURIComponent(submission.request_id)}/status`;
  if (!submission.status_url) return fallback;
  try {
    return new URL(submission.status_url, client.origin).origin === client.origin ? submission.status_url : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Faz polling do status_url até um status terminal ou até `timeoutMs`.
 * Nunca re-submete a geração: no timeout devolve o último status conhecido.
 */
export async function pollStatus(client, submission, {
  timeoutMs = 10 * 60 * 1000,
  initialIntervalMs = 2_000,
  maxIntervalMs = 10_000,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const statusUrl = statusUrlFor(client, submission);
  const deadline = now() + timeoutMs;
  let interval = initialIntervalMs;
  let last = submission;

  while (true) {
    try {
      last = await client.get(statusUrl);
      if (TERMINAL_STATUSES.has(last?.status)) return { ...last, timedOut: false };
    } catch (err) {
      // Auth/validação: não adianta insistir. Transitório (o client já fez backoff): segue até o prazo.
      if (!(err instanceof HiggsfieldError) || !err.transient) throw err;
    }
    if (now() + interval > deadline) {
      return { ...last, request_id: submission.request_id, status_url: submission.status_url, timedOut: true };
    }
    await sleep(interval);
    interval = Math.min(maxIntervalMs, Math.round(interval * 1.5));
  }
}

export async function generatePreset(presetName, inputs, { client, wait = true, poll = {} }) {
  const { preset, path, body } = buildPresetRequest(presetName, inputs);
  const submission = await client.post(path, body);
  if (!submission?.request_id) {
    throw new HiggsfieldError('Resposta de submissão sem request_id.', { kind: 'validation', body: submission });
  }
  const meta = { preset: preset.key, model: preset.model, mediaType: preset.mediaType, endpoint: path };
  if (!wait) return { ...meta, submission, result: null, outputUrl: null };
  const result = await pollStatus(client, submission, poll);
  const outputUrl = result.status === 'completed' ? preset.outputUrl(result) : null;
  return { ...meta, submission, result, outputUrl };
}

/** Passo 1 do preset de marca: GET /marketing-studio/image/presets. */
export async function fetchPresetCatalog(presetName, { client }) {
  const preset = resolvePreset(presetName);
  if (!preset) throw new PresetInputError(`Preset desconhecido: ${presetName}`);
  if (!preset.catalogEndpoint) throw new PresetInputError(`O preset "${preset.name}" não possui catálogo de presets de marca.`);
  return client.get(preset.catalogEndpoint);
}
