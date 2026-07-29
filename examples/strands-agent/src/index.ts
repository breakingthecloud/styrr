import { Agent } from '@strands-agents/sdk';
import { StyrModelProvider } from '@carloscortezcloud/styrr-strands';

const apiKey = process.env.OPENROUTER_API_KEY!;
if (!apiKey) {
  console.error('Usage: OPENROUTER_API_KEY=sk-... npx tsx src/index.ts');
  process.exit(1);
}

const model = new StyrModelProvider({
  models: [
    { id: 'openai/gpt-4o-mini' },
  ],
  apiKey,
});

const agent = new Agent({
  model,
  systemPrompt: 'You are a helpful assistant. Be concise.',
  printer: true,
});

const prompt = process.argv[2] || 'What is the capital of France?';

console.log(`\n  Prompt: "${prompt}"\n`);

const result = await agent.invoke(prompt);

console.log(`\n  ✓ Stop reason: ${result.stopReason}`);
if (result.metrics?.accumulatedUsage) {
  const { inputTokens, outputTokens } = result.metrics.accumulatedUsage;
  console.log(`    Tokens: ${inputTokens} in / ${outputTokens} out`);
}
