# Tool-Call Robustness — Styrr v0.6.0 Guide

Everything you need to ship a long-lived agent loop that calls tools reliably,
even when the model emits garbage `arguments`. This is the distilled learning
from the VelaroChat prod outage (400 `tool_calls[].function.arguments must be a
valid JSON object string`).

---

## 1. The failure modes

| Mode | Symptom | Root cause |
|------|---------|-----------|
| Raw string | `arguments: '{"a":1,'` passed upstream | Model streamed a broken JSON fragment |
| Array / scalar | `arguments: []` | Model returned non-object |
| Missing | `arguments` absent on `function` | Shape mismatch (OpenAI vs tinkuy) |
| Double-encode | String re-`JSON.stringify`'d | Provider normalized an already-normalized value |

OpenRouter (and most providers) reject any of these with a 400.
**Since v0.6.0, styrr normalizes every `arguments` to a valid JSON object
string on the wire — broken → `{}` — and treats the resulting 400 as
recoverable.**

---

## 2. What v0.6.0 guarantees

### `sanitizeArguments(tc)` → plain object, never garbage

Accepts both shapes:

```ts
// tink-style (top-level `.arguments`)
{ id, name, arguments: '{"a":1,' }
// OpenRouter-style (nested in `.function`)
{ id, type:'function', function: { name, arguments: { a:1 } } }
```

Rules:

| input                | result             |
|----------------------|--------------------|
| plain object         | used as-is         |
| valid JSON string    | parsed object      |
| broken JSON string   | `{}`               |
| array / `null` / scalar | `{}`            |
| circular object      | `{}`               |

`sanitizeToolCall(tc)` returns `{ id, name, function:{ name, arguments } }`, and
`toWireToolCall(tc)` returns the OpenAI-compatible wire form with `arguments`
always a string that `JSON.parse`'s to an object. Both are **idempotent** — safe
even if a provider re-normalizes.

### 400 `arguments` is non-fatal (call + stream)

- status `401` → **fatal** (no retry makes sense)
- status `400` + message matches `arguments | valid JSON | validation` →
  - one sanitized retry on the same model (does **not** consume the retry budget)
  - if it still 400s → continue the fallback chain to the next model
- other 400s → unchanged (fatal)

This applies to both `router.call()` and `router.stream()`.

---

## 3. Building the loop (the safe way)

```ts
import { StyrRouter, sanitizeMessages, safeArguments } from '@carloscortezcloud/styrr-llm';

const router = new StyrRouter({
  apiKey,
  strategy: 'quality',                 // SoWOSS-004 — start from the best model
  models: [ { id: 'google/gemma-4-31b-it:free' } ],
  onFallback: (m, err, next) => console.warn(`${m} → ${next}: ${err}`),
});

const messages: any[] = [{ role: 'user', content: 'weather in Lima?' }];

for (let i = 0; i < 4; i++) {
  const result = await router.call(sanitizeMessages(messages), { tools });

  if (!result.toolCalls?.length) {
    console.log('answer:', result.text);
    break;
  }

  // Persist the assistant turn with its tool_calls
  messages.push({
    role: 'assistant',
    content: result.text,
    tool_calls: result.toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: safeArguments(tc.arguments),
    })),
  });

  for (const tc of result.toolCalls) {
    const args = safeArguments(tc.arguments);
    const output = await runTool(tc.name, args);
    messages.push({ role: 'tool', tool_call_id: tc.id, content: output });
  }
}
```

> Note: the loop itself can be in **your app** (tinkuy) or in this package —
> styrr only speaks the request/response protocol. `sanitizeMessages` is a
> defensive idempotent extra; styrr already normalizes at request time.

---

## 4. Streaming with tools

`router.stream(messages, { tools })` emits:

| event | when |
|-------|------|
| `text_delta` | chunk of content |
| `tool_call_start` | tool call begins (arguments not yet complete) |
| `tool_call_done` | tool call complete — `arguments` parsed, may be raw `{}` on failure |
| `done` | stream finished with `modelUsed` + usage |
| `error` | fatal (401 / exhausted / unrecoverable 400) |

Same 400-retry semantics apply inside `stream()`.

---

## 5. Anti-patterns

- ❌ `JSON.stringify(tc.arguments)` blindly — double-encodes an already-string.
- ❌ treating every 400 as fatal — 400 for `arguments`/`validation` is recoverable.
- ❌ re-deriving tool filters in the app — `discoverFreeModels`/`recommendToolsFirst`
  live in styrr, the app just caches the ranked list (see `GUIDE-free-model-routing.md`).

## Related

- `examples/tool-loop/` — runnable multi-turn loop
- `GUIDE-free-model-routing.md` — precheck + ranking + strategy/demotion