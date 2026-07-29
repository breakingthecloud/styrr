# Provider Adapters — Usage Guide

Styrr v0.3.0 adds multi-provider support. Instead of routing everything through OpenRouter (the default), you can now call any LLM provider directly — or mix providers in a single fallback chain.

## Architecture

```
StyrRouter
  └── callModel(model, messages)
        └── getProviderForModel(model) → auto-selects adapter
              ├── OpenAICompatProvider  → OpenRouter, OpenAI, Ollama, NVIDIA, vLLM, any OpenAI-compatible API
              ├── BedrockProvider       → AWS Bedrock Converse API (optional: @aws-sdk/client-bedrock-runtime)
              └── HuggingFaceProvider   → HuggingFace Inference API
```

Auto-detection maps model IDs to providers:

| Model ID prefix | Provider |
|----------------|----------|
| `gpt-`, `o1`, `o3`, `claude-`, `gemini-` | OpenAI-compatible |
| `anthropic.`, `meta.llama`, `amazon.`, `mistral.` | AWS Bedrock |
| `huggingface/` | HuggingFace |
| `nvidia/`, `meta-llama/` (via OpenRouter) | OpenAI-compatible (OpenRouter) |
| Any with `baseUrl` set | OpenAI-compatible (custom endpoint) |

## Install

```bash
npm install @carloscortezcloud/styrr-llm
# or
pnpm add @carloscortezcloud/styrr-llm
```

For AWS Bedrock, also install:

```bash
npm install @aws-sdk/client-bedrock-runtime
```

## Provider Setup (Step by Step)

### 1. OpenRouter (default — zero config)

No extra setup. Just pass model IDs as you see them on OpenRouter:

```typescript
import { StyrRouter } from '@carloscortezcloud/styrr-llm';

const router = new StyrRouter({
  apiKey: process.env.OPENROUTER_API_KEY, // ← your OpenRouter API key
  models: [
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
    { id: 'google/gemma-4-31b-it:free' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free' },
  ],
});
```

Models starting with `nvidia/`, `meta-llama/`, `google/`, `anthropic/`, `openai/`, `mistralai/`, `qwen/`, etc. are auto-detected as OpenRouter.

### 2. OpenAI (native, without OpenRouter)

```typescript
const router = new StyrRouter({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: 'https://api.openai.com/v1',
  models: [
    { id: 'gpt-4o', provider: 'openai' },
    { id: 'gpt-4o-mini', provider: 'openai' },
  ],
});
```

If the model ID starts with `gpt-`, `o1`, or `o3`, auto-detection picks OpenAI automatically — you can omit `provider: 'openai'`.

### 3. AWS Bedrock

Requires `@aws-sdk/client-bedrock-runtime` installed separately. Credentials are read from the standard AWS chain (env vars, ~/.aws/credentials, IAM role).

```typescript
const router = new StyrRouter({
  apiKey: '', // not used by Bedrock
  models: [
    { id: 'anthropic.claude-sonnet-4-20250514', provider: 'bedrock' },
    { id: 'meta.llama3-70b-instruct-v1:0', provider: 'bedrock' },
  ],
});
```

Auto-detection matches IDs starting with `anthropic.`, `meta.`, `amazon.`, `mistral.`, `ai21.`, or `cohere.`.

Set the region per model:

```typescript
{ id: 'anthropic.claude-sonnet-4-20250514', provider: 'bedrock', baseUrl: 'eu-west-1' }
```

### 4. Ollama (local)

```typescript
const router = new StyrRouter({
  apiKey: '', // Ollama doesn't use API keys by default
  models: [
    { id: 'llama3.2', provider: 'ollama', baseUrl: 'http://localhost:11434/v1' },
    { id: 'qwen2.5-coder', provider: 'ollama', baseUrl: 'http://localhost:11434/v1' },
  ],
});
```

Ollama exposes an OpenAI-compatible endpoint at `/v1`, so the `OpenAICompatProvider` handles it.

### 5. HuggingFace Inference API

