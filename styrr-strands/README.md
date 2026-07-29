# @carloscortezcloud/styrr-strands

Multi-model fallback as a [Strand Agents SDK](https://www.strands.ai) `Model` provider.

Never crash because a single model is rate-limited or down — Styrr chains models in order and falls through automatically.

```typescript
import { Agent } from '@strands-agents/sdk';
import { StyrModelProvider } from '@carloscortezcloud/styrr-strands';

const agent = new Agent({
  model: new StyrModelProvider({
    models: [
      { id: 'anthropic/claude-sonnet-4-20250514' },
      { id: 'openai/gpt-4o-mini' },
      { id: 'meta-llama/llama-3.3-70b-instruct:free' },
    ],
    apiKey: process.env.OPENROUTER_API_KEY!,
  }),
  systemPrompt: 'You are a helpful assistant.',
});
```

## Install

```bash
npm install @carloscortezcloud/styrr-llm @carloscortezcloud/styrr-strands
```

Peer dependency: `@strands-agents/sdk` ^1.11.0 (likely already in your project).

## Usage

### Basic

```typescript
import { StyrModelProvider } from '@carloscortezcloud/styrr-strands';

const model = new StyrModelProvider({
  models: [
    { id: 'openai/gpt-4o-mini' },
  ],
  apiKey: process.env.OPENROUTER_API_KEY!,
});
```

### With fallback chain

```typescript
const model = new StyrModelProvider({
  models: [
    { id: 'anthropic.claude-sonnet-4-5-v1:0' },     // Bedrock — primary
    { id: 'openai/gpt-4o-mini' },                    // OpenRouter — fallback 1
    { id: 'nvidia/nemotron-3-super-120b:free' },     // OpenRouter — fallback 2
  ],
  apiKey: process.env.OPENROUTER_API_KEY!,
  onFallback: (from, error, next) => {
    console.warn(`Fell back from ${from} to ${next}: ${error}`);
  },
});
```

### With tools

```typescript
const model = new StyrModelProvider({
  models: [{ id: 'openai/gpt-4o-mini' }],
  apiKey: process.env.OPENROUTER_API_KEY!,
});

const agent = new Agent({
  model,
  tools: [
    {
      name: 'get_weather',
      description: 'Get current weather for a location',
      inputSchema: {
        type: 'object',
        properties: {
          location: { type: 'string' },
        },
        required: ['location'],
      },
    },
  ],
  systemPrompt: 'You are a helpful assistant.',
});
```

## API

### `StyrModelProvider`

Extends `Model<StyrModelProviderConfig>`.

| Method | Description |
|--------|-------------|
| `stream(messages, options?)` | Async iterable of `ModelStreamEvent` |
| `updateConfig(config)` | Merge new config |
| `getConfig()` | Return current config |

### `StyrModelProviderConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `models` | `StyrModel[]` | required | Ordered list of models (first = primary) |
| `apiKey` | `string` | required | API key for the router |
| `baseUrl` | `string?` | OpenRouter default | Base URL override |
| `onFallback` | `(from, error, next) => void` | — | Called on each fallback |
| `maxTokens` | `number?` | provider default | Max output tokens |
| `temperature` | `number?` | provider default | Sampling temperature |
| `topP` | `number?` | provider default | Nucleus sampling |
| `contextWindowLimit` | `number?` | auto-resolved | Context window size |

## How it works

1. `stream()` converts Strands `Message[]` → Styrr format
2. Styrr calls the first model; if it fails (rate limit, 5xx, timeout), it retries then falls to the next
3. Styrr stream events are mapped to Strands `ModelStreamEvent` lifecycle

## License

Apache-2.0
