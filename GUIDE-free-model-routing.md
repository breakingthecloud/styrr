# Free-Model Routing — Styrr v0.6.0 Guide

How to build a router that **never gets stuck on a dead free model**, and why
the pre-check + quality ranking live in styrr (not in your app). This is the
distilled learning from the prod incident where the router kept landing on
`nvidia/nemotron-3-ultra-550b-a55b:free` → `502 Failed to apply prompt template`.

---

## 1. The bug it fixes

- The router chose `models[0]` blindly.
- The KV cache had a dead model first (nemotron) → every request retried slowly
  or fell to a *worse* model.
- `selectByStrategy` / `fitsContext` existed but nobody called them.

**Fix:** styrr exposes a canonical pre-check that returns *tool-capable free
models ranked by quality*, and a router strategy that rotates away from dead
models automatically. Your app just consumes the ranked list + caches it.

---

## 2. The pre-check pipeline

```
OpenRouter /models
   └→ discoverFreeModels({ requireToolSupport, minContextLength, maxResults })
        filters: price==0  AND  supportsTools  AND  context ≥ 8K
   └→ recommendToolsFirst(ids | DiscoveredModel[], { minContext, maxResults })
        toolCapable  →  sorted by qualityScore desc (unknown last)
                        tie-break avgLatencyMs asc
   └→ { models, toolCapable, ranked }   ← app caches `ranked` in KV
```

`recommendToolsFirst` accepts:
- `string[]` (plain model ids) — quality comes from the embedded pricing table,
  context from `findPricing().contextWindow`.
- `DiscoveredModel[]` (from `discoverFreeModels`) — `supportsTools` flag and
  `contextLength` are authoritative.

```ts
import { discoverFreeModels, recommendToolsFirst } from '@carloscortezcloud/styrr-llm';

const discover = await discoverFreeModels({ minContextLength: 8192, requireToolSupport: true });
const { ranked } = recommendToolsFirst(discover.models, { minContext: 8192 });
// ranked: ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-4-31b-it:free', ...]
//          nvidia free models are score-demoted (flaky in prod) → ranked last
await kv.put('free_models', JSON.stringify(ranked), { expirationTtl: 172800 });
```

> Why nvidia free models rank last: the embedded `qualityScore` was lowered
> after observing repeated `502` prompt-template failures. `quality` strategy
> then picks gemma/llama first automatically.

---

## 3. Router strategy + demotion

```ts
const router = new StyrRouter({
  apiKey: env.OPENROUTER_API_KEY,
  models: ranked.map(id => ({ id })),
  strategy: 'quality',          // config-level default ('fallback' = config order)
  demotionPenaltyMs: 30000,     // how long a dead model stays at the end
  onFallback: (failed, err, next) => console.warn(`${failed} → ${next}: ${err}`),
});

// Per-call override:
await router.call(messages, { strategy: 'quality' });
```

| strategy | ordering |
|----------|----------|
| `fallback` | config order (default, backward-compatible) |
| `quality` | `qualityScore` desc (unknown last) |
| `fastest` | `avgLatencyMs` asc |
| `cheapest` | estimated cost asc |

### Demotion (in-memory, automatic)

- After **2 consecutive** `429 | 404 | ≥500` (incl. 502) from a model, it is moved
  to the **end** of the rotation for `demotionPenaltyMs` (default 30s).
- It still works as a last-resort fallback during the penalty window.
- After the TTL it returns to its position.
- `reportSuccess()` is called automatically on a successful call → resets the
  counter.
- `reportFailure(id, reason)` / `reportSuccess(id)` are also public if you want
  to feed signals from your own code.
- **No KV needed** — the demotion state dies on worker restart, which is fine
  for short-lived penalties.

---

## 4. Do / Don't

- ✅ Refresh the *ranking* once/day (cron) into KV; read from KV per request.
- ✅ Let styrr own the filter + ranking; the app only caches the result.
- ✅ Use `strategy:'quality'` for tool-heavy chats (VelaroChat default).
- ❌ Re-implement the tool/context filter in the app.
- ❌ Hard-code a "best free model" — discovery is a moving target.
- ❌ Persist demotion state — in-memory is intentional.

## Related

- `examples/quality-router/` — runnable CF Worker with cron + KV + strategy
- `examples/free-model-cron/` — original discovery-only version (pre-v0.6)
- `GUIDE-tool-call-robustness.md` — the tool loop that consumes these models