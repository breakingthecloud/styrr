import { Agent } from '@strands-agents/sdk';
import { StyrModelProvider } from '@carloscortezcloud/styrr-strands';

const apiKey = process.env.OPENROUTER_API_KEY!;
if (!apiKey) {
  console.error('Usage: OPENROUTER_API_KEY=sk-... npx tsx src/fallback-test.ts');
  process.exit(1);
}

const model = new StyrModelProvider({
  models: [
    { id: 'does-not-exist-model-99999' },
    { id: 'openai/gpt-4o-mini' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free' },
  ],
  apiKey,
  onFallback: (from, error, next) => {
    console.log(`  ⚠  ${from} failed → falling to ${next}: ${error.slice(0, 80)}`);
  },
});

const agent = new Agent({
  model,
  systemPrompt: 'You are a helpful assistant. Be concise.',
  printer: true,
});

console.log('\n  Testing fallback chain (first model should fail)...\n');

const result = await agent.invoke('Say hello in exactly 3 words.');

console.log(`\n  ✓ Stop reason: ${result.stopReason}`);
if (result.metrics?.accumulatedUsage) {
  const { inputTokens, outputTokens } = result.metrics.accumulatedUsage;
  console.log(`    Tokens: ${inputTokens} in / ${outputTokens} out`);
}
