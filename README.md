<p align="center">
  <img alt="Styrr" src="https://img.shields.io/badge/🧭-Styrr-10B981?style=for-the-badge" height="50">
</p>

<p align="center">
  <b>Minimal LLM Router</b><br>
  Multi-model fallback chain. Zero dependencies. Works everywhere.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#why-styrr">Why Styrr?</a>
  ·
  <a href="#ecosystem">Ecosystem</a>
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/styrr?style=flat-square&logo=npm&color=10B981" alt="npm">
  <img src="https://img.shields.io/badge/license-Apache_2.0-10B981?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-5.5%2B-3178C6?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/dependencies-0-success?style=flat-square" alt="Zero deps">
  <img src="https://img.shields.io/badge/size-%3E5KB-10B981?style=flat-square" alt="Size">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs">
</p>

---

## What Is Styrr?

Styrr (Old Norse: "rudder") steers your LLM requests to the right model. If one model fails (rate limit, timeout, error), it automatically tries the next. One consistent API for OpenAI, OpenRouter, Bedrock, Ollama — or any OpenAI-compatible endpoint.

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

const result = await router.prompt('Explain FinOps in 2 sentences.');
console.log(result.text);          // "FinOps is..."
console.log(result.modelUsed);     // which model responded
console.log(result.latencyMs);     // how long it took
console.log(result.fallbacksTried); // 0 if primary worked
```

## Install

```bash
npm install styrr
```

## Quick Start

### 1. Install

```bash
npm install styrr
```

### 2. Route your first prompt

```typescript
import { StyrRouter } from 'styrr';

const router = new StyrRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
  models: [
    { id: 'meta-llama/llama-3.3-70b-instruct:free' },
  ],
});

const result = await router.prompt('Hello!');
console.log(result.text);
```

## Features

| Feature | Description |
|---------|-------------|
| **Multi-model fallback** | If model 1 returns 429/5xx, automatically tries model 2, 3, etc. |
| **Fail-fast on auth errors** | 401/400 throws immediately — don't retry with different model |
| **Structured JSON output** | Auto-parses JSON responses, strips markdown fences |
| **Tool calling** | Pass tool schemas, get parsed tool_calls back |
| **Timeout per model** | `AbortSignal.timeout` per call |
| **Zero dependencies** | Just `fetch()` — works anywhere |
| **Observable** | `onFallback` and `onAllFailed` hooks |

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

| Feature | Styrr | LiteLLM | OpenRouter |
|---------|:-----:|:-------:|:----------:|
| Zero dependencies | ✅ | ❌ | N/A |
| Self-hosted | ✅ | ✅ | ❌ |
| Works in CF Workers | ✅ | ❌ | N/A |
| Fallback chain | ✅ | ✅ | ❌ |
| Tool calling | ✅ | ✅ | ✅ |
| Cost-aware routing | 🔜 | ❌ | ❌ |
| Size | ~5KB | ~500KB | — |

## Ecosystem

| Package | Role | npm |
|---------|------|-----|
| **Styrr** | LLM router (this) | `styrr` |
| **Sayay** | Cost guardrails | GitHub |
| **Tinkuy** | Agent framework | `@carloscortezcloud/tinkuy-agent` |
| **Qhaway** | Agent observability | `@carloscortezcloud/qhaway` |
| **TideRAG** | Edge RAG pipeline | `@carloscortezcloud/tiderag` |

## License

Apache 2.0 — see [LICENSE](LICENSE).

---

<p align="center">
  Built by engineers who got tired of vendor lock-in.<br>
  <a href="https://github.com/breakingthecloud/tinkuylabs">Tinkuy Labs</a> · <a href="https://finoptix.dev">finoptix.dev</a>
</p>
<p align="center">
  <sub>Works on free models. Zero deps. Ship it.</sub>
</p>