```typescript
const router = new StyrRouter({
  apiKey: process.env.HF_API_KEY, // huggingface.co/settings/tokens
  models: [
    { id: 'huggingface/meta-llama/Llama-3.3-70B-Instruct', provider: 'huggingface' },
  ],
});
```

The `huggingface/` prefix triggers auto-detection.

### 6. NVIDIA NIM (self-hosted or cloud)

```typescript
const router = new StyrRouter({
  apiKey: process.env.NVIDIA_API_KEY,
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  models: [
    { id: 'nvidia/nemotron-3-ultra-550b', provider: 'nvidia' },
  ],
});
```

### 7. Custom OpenAI-compatible endpoint

Any API that follows the OpenAI `/chat/completions` format works:

```typescript
const router = new StyrRouter({
  apiKey: process.env.MY_API_KEY,
  baseUrl: 'https://my-llm-gateway.example.com/v1',
  models: [
    { id: 'my-custom-model', provider: 'custom' },
  ],
});
```

## Mixing Providers in a Fallback Chain

This is where Styrr shines. Combine providers in one chain — the first model that succeeds wins.

### Free → Paid fallback

```typescript
const router = new StyrRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  models: [
    // Tier 1: Free models (OpenRouter)
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
    { id: 'google/gemma-4-31b-it:free' },
    // Tier 2: Paid models (OpenRouter)
    { id: 'openai/gpt-4o-mini' },
    // Tier 3: Direct OpenAI (bypass OpenRouter)
    { id: 'gpt-4o', provider: 'openai', apiKey: process.env.OPENAI_KEY_FALLBACK },
  ],
});
```

### Local → Cloud fallback

```typescript
const router = new StyrRouter({
  apiKey: process.env.OPENAI_API_KEY,
  models: [
    // Tier 1: Local Ollama
    { id: 'llama3.2', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', timeoutMs: 5000 },
    // Tier 2: Cloud OpenAI
    { id: 'gpt-4o-mini', provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
  ],
});
```

### Cloud → Cloud fallback

```typescript
const router = new StyrRouter({
  apiKey: '', // not used at router level — each model provides its own
  models: [
    // Tier 1: Bedrock (your provisioned throughput)
    { id: 'anthropic.claude-sonnet-4-20250514', provider: 'bedrock' },
    // Tier 2: OpenAI (pay-per-use)
    { id: 'gpt-4o', provider: 'openai', apiKey: process.env.OPENAI_FALLBACK_KEY },
  ],
});
```

## Per-Call Overrides

Override API key or base URL for a single call:

```typescript
const result = await router.call(messages, {
  apiKey: process.env.SPECIFIC_PROJECT_KEY,
  baseUrl: 'https://custom-gateway.example.com/v1',
});
```

## Using Providers Directly (without the Router)

You can instantiate a provider directly if you want to skip the fallback logic:

```typescript
import { OpenAICompatProvider } from '@carloscortezcloud/styrr-llm';

const provider = new OpenAICompatProvider();

const result = await provider.call({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: 'https://api.openai.com/v1',
});
```

## Auto-Detection Reference

| `model.id` starts with | Auto-detected provider |
|------------------------|-----------------------|
| `gpt-`, `o1`, `o3` | OpenAI-compatible |
| `claude-sonnet`, `claude-haiku`, `claude-opus` | OpenAI-compatible |
| `gemini-` | OpenAI-compatible |
| `anthropic.`, `meta.`, `amazon.`, `mistral.`, `ai21.`, `cohere.` | AWS Bedrock |
| `huggingface/` | HuggingFace |
| Anything with `baseUrl` set | OpenAI-compatible |

If you set `provider` explicitly on the model config, it takes precedence over auto-detection.

## Type Reference

```typescript
import {
  StyrRouter,          // Router class
  OpenAICompatProvider, // OpenAI-compatible provider
  BedrockProvider,     // AWS Bedrock provider
  HuggingFaceProvider, // HuggingFace provider
  getProviderForModel, // Auto-detection function
} from '@carloscortezcloud/styrr-llm';
```
