# Styrr — Multi-turn Tool-Calling Loop (v0.6.0)

The exact pattern that was breaking in prod before SoWOSS-003/004 — now the
arguments sanitization and 400-recovery live **inside** styrr, so your loop
just keeps iterating.

## What this demo shows

```
iteration 1:  router.call(messages, { tools })
                 │ tool_calls[0] = { id, name, arguments }   ← always clean
                 ▼
             push assistant(tool_calls) + run tool locally
                 ▼
             push { role:'tool', tool_call_id, content }
                 ▼
iteration 2:  call again → model writes the final answer
```

## Why the arguments matter

Free models (OpenRouter) sometimes emit `tool_calls[].function.arguments` as a
broken string (`'{"a":1,'`) or as a JSON object instead of a string. OpenRouter
rejects those with:

```
400 messages[N].tool_calls[0].function.arguments must be a valid JSON object string
```

Since v0.6.0:

| Layer | Behavior |
|-------|----------|
| **Normalization** | `sanitizeToolCall` guarantees `arguments` serializes to a valid JSON object string (broken → `{}`) |
| **4123**: no-fatal | A 400 mentioning `arguments`/`valid JSON`/`validation` does ONE sanitized retry, then falls back to the next model |
| **Provider** | `toWireToolCall` is idempotent — no double-encoding |

If you are building a long-lived agent loop, sanitize defensively with the
exported utils (`sanitizeMessages`, `safeArguments`) — it is idempotent.

## Run

```bash
OPENROUTER_API_KEY=sk-or-... pnpm run start
```

## Learn more

- `GUIDE-tool-call-robustness.md` — the full guarantee + 400 recovery reference
- `GUIDE-free-model-routing.md` — pick the free models here (`strategy:'quality'`)