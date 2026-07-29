# @carloscortezcloud/styrr-strands

Multi-model fallback as a [Strands Agents SDK](https://www.strands.ai) `Model` provider.

Never crash because a single model is rate-limited or down — Styrr chains models in order and falls through automatically.

## Install

```bash
npm install @carloscortezcloud/styrr-llm @carloscortezcloud/styrr-strands
```

Requires `@strands-agents/sdk` >=1.11.0 as a peer dependency.

## Quick Start

```typescript
import { Agent } from '@strands-agents/sdk';
import { StyrModelProvider } from '@carloscortezcloud/styrr-strands';

const agent = new Agent({
  model: new StyrModelProvider({
    models: [
      { id: 'anthropic/claude-sonnet-4-20250514' },
      { id: 'openai/gpt-4o-mini' },
    ],
    apiKey: process.env.OPENROUTER_API_KEY!,
  }),
  systemPrompt: 'You are a helpful assistant.',
});
```

## Configuration

```typescript
interface StyrModelProviderConfig {
  models:      { id: string; baseUrl?: string; apiKey?: string }[];
  apiKey:      string;
  baseUrl?:    string;                        // default: https://openrouter.ai/api/v1
  onFallback?: (from: string, error: string, next: string) => void;
}
```

### Fallback chain

Models are tried in order. If the first returns 429, 5xx, or times out, the next is tried automatically.

```typescript
const model = new StyrModelProvider({
  models: [
    { id: 'anthropic.claude-sonnet-4-5-v1:0' },    // Bedrock primary
    { id: 'openai/gpt-4o-mini' },                   // OpenRouter fallback
    { id: 'nvidia/nemotron-3-super-120b:free' },    // Free fallback
  ],
  apiKey: process.env.OPENROUTER_API_KEY!,
  onFallback: (from, error, next) => {
    console.warn(`Fell back from ${from} to ${next}: ${error}`);
  },
});
```

### Tools (function calling)

Pass tools via the Agent config — tool schemas are forwarded to the LLM automatically.

```typescript
const agent = new Agent({
  model: new StyrModelProvider({
    models: [{ id: 'openai/gpt-4o-mini' }],
    apiKey: process.env.OPENROUTER_API_KEY!,
  }),
  tools: [{
    name: 'get_weather',
    description: 'Get current weather for a location',
    inputSchema: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
    },
  }],
  systemPrompt: 'You are a helpful assistant.',
});
```

## Stream Lifecycle

`StyrModelProvider.stream()` maps Styrr stream events to the Strands `ModelStreamEvent` lifecycle:

| Styrr event | Strands event(s) |
|---|---|
| `text_delta` | `modelContentBlockStartEvent` → 1+ `modelContentBlockDeltaEvent` → `modelContentBlockStopEvent` |
| `tool_call_start` / `tool_call_done` | `modelContentBlockStartEvent(toolUseStart)` → `modelContentBlockDeltaEvent(toolUseInputDelta)` → `modelContentBlockStopEvent` |
| `done` | `modelMessageStopEvent` + `modelMetadataEvent` |
| `error` | `modelMessageStopEvent` (graceful close) |

## API

### `StyrModelProvider`

Extends `Model<StyrModelProviderConfig>`. Implements `stream()` for Strands Agent compatibility.

| Method | Returns | Description |
|---|---|---|
| `stream(messages, options?)` | `AsyncIterable<ModelStreamEvent>` | Streaming model call |
| `updateConfig(config)` | `void` | Merge new config, recreate router |
| `getConfig()` | `StyrModelProviderConfig` | Return current config |
| `modelId` | `string \| undefined` | First model ID |

## Why styrr-strands instead of Strands SDK directly?

The Strands SDK lets you configure a single model provider (OpenAI, Anthropic, etc.). If that provider returns a 429 (rate-limited) or 5xx, the whole request fails.

`StyrModelProvider` wraps **Styrr's multi-model fallback** behind the same `Model` interface:

| Capability | Strands SDK (direct) | Styrr + Strands |
|---|---|---|
| Single provider | ✅ Uses one model | ✅ Uses one model |
| Fallback on 429/5xx | ❌ Request fails | ✅ Auto-retries next model in chain |
| Cross-provider fallback | ❌ Tied to one API | ✅ Bedrock → OpenRouter → local in one config |
| Retry logic | ❌ Manual | ✅ Built-in with configurable retries |
| Observable fallbacks | ❌ | ✅ `onFallback` hook |
| Stream lifecycle | ✅ Native | ✅ Full `ModelStreamEvent` mapping |
| Tool calling | ✅ Native | ✅ Forwarded through Styrr |

**Concrete example**: You deploy with Claude Sonnet on Bedrock as primary, GPT-4o-mini on OpenRouter as fallback, and a free model as third resort. If Bedrock is down, the request transparently falls through — your Strands Agent never knows.

## Architecture

```
Strands Agent
  └─ StyrModelProvider  (@carloscortezcloud/styrr-strands)
       └─ StyrRouter    (@carloscortezcloud/styrr-llm)
            ├─ OpenAI-compatible provider
            ├─ AWS Bedrock provider
            └─ HuggingFace provider (via Inference Endpoints)
```

`styrr-strands` is a thin adapter layer: it converts Strands `Message[]` → Styrr format, calls `StyrRouter.stream()`, and maps events back to `ModelStreamEvent`.

## Running Tests

Tests are in `examples/strands-agent/`:

```bash
cd examples/strands-agent
pnpm install
pnpm test
```

## License

Apache-2.0
