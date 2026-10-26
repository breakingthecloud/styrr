# Styrr Changelog

> Historial público de releases de [`@carloscortezcloud/styrr-llm`](https://www.npmjs.com/package/@carloscortezcloud/styrr-llm) · [`@carloscortezcloud/styrr-strands`](https://www.npmjs.com/package/@carloscortezcloud/styrr-strands) · `styrr` (PyPI) — 1 entrada por versión.
> Repos: https://github.com/breakingthecloud/styrr + https://github.com/breakingthecloud/styrr-py · Guías: `GUIDE-*.md`

Última actualización: **2026-10-26** · `v0.1.0` → `v0.7.0` (+ `styrr-strands@0.1.0`/`0.1.1` + `styrr` PyPI `0.1.0`) · Verificado `git tag` + `npm view` + `PyPI`.

---

## Overview

| Versión | Git tag | Fecha (git) | Fecha (npm) | Resumen |
|---------|---------|-------------|-------------|---------|
| **0.7.0** | `v0.7.0` | 2026-10-26 | pendiente (npm auth) | OpenCode Go + multi-provider keys/headers + catalog ranking |
| **0.6.0** | `v0.6.0` | 2026-08-08 | 2026-08-08 14:12 UTC | Sanitización tool_call + quality routing + demotion |
| **0.5.0** | `v0.5.0` | 2026-08-02 | 2026-08-02 21:38 UTC | Bedrock AgentCore cross-provider fallback |
| **0.4.0** | `v0.4.0` | 2026-07-28 | 2026-07-29 01:25 UTC | Streaming `router.stream()` + SSE + Bedrock streaming |
| **0.3.1** | `v0.3.1` | 2026-07-28 | 2026-07-29 01:09 UTC | Provider adapters fix |
| **0.3.0** | `v0.3.0` | 2026-07-28 | 2026-07-29 00:36 UTC | Provider adapters + auto-detection |
| **0.2.0** | `v0.2.0` | 2026-07-24 | 2026-07-24 22:03 UTC | Cost estimation + routing `cheapest/fastest/quality` |
| **0.1.2** | `v0.1.2` | 2026-07-22 | 2026-07-22 23:44 UTC | Normalize camelCase → snake_case |
| **0.1.1** | `v0.1.1` | 2026-07-22 | 2026-07-22 23:36 UTC | Fix ESM `type: module` (retroactivo) |
| **0.1.0** | `v0.1.0` | 2026-07-22 | 2026-07-22 23:29 UTC | Initial: 246 líneas, zero deps, fallback chain |
| **strands 0.1.0** | `styrr-strands@0.1.0` | 2026-07-28 | 2026-07-29 01:41 UTC | Strands adapter `StyrModelProvider` |
| **strands 0.1.1** | `styrr-strands@0.1.1` | 2026-08-02 | 2026-08-02 21:40 UTC | Bump `styrr-llm` `^0.5.0` (retroactivo) |
| **py 0.1.0** | `v0.1.0` (py) | 2026-07-29 | 2026-07-29 (PyPI) | Python `styrr 0.1.0` · `httpx` + `boto3` |

> Notas: `v0.1.1`, `v0.5.0`, `styrr-strands@0.1.1` retroactivos 2026-08-25.

---

## v0.7.0 — 2026-10-26 — OpenCode Go + multi-provider + catalog ranking

**Tag:** `v0.7.0` · **npm:** pendiente (token 401/404 al publicar) · **Tarball:** 24 files, 84,343 unpacked

**SoW-MNG-010 — relacionado (cambios aditivos, sin breaking changes):**
- Provider de primera clase `opencode-go` (`https://opencode.ai/inference/go/openai/v1`).
- `StyrConfig.apiKeys` y `providers` por provider: un router puede mezclar OpenRouter + OpenCode Go con distintas keys y base URLs.
- `StyrModel.headers` + `providers[].headers`. OpenCode Go requiere `x-opencode-session`; Styrr lo genera automáticamente y agrega `User-Agent: cc-mng/0.1.0` (el edge bloquea algunos UA por defecto).
- Demotion y `fallback` ahora usan la clave canónica `provider:id` (los IDs colisionan entre providers, ej. `minimax-m3`).
- Nuevo `src/catalog.ts`: `rankCatalog(models, rules)`, `toStyrModels(models)`, `buildModelChain(ranked, { pinned, limit })`, `catalogKey()`, `blendedCostPer1M()`.
- `strategy: 'fallback'` preserva el orden recibido (el caller ya rankeó); otras estrategias siguen ordenando por pricing.
- 55 tests green (19 sanitize + 8 discovery + 13 router + 8 catalog + 7 strands).

```ts
const router = new StyrRouter({
  apiKeys: {
    openrouter: process.env.OPENROUTER_API_KEY!,
    'opencode-go': process.env.OPENCODE_API_KEY!,
  },
  models: [
    { id: 'glm-5.3', provider: 'opencode-go' },
    { id: 'meta-llama/llama-3.3-70b-instruct', provider: 'openrouter' },
  ],
});
```

> Nota: los IDs de OpenCode Go son bare y colisionan con OpenRouter (`minimax-m3`), por eso `provider` es obligatorio para ese provider y la clave canónica es `provider:id`.

Ver `GUIDE-provider-adapters.md`.

---

## v0.6.0 — 2026-08-08 — Sanitización + Quality routing + Demotion

**Tag:** `v0.6.0` @ `880c95f` · **npm:** `0.6.0` @ 2026-08-08T14:12:58.242Z · **Tarball:** 22 files, 71,545 unpacked

**SoW-OSS-003 — Sanitización:**
- `src/sanitize.ts` — `safeArguments()`, `sanitizeToolCall()`, `toWireToolCall()` garantiza `tool_calls[].function.arguments` siempre es JSON válido
- `400` por `arguments` malformado → 1 retry sanitizado + fallback al siguiente modelo ( `401` y `400` genérico siguen fatales)
- Fix double-encoding en `openai-compat` provider

**SoW-OSS-004 — Quality + Demotion:**
- `recommendToolsFirst()` + quality ranking (`gemma-4-31b-it` antes que `nemotron` flaky)
- `selectByStrategy()` + `fitsContext()` con `strategy` en `config/call/stream`
- Demotion in-memory: `2×` consecutivos `429/404/5xx` → modelo al final de rotación por `demotionPenaltyMs` (30s default)
- 47 tests green (19 sanitize + 8 discovery + 13 router + 7 existing)

```ts
const router = new StyrRouter({
  apiKey, models: [{ id: 'nvidia/nemotron-3-ultra-550b:free' }, { id: 'google/gemma-4-31b-it:free' }],
  strategy: 'quality', demotionPenaltyMs: 30_000,
});
// 400 por JSON roto → retry sanitizado → fallback, no fatal
```

Ver `GUIDE-tool-call-robustness.md` + `GUIDE-free-model-routing.md`.

---

## v0.5.0 — 2026-08-02 — Bedrock AgentCore cross-provider fallback

**Tag:** `v0.5.0` @ `0b3aab0` · **npm:** `0.5.0` @ 2026-08-02T21:38:41.658Z · **Tarball:** 20 files, 55,806 unpacked

- Patrón `Bedrock AgentCore → OpenRouter` — doc + ejemplo `examples/agentcore-fallback/`
- Si AgentCore da `429/5xx`, Styrr fallback a `openai/gpt-4o-mini` sin lógica extra

```ts
const router = new StyrRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
  models: [
    { id: 'bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0' },
    { id: 'openai/gpt-4o-mini' },
  ],
});
```

> Nota: tag faltaba en remote hasta 2026-08-25 — pusheado retroactivamente.

---

## v0.4.0 — 2026-07-28 — Streaming `router.stream()` + SSE

**Tag:** `v0.4.0` @ `c54424b` · **npm:** `0.4.0` @ 2026-07-29T01:25:16.982Z · **Tarball:** 20 files, 55,108 unpacked

- `router.stream(messages, tools?) → AsyncGenerator<StyrStreamEvent>` — `text_delta`, `tool_call_start/done`, `done`, `error`
- `OpenAICompatProvider`: SSE via `fetch` + `body reader` + `parseSSEStream()` reusable
- `BedrockProvider`: `ConverseStreamCommand` con tool_call streaming
- `HuggingFaceProvider`: wrap `call` como single delta
- Fallback chain también durante streaming + `examples/stream-cli/` local SSE server

```ts
for await (const evt of router.stream([{ role: 'user', content: 'Hi' }], tools)) {
  if (evt.type === 'text_delta') process.stdout.write(evt.delta);
  if (evt.type === 'tool_call_done') console.log(evt.tool);
}
```

---

## v0.3.1 — 2026-07-28 — Provider adapters fix

**Tag:** `v0.3.1` @ `901ea8d` · **npm:** `0.3.1` @ 2026-07-29T01:09:39.467Z · **Tarball:** 18 files, 39,277 unpacked

- Fix mapeo `tool_calls` en Bedrock/HF adapters
- Ejemplos y `GUIDE-provider-adapters.md` pulidos

> Fusionable con 0.3.0 como “Provider adapters done right” si quieres 8 posts en vez de 9.

---

## v0.3.0 — 2026-07-28 — Provider adapters + auto-detection

**Tag:** `v0.3.0` @ `906e314` · **npm:** `0.3.0` @ 2026-07-29T00:36:24.479Z · **Tarball:** 16 files, 35,383 unpacked

- `feat(styrr-002): provider adapter system` — `OpenAICompat`, `Bedrock`, `HuggingFace` con auto-detection por `model id`
- `GUIDE-provider-adapters.md` con ejemplos paso a paso

```ts
// auto-detect por id: bedrock/ → Bedrock, hf: → HF, resto → OpenAICompat
const router = new StyrRouter({ apiKey, models: [
  { id: 'bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0' },
  { id: 'openai/gpt-4o-mini' },
]});
```

---

## v0.2.0 — 2026-07-24 — Cost estimation + Routing strategies

**Tag:** `v0.2.0` @ `87d7316` · **npm:** `0.2.0` @ 2026-07-24T22:03:20.680Z · **Tarball:** 6 files, 24,112 unpacked

- `src/pricing.ts` — `MODEL_PRICING` DB (16 modelos), `estimateCost()`, `selectByStrategy()`, `findPricing()`, `fitsContext()`
- Estrategias: `cheapest` ( $/token ), `fastest` (latency), `quality` (score), `fallback` (orden original)
- `~4 chars/token` approx + re-export desde `main index`, zero deps

```ts
import { selectByStrategy, estimateCost } from '@carloscortezcloud/styrr-llm';
const cheapest = selectByStrategy('cheapest', models, { maxTokens: 4000 });
console.log(estimateCost('meta-llama/llama-3.3-70b:free', 1200));
```

---

## v0.1.2 — 2026-07-22 — Normalize camelCase → snake_case

**Tag:** `v0.1.2` @ `e266812` · **npm:** `0.1.2` @ 2026-07-22T23:44:31.687Z · **Tarball:** 4 files, 15,279 unpacked

- `fix: normalize messages — camelCase toolCallId → snake_case` antes de enviar a OpenRouter/OpenAI
- Compat con `Tinkuy Message` type (`toolCallId` interno → `tool_call_id` API)

---

## v0.1.1 — 2026-07-22 — ESM fix (retroactivo)

**Tag:** `v0.1.1` @ `3e1e973` → `efe8349` · **npm:** `0.1.1` @ 2026-07-22T23:36:15.555Z · **Tarball:** 4 files, 14,262 unpacked

- `package.json: "type": "module"` — mismo fix que Tinkuy/Sayay

> Tag retroactivo 2026-08-25 — npm se publicó sin tag (gitHead `efe8349` = v0.1.0).

---

## v0.1.0 — 2026-07-22 — Initial

**Tag:** `v0.1.0` @ `efe8349` (commit `c141e58` feat) · **npm:** `0.1.0` @ 2026-07-22T23:29:17.228Z · **Tarball:** 4 files, 14,242 unpacked

- `src/index.ts` 246 líneas — `StyrRouter({ apiKey, models })` con fallback chain `try A → on 429/404/402 try B → C`, zero deps, CF Workers compatible

```ts
const router = new StyrRouter({ apiKey: process.env.OPENROUTER_API_KEY!, models: [{ id: 'anthropic/claude-3.5-sonnet' }, { id: 'meta-llama/llama-3.3-70b:free' }] });
await router.call([{ role: 'user', content: 'Hello' }]);
```

---

## Extra: styrr-strands@0.1.0 — 2026-07-28 — Strands adapter

**Tag:** `styrr-strands@0.1.0` @ `e07c642` · **npm:** `0.1.0` @ 2026-07-29T01:41:03.644Z

- `StyrModelProvider extends Model<T>` de `@strands-agents/sdk` — `stream()` mapeado a `ModelStreamEvent`, `mappers.ts`, fallback chain

---

## Extra: styrr-strands@0.1.1 — 2026-08-02 — Bump

**Tag:** `styrr-strands@0.1.1` @ `552bfa3` · **npm:** `0.1.1` @ 2026-08-02T21:40:57.026Z

- Bump `styrr-llm` dep `^0.5.0` — retroactivo 2026-08-25 (npm sin tag)

---

## Extra: styrr 0.1.0 (PyPI) — Python SDK

**Tag:** `v0.1.0` (styrr-py) @ `d8d1ffe` · **PyPI:** `styrr 0.1.0` @ 2026-07-29

- `styrr` (PyPI) — `pip install styrr` — `StyrRouter` Python con `httpx`, extras `styrr[bedrock]` (`boto3`), `styrr[huggingface]`

```python
from styrr import StyrRouter
router = StyrRouter(models=[{"id": "meta-llama/llama-3.3-70b:free"}])
```

---

## Verificación

```bash
git tag --list | sort -V
npm view @carloscortezcloud/styrr-llm versions --json
npm view @carloscortezcloud/styrr-llm@0.6.0 --json | jq '{version, fileCount: .dist.fileCount}'
```

