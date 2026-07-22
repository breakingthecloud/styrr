# 🧭 Styrr — Minimal LLM Router

Multi-model fallback chain for LLM calls. Zero dependencies. Works in Cloudflare Workers, AWS Lambda, Node.js, Deno.

## Install

```bash
npm install styrr
```

## Quick Start

```typescript
import { StyrRouter } from 'styrr';

const router = new StyrRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
  models: [
    { id: 'nvidia/nemotron-3-super-120b:free' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free' },
    { id: 'qwen/qwen3-coder:free' },
  ],
});

const result = await router.prompt('Explain what FinOps is in 2 sentences.');
console.log(result.text);          // "FinOps is..."
console.log(result.modelUsed);     // which model responded
console.log(result.latencyMs);     // how long it took
console.log(result.fallbacksTried); // 0 if primary worked
```

## Features

- **Multi-model fallback**: if model 1 returns 429/5xx, automatically tries model 2, 3, etc.
- **Fail-fast on auth errors**: 401/400 throws immediately (don't retry with different model)
- **Structured JSON output**: auto-parses JSON responses, strips markdown fences
- **Tool calling**: pass tool schemas, get parsed tool_calls back
- **Timeout per model**: AbortSignal.timeout per call
- **Zero dependencies**: just `fetch()` — works anywhere
- **Observable**: `onFallback` and `onAllFailed` hooks for logging

## Advanced Usage

### With tools (function calling)

```typescript
const result = await router.call(messages, {
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } }
    }
  }]
});

if (result.toolCalls) {
  console.log(result.toolCalls[0].name);      // 'get_weather'
  console.log(result.toolCalls[0].arguments); // { city: 'Lima' }
}
```

### With observability hooks

```typescript
const router = new StyrRouter({
  apiKey: '...',
  models: [...],
  onFallback: (failed, error, next) => {
    console.warn(`[Styrr] ${failed} failed (${error}), trying ${next}`);
  },
  onAllFailed: (errors) => {
    console.error('[Styrr] All models exhausted:', errors);
  },
});
```

### Custom providers (Bedrock, Ollama, etc.)

```typescript
const router = new StyrRouter({
  apiKey: 'not-used',
  models: [
    { id: 'llama3.2', baseUrl: 'http://localhost:11434/v1', provider: 'ollama' },
    { id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-...' },
  ],
});
```

## Why Styrr?

| Feature | Styrr | LiteLLM | OpenRouter (SaaS) |
|---------|:-----:|:-------:|:-----------------:|
| Zero dependencies | ✅ | ❌ (Python, httpx) | N/A |
| Self-hosted | ✅ | ✅ | ❌ |
| Works in CF Workers | ✅ | ❌ | N/A |
| Fallback chain | ✅ | ✅ | ❌ |
| Tool calling | ✅ | ✅ | ✅ |
| Cost-aware routing | 🔜 (styrr-003) | ❌ | ❌ |
| Budget enforcement | 🔜 (sayay) | ❌ | ❌ |
| Size | ~5KB | ~500KB | — |

## Name

**Styrr** (Old Norse) = "rudder/tiller" — the part of the ship that steers direction. Because this library steers your LLM requests to the right model.

## Part of the FinOptix OSS Ecosystem

- 🧭 **Styrr** — LLM Router (this package)
- ⚓ **Sayay** — Agent Cost Guardrails
- 🌊 **Tinkuy** — Agentic Framework
- 👁️ **Qhaway** — Agent Observability
- 🗺️ **Ñan** — Architecture Graph

## License

Apache 2.0
