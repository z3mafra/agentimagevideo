# agentimagevideo — presets sobre a Higgsfield API

Um preset é `{ name, model, mediaType, endpoint, promptBase, bodyBase, fields }`
(`src/presets.js`). A função `generatePreset(presetName, inputs)` resolve o
preset, faz o merge dos inputs sobre o `bodyBase`, submete a geração **uma
única vez** e faz polling do `status_url` até um status terminal.

## Rodando

```bash
cp .env.example .env   # preencha HF_API_KEY_ID / HF_API_KEY_SECRET
set -a; . ./.env; set +a
npm start              # http://localhost:3000
npm test
```

Node ≥ 18.17, sem dependências. As credenciais só existem no servidor; o header
enviado é `Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}` e nunca vai
para um host diferente de `HF_API_BASE_URL`.

## Presets

| Preset (`:name`) | Modelo | Mídia | Endpoint | bodyBase | Campos aceitos |
|---|---|---|---|---|---|
| `corte-para-reels` | Kling 2.5 Turbo | vídeo | `POST /kling-video/v2.5-turbo/standard/image-to-video` | — | `prompt`, `image_url` (obrigatório) |
| `imagem-de-produto` | Marketing Studio Image (2.5 Flare) | imagem | `POST /marketing-studio/image/flare` | `resolution: "2k"`, `aspect_ratio: "1:1"`, `quality: "high"`, `enhance_prompt: false` | `prompt`, `resolution`, `aspect_ratio`, `quality`, `enhance_prompt`, `preset_id`, `image_urls` |
| `b-roll-de-tela` | MiniMax H3 | vídeo | `POST /minimax/h3/text-to-video` | — | `prompt` |

- **Prompt**: o prompt final é o `promptBase` do preset seguido do `prompt` do
  usuário (se enviado).
- **Merge**: campos enviados pelo usuário substituem os do `bodyBase`; campos não
  enviados mantêm o valor do preset.
- **Campos fora da lista** retornam 400 sem chamar a API.
- **Preset de marca** (Imagem de produto): pegue um `preset_id` em
  `GET /api/presets/imagem-de-produto/catalog` (→ `GET /marketing-studio/image/presets`)
  e envie `preset_id` + `image_urls` com 1–2 URLs (produto + referência
  opcional). Nesse modo `enhance_prompt` passa a `true`, a menos que você o envie.
- **Saída**: `outputUrl` vem de `video.url` (vídeos) ou `images[0].url` (imagem)
  no payload `completed`; o payload completo fica em `result`.

Adicionar um preset = uma nova entrada em `PRESETS`.

## Endpoints da aplicação

| Método | Rota | O quê |
|---|---|---|
| GET | `/api/presets` | Lista os presets |
| POST | `/api/presets/:name/generate` | Gera e espera o resultado. `?wait=false` só submete e devolve 202 |
| GET | `/api/presets/:name/catalog` | Presets de marca do Marketing Studio (`preset_id`) |
| GET | `/api/requests/:requestId/status` | Re-consulta o status (`?wait=true` continua o polling) |

```bash
curl -X POST localhost:3000/api/presets/corte-para-reels/generate \
  -H 'content-type: application/json' \
  -d '{"prompt":"A slow cinematic tracking shot along a sunlit coastal road.","image_url":"https://example.com/first-frame.jpg"}'

curl localhost:3000/api/presets/imagem-de-produto/catalog
curl -X POST localhost:3000/api/presets/imagem-de-produto/generate \
  -H 'content-type: application/json' \
  -d '{"prompt":"garrafa de perfume","preset_id":"<id>","image_urls":["https://example.com/produto.png"]}'

curl -X POST 'localhost:3000/api/presets/b-roll-de-tela/generate?wait=false' \
  -H 'content-type: application/json' -d '{"prompt":"dashboard de analytics"}'
```

## Fluxo assíncrono e erros

- A submissão retorna `request_id` e `status_url`; o polling usa o `status_url`
  (ou `/requests/{id}/status` se o `status_url` apontar para outro host, para
  não vazar credenciais). Intervalo de 2 s crescendo até 10 s.
- Terminal: `completed`, `failed`, `nsfw`, `canceled`.
- **O POST nunca é repetido.** Timeout, erro de rede ou 5xx na submissão viram
  502 com a indicação de que a geração pode ter sido aceita.
- GETs (status, catálogo) usam backoff exponencial limitado (até 5 novas
  tentativas, teto 30 s) só para rede/timeout/5xx. 401/403 → 502 "credenciais
  rejeitadas"; 400/422 e outros 4xx → 422 com a resposta da Higgsfield; nada
  disso é repetido.
- Se o polling passar de `POLL_TIMEOUT_MS`, a rota devolve 202 com `request_id`
  e o link de status; nada é re-submetido.
