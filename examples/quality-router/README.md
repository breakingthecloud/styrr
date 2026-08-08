# Styrr — Quality Free-Model Router (v0.6.0)

A CF Worker that stops getting "stuck on a dead model" — the exact prod bug
where the router kept landing on `nvidia/nemotron-3-ultra-550b-a55b:free`
(OpenRouter `502 Failed to apply prompt template`).

## What it does

```
cron 03:00  →  discoverFreeModels()   free + tools + context ≥ 8K
              └→ recommendToolsFirst() ranked quality-first   (gemma > nemotron)
              └→ { ranked: string[] }  →  KV MODEL_RANKING  (TTL 48h)

POST /chat   →  StyrRouter(strategy:'quality')
                └ (502/429 anywhere in the chain) →
                     demoted in-memory 30s → back to position after TTL
```

## The two checks that matter

1. **Precheck** — only models that *support tools* and fit `context ≥ 8K` are
   candidates. This lives in `discoverFreeModels` (this package) and the app
   just consumes the result + caches it. **Never** re-derive it in the app.
2. **Ranking** — `recommendToolsFirst(ids | DiscoveredModel[], opts)` sorts the
   tool-capable set by `qualityScore` desc (unknown models last), tie-break by
   `avgLatencyMs` asc. Free nvidia models were score-demoted because they are
   flaky in prod.

## Why `strategy:'quality' + demotion` matters

- `strategy:'quality'` makes the router *start* from the best model, not
  `models[0]` blindly.
- After 2 consecutive `429|404|≥500` from a model, styrr moves it to the end of
  the rotation for `demotionPenaltyMs` (default 30s) — it still works as a last-
  resort fallback, and returns to position after the TTL. All in-memory; no KV
  needed for the demotion state (accept it resets on worker restart).

## Setup & deploy

```bash
cd examples/quality-router
pnpm install
pnpm create:kv                      # prints a namespace id → paste into wrangler.toml
OPENROUTER_API_KEY=sk-or-... pnpm run dev
pnpm run deploy
```

## Interact

```bash
curl -X POST http://localhost:8787/chat -H 'Content-Type: application/json' \
  -d '{"message":"necesito el clima de Lima"}'
curl http://localhost:8787/models
```

## Learn more

- `GUIDE-free-model-routing.md` — the full precheck + ranking + strategy reference
- `examples/tool-loop/` — the tool-calling loop that consumes these models