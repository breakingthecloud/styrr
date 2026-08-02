# Styrr + Amazon Bedrock AgentCore — Cross-Provider Fallback Pattern

> How to use Styrr as the LLM routing layer inside a Bedrock AgentCore deployment,
> with an ordered cross-provider fallback that decides by budget + latency.

## Why

Bedrock AgentCore gives you agent orchestration on AWS. But you don't have to be
locked into Bedrock models. Styrr's multi-model fallback chain lets a single agent
call try, in order:

1. **Bedrock** (Claude 3 Sonnet) — low latency, in-VPC
2. **External** (OpenRouter o1) — highest quality, higher cost
3. **Free** (Llama 3.3 70B Instruct) — last resort, zero cost

When budget is tight, Sayay can `degrade` the chain from (1) to (2) or (3) — see the
[Sayay + Step Functions integration](../../../sayay/docs/step-functions.md).

## Setup

```bash
npm install @carloscortezcloud/styrr-llm @aws-sdk/client-bedrock-runtime
```

`BedrockProvider` lazy-imports the AWS SDK — the package itself stays zero-dependency.

## Router config

```typescript
import { StyrRouter } from '@carloscortezcloud/styrr-llm';

const router = new StyrRouter({
  apiKey: process.env.OPENROUTER_API_KEY!, // fallback key; bedrock uses IAM
  models: [
    { id: 'anthropic.claude-3-sonnet-20240229-v1:0', provider: 'bedrock' }, // primary
    { id: 'openai/o1', provider: 'openrouter' },                             // 2nd
    { id: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' }, // 3rd
  ],
  onFallback: (failed, error, next) => {
    console.warn(`[Styrr] ${failed} failed (${error}) → ${next}`);
  },
});

// No AWS SDK at import time — only when a bedrock model is actually called
const result = await router.prompt('Summarize this ticket...');
console.log(result.modelUsed, result.fallbacksTried);
```

> **IAM note:** Bedrock calls authenticate via the Lambda's execution role (or
> local `~/.aws/credentials`). No API key needed for the bedrock leg of the chain.

## AgentCore integration

In a Bedrock AgentCore application:

- **The agent's tool** `call_llm` invokes Styrr (as a Lambda or a sidecar HTTP call).
- Styrr's `prompt()` runs the ordered fallback and returns `{ text, modelUsed, latencyMs, fallbacksTried, usage }`.
- Return `modelUsed` to the agent so it can log which tier actually served the request.

```typescript
export async function handler(event: { inputText: string }) {
  const result = await router.prompt(event.inputText);
  return {
    completion: result.text,
    model: result.modelUsed,
    tokens: result.usage?.totalTokens,
    costTier: result.modelUsed.startsWith('anthropic') ? 'bedrock' : result.modelUsed.includes('free') ? 'free' : 'external',
  };
}
```

## Budget-aware degrade (with Sayay)

See `sayay` `checkOrThrow()` + `degrade` action: when usage crosses
`degradeThreshold`, drop the chain's primary Bedrock tier so cheaper/free models
serve the rest of the session.

## Fallback semantics

| Error | Behavior |
|-------|----------|
| 429, 5xx, timeout | Fall to next model |
| 401, 400 (auth/schema) | Fail-fast — throw, don't retry |
| Model unreachable | Fall to next model |

This keeps Bedrock as the fast default while preserving burst resilience through
OpenRouter free models — exactly the "decision by budget + latency" behavior the
[raw research](../../../cc-roadmap/oss-ecosystem/tokenops/README.md) describes.
