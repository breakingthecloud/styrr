// Styrr cross-provider fallback for Bedrock AgentCore.
//
// Ordered chain: Bedrock (fast, in-VPC) → OpenRouter (best quality) → free (zero cost).
// Run with: OPENROUTER_API_KEY=... node src/index.mjs
//
// NOTE: the bedrock leg authenticates via your local ~/.aws/credentials.
// Requires: npm install @aws-sdk/client-bedrock-runtime (lazy-imported by BedrockProvider).

import { StyrRouter } from '@carloscortezcloud/styrr-llm';

const router = new StyrRouter({
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
  models: [
    { id: 'anthropic.claude-3-sonnet-20240229-v1:0', provider: 'bedrock' },
    { id: 'openai/o1', provider: 'openrouter' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
  ],
  onFallback: (failed, error, next) => {
    console.warn(`[Styrr] ${failed} failed (${error}) → trying ${next}`);
  },
});

async function main() {
  const prompt = process.argv[2] ?? 'Explain FinOps in one sentence.';
  const result = await router.prompt(prompt);

  console.log('\n=== AgentCore handler-style response ===');
  console.log(JSON.stringify(
    {
      completion: result.text,
      model: result.modelUsed,
      latencyMs: result.latencyMs,
      fallbacksTried: result.fallbacksTried,
      tokens: result.usage?.totalTokens,
      costTier: result.modelUsed.startsWith('anthropic')
        ? 'bedrock'
        : result.modelUsed.includes('free')
          ? 'free'
          : 'external',
    },
    null,
    2,
  ));
}

main().catch((err) => {
  console.error('[AgentCore example] Failed:', err.message);
  process.exit(1);
});
