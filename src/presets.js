// Registro de presets.
//
// Cada preset = { name, model, mediaType, endpoint, bodyBase, fields }.
// - endpoint: path confirmado na Higgsfield API.
// - bodyBase: campos fixos do preset (só são substituídos se o usuário os enviar).
// - fields: únicos campos que o usuário pode enviar (os documentados para o endpoint).
// - outputUrl: onde fica a mídia no payload de status `completed`.
//
// Adicionar um preset = adicionar uma entrada aqui.

export const PRESETS = {
  'corte-para-reels': {
    name: 'Corte para Reels',
    model: 'Kling 2.5 Turbo (image-to-video standard)',
    mediaType: 'video',
    endpoint: '/kling-video/v2.5-turbo/standard/image-to-video',
    bodyBase: {},
    fields: {
      prompt: { type: 'string', required: true },
      image_url: { type: 'string', required: true },
    },
    outputUrl: (result) => result?.video?.url ?? null,
  },

  'imagem-de-produto': {
    name: 'Imagem de produto',
    model: 'Marketing Studio Image (2.5 Flare)',
    mediaType: 'image',
    endpoint: '/marketing-studio/image/flare',
    bodyBase: { resolution: '2k', aspect_ratio: '1:1', quality: 'high', enhance_prompt: false },
    fields: {
      prompt: { type: 'string', required: true },
      resolution: { type: 'string' },
      aspect_ratio: { type: 'string' },
      quality: { type: 'string' },
      enhance_prompt: { type: 'boolean' },
      preset_id: { type: 'string' },
      image_urls: { type: 'array', minItems: 1, maxItems: 2 },
    },
    // Preset de marca (GET /marketing-studio/image/presets → preset_id):
    // exige 1–2 image_urls (produto + referência opcional) e enhance_prompt=true.
    finalize(body, inputs) {
      if (body.preset_id === undefined) return;
      if (!Array.isArray(body.image_urls) || body.image_urls.length === 0) {
        return 'Com "preset_id" é preciso enviar "image_urls" com 1–2 URLs (produto + referência opcional).';
      }
      if (inputs.enhance_prompt === undefined) body.enhance_prompt = true;
    },
    catalogEndpoint: '/marketing-studio/image/presets',
    outputUrl: (result) => result?.images?.[0]?.url ?? null,
  },

  'b-roll-de-tela': {
    name: 'B-roll de tela',
    model: 'MiniMax Hailuo 2.3 (standard text-to-video)',
    mediaType: 'video',
    endpoint: '/minimax/hailuo-2.3/standard/text-to-video',
    bodyBase: {},
    fields: {
      prompt: { type: 'string', required: true },
    },
    outputUrl: (result) => result?.video?.url ?? null,
  },
};

export function slugify(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function resolvePreset(nameOrSlug, presets = PRESETS) {
  const slug = slugify(nameOrSlug);
  const entry = Object.entries(presets).find(([key, p]) => key === slug || slugify(p.name) === slug);
  return entry ? { key: entry[0], ...entry[1] } : null;
}

export function listPresets(presets = PRESETS) {
  return Object.entries(presets).map(([key, p]) => ({
    key,
    name: p.name,
    model: p.model,
    mediaType: p.mediaType,
    endpoint: p.endpoint,
    bodyBase: p.bodyBase,
    fields: Object.keys(p.fields),
    requiresImage: !!p.fields.image_url?.required,
  }));
}
