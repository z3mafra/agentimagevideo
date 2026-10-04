# agentimagevideo — gerador de imagens e vídeos (Higgsfield API)

Aplicação web simples: você escolhe um preset, escreve o texto (prompt), clica
em **Gerar** e vê o resultado na própria página. O navegador fala só com este
servidor; a chave da Higgsfield fica no servidor e nunca vai para o browser.

## Como rodar no seu computador

1. Instale o **Node.js LTS** (versão 20.6 ou mais nova) em https://nodejs.org.
2. Baixe o projeto (GitHub → **Code** → **Download ZIP**) e descompacte.
3. Na pasta do projeto, crie um arquivo chamado `.env` com:
   ```
   HF_API_KEY_ID=seu_id_aqui
   HF_API_KEY_SECRET=seu_segredo_aqui
   ```
4. Abra um terminal na pasta e rode:
   ```
   npm start
   ```
5. Abra **http://localhost:3000** no navegador.

Cada geração consome créditos da sua conta Higgsfield. `npm test` roda os
testes automáticos (não chamam a API real).

## Presets

| Preset | Mídia | Endpoint Higgsfield | Corpo enviado |
|---|---|---|---|
| Corte para Reels | vídeo | `POST /kling-video/v2.5-turbo/standard/image-to-video` | `{ prompt, image_url }` |
| Imagem de produto | imagem | `POST /marketing-studio/image/flare` | `{ prompt, resolution: "2k", aspect_ratio: "1:1", quality: "high", enhance_prompt: false }` |
| B-roll de tela | vídeo | `POST /minimax/hailuo-2.3/standard/text-to-video` | `{ prompt }` |

O prompt é obrigatório. A URL de imagem só aparece (e só é obrigatória) no
Corte para Reels. Presets ficam em `src/presets.js`; adicionar um é adicionar
uma entrada lá.

### Opções e presets de marca (Imagem de produto)

- **Opções**: proporção, resolução, qualidade e "melhorar o texto" aparecem
  como seletores. "Padrão" não envia o campo e vale o valor do preset. As
  opções vêm do campo `options` de cada preset em `src/presets.js`; os valores
  listados são sugestões, e quem valida é a Higgsfield (recusa aparece na tela).
- **Preset de marca**: o botão **Carregar presets** busca o catálogo
  (`GET /marketing-studio/image/presets`). Ao escolher um, a interface pede a
  URL da foto do produto (obrigatória) e uma de referência (opcional), e envia
  `preset_id` + `image_urls`; "melhorar o texto" passa a ser Sim por padrão.

## Rotas do backend

| Método | Rota | O quê |
|---|---|---|
| GET | `/` | Interface web |
| POST | `/api/presets/:name/generate` | Recebe `{ prompt, image_url? }`, dispara o POST do preset e retorna `{ request_id }` |
| GET | `/api/presets/status/:request_id` | Repassa `GET /requests/{request_id}/status` |
| GET | `/api/presets` | Lista os presets (usada pela interface para montar as abas) |
| GET | `/api/presets/:name/catalog` | Catálogo de presets de marca do Marketing Studio (usado pela interface) |
| GET | `/api/history` | Gerações anteriores, mais recentes primeiro |
| DELETE | `/api/history/:request_id` | Apaga o registro e a cópia local |
| GET | `/media/:arquivo` | Cópia local da mídia (com suporte a Range para vídeo) |

## Fluxo assíncrono e erros

- O POST de geração é feito **uma única vez**. Se der timeout, erro de rede ou
  5xx, a interface avisa que o pedido pode ter chegado e **não reenvia**.
- A interface consulta o status a cada 2 s (subindo até 10 s) até `completed`,
  `failed`, `nsfw` ou `canceled`, e mostra cada caso claramente, sem tentar de
  novo sozinha.
- Backoff exponencial limitado só para rede/5xx, tanto no servidor (consulta
  à Higgsfield) quanto no navegador (consulta ao servidor). 401/403/400/422
  param na hora. As respostas de erro do servidor trazem `retryable` para a
  interface saber se deve continuar.
- Se a consulta demorar demais ou o servidor ficar fora do ar, a interface
  mostra o `request_id` e um botão **Continuar consultando** — que só consulta
  o status, nunca reenvia a geração.

## Histórico e cópias locais

- Cada geração enviada vira um item no **Histórico** (abaixo do formulário), com
  preset, texto, data e status. Ele continua lá depois de recarregar a página.
- Quando a geração fica pronta, o servidor **baixa a mídia** para
  `data/media/<request_id>.<ext>`, porque os links da Higgsfield podem expirar.
  O registro fica em `data/history.json`. A pasta pode ser trocada com
  `DATA_DIR` no `.env` e não vai para o Git.
- Em cada item: **Baixar**, **Abrir**, **Reusar texto**, **Excluir** (apaga o
  registro e o arquivo) e, para pedidos ainda em andamento, **Continuar
  consultando** (só consulta, nunca reenvia). Imagens prontas têm **Animar em
  vídeo**, que abre o Corte para Reels com a imagem como primeiro quadro.
- Se a cópia falhar, o item mostra o link original da Higgsfield e avisa que
  ele pode expirar.
- Ao hospedar o app, use um disco persistente para `DATA_DIR`; em hospedagens
  com disco temporário o histórico se perde a cada reinício.
