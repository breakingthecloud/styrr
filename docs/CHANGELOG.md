# Styrr Changelog

> Historial público de [`@carloscortezcloud/styrr-llm`](https://www.npmjs.com/package/@carloscortezcloud/styrr-llm) — 1 entrada por versión.
> Repo: https://github.com/breakingthecloud/styrr

Última actualización: **2026-08-25** · `v0.1.0` → `v0.6.0`.

---

## Overview

| Versión | Git tag | Fecha | Resumen |
|---------|---------|-------|---------|
| **0.6.0** | `v0.6.0` | 2026-08-08 | Sanitización tool_call + quality routing + demotion |
| **0.5.0** | `v0.5.0` | 2026-08-02 | Bedrock AgentCore cross-provider fallback |
| **0.4.0** | `v0.4.0` | 2026-07-28 | Streaming `router.stream()` + SSE |
| **0.3.1** | `v0.3.1` | 2026-07-28 | Provider adapters fix |
| **0.3.0** | `v0.3.0` | 2026-07-28 | Provider adapters + auto-detection |
| **0.2.0** | `v0.2.0` | 2026-07-24 | Cost estimation + routing strategies |
| **0.1.2** | `v0.1.2` | 2026-07-22 | Normalize camelCase → snake_case |
| **0.1.1** | `v0.1.1` | 2026-07-22 | ESM `type: module` |
| **0.1.0** | `v0.1.0` | 2026-07-22 | Initial: 246 líneas, zero deps |

---

## v0.6.0 — 2026-08-08 — Sanitización + Quality

**Tag:** `v0.6.0` @ `880c95f` · **npm:** `0.6.0` @ 14:12 UTC · 22 files, 71,545

- `sanitize.ts` + 400 recovery + quality ranking + demotion 30s

---

## v0.5.0 — 2026-08-02 — AgentCore

**Tag:** `v0.5.0` @ `0b3aab0` · **npm:** `0.5.0` @ 21:38 UTC

- Bedrock AgentCore fallback pattern doc + example

---

## v0.4.0 — 2026-07-28 — Streaming

**Tag:** `v0.4.0` @ `c54424b` · **npm:** `0.4.0` @ 01:25 UTC · 20 files, 55,108

- `router.stream()` + SSE parser + Bedrock streaming

---

## v0.3.1 — 2026-07-28 — Fix

**Tag:** `v0.3.1` @ `901ea8d` · **npm:** `0.3.1`

- Fix provider adapters

---

## v0.3.0 — 2026-07-28 — Provider adapters

**Tag:** `v0.3.0` @ `906e314` · **npm:** `0.3.0`

- Auto-detection OpenAI/Bedrock/HuggingFace

---

## v0.2.0 — 2026-07-24 — Cost routing

**Tag:** `v0.2.0` @ `87d7316` · **npm:** `0.2.0`

- `cheapest/fastest/quality` + pricing DB

---

## v0.1.2 — 2026-07-22 — Normalize

**Tag:** `v0.1.2` @ `e266812`

- `toolCallId` → `tool_call_id`

---

## v0.1.1 — 2026-07-22 — ESM fix

**Tag:** `v0.1.1` @ `3e1e973`

- `type: module`

---

## v0.1.0 — 2026-07-22 — Initial

**Tag:** `v0.1.0` @ `efe8349`

- 246 líneas, zero deps, fallback chain

---

## Extra: styrr-strands@0.1.0 — 2026-07-28

**Tag:** `styrr-strands@0.1.0` @ `e07c642` — `StyrModelProvider extends Model<T>` para `@strands-agents/sdk`
