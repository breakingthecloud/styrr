/**
 * Styrr v0.6.0 — Multi-turn tool-calling loop (the prod pattern that got fixed)
 *
 * Shows the full loop VelaroChat runs:
 *   1. router.call(messages, { tools }) → may return toolCalls
 *   2. sanitize the arguments (even if raw/broken) → always a plain object
 *   3. execute the tool locally
 *   4. push assistant(tool_calls) + role:'tool' results back
 *   5. repeat until the model replies with text only
 *
 * Styrr v0.6.0 guarantees the arguments are a valid JSON object string on the
 * wire, and treats a 400 "arguments must be valid JSON" as recoverable:
 * one sanitized retry, then fallback to the next model (SoWOSS-003/004).
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... pnpm run start
 */

import {
  StyrRouter,
  sanitizeMessages,
  safeArguments,
  type StyrMessage,
  type StyrToolSchema,
} from '@carloscortezcloud/styrr-llm';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Missing OPENROUTER_API_KEY. Run: OPENROUTER_API_KEY=sk-or-... pnpm run start');
  process.exit(1);
}

// ── Tools ──────────────────────────────────────────────────────────────

const tools: StyrToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'convert_currency',
      description: 'Convert an amount between two currencies',
      parameters: {
        type: 'object',
        properties: { amount: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } },
        required: ['amount', 'from', 'to'],
      },
    },
  },
];

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'get_weather':
      return JSON.stringify({ city: args.city, temp: 22, condition: 'sunny' });
    case 'convert_currency': {
      const rate: Record<string, number> = { USD: 1, EUR: 0.92, PEN: 3.7 };
      const val = Number(args.amount) * (rate[String(args.to)] ?? 1);
      return JSON.stringify({ from: args.from, to: args.to, amount: val.toFixed(2) });
    }
    default:
      return JSON.stringify({ error: `unknown tool: ${name}` });
  }
}

// ── Router ─────────────────────────────────────────────────────────────

const router = new StyrRouter({
  apiKey,
  // SoW-OSE-004: 'quality' ranks tool-capable free models before flaky ones
  // (gemma before nemotron) using the embedded quality table.
  strategy: 'quality',
  models: [
    { id: 'google/gemma-4-31b-it:free' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free' },
    // nemotron is flaky in prod (502 template) — demotion stores it to the end
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  ],
  onFallback: (failed, err, next) => console.warn(`  ↳ ${failed} ${err} → ${next}`),
});

// ── Tool loop ──────────────────────────────────────────────────────────

async function main() {
  const messages: StyrMessage[] = [
    { role: 'user', content: 'Qué tiempo hace en Lima? Y cuánto son 100 USD en PEN?' },
  ];

  const MAX_ITERATIONS = 4;

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    console.log(`\n── iteration ${iter} ──`);

    // extra safety net; styrr also sanitizes at normalization time (idempotent)
    const safeMsg = sanitizeMessages(messages as any);

    const result = await router.call(safeMsg as any, { tools, strategy: 'quality' });

    if (result.toolCalls && result.toolCalls.length > 0) {
      // Persist the assistant turn so the next request includes these tool_calls
      messages.push({
        role: 'assistant',
        content: result.text,
      } as any);
      (messages[messages.length - 1] as any).tool_calls = result.toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: safeArguments(tc.arguments), // plain object (never garbage)
      }));

      for (const tc of result.toolCalls) {
        const args = safeArguments(tc.arguments);
        console.log(`  🧰 ${tc.name}(${JSON.stringify(args)})`);
        const toolResult = await runTool(tc.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
        console.log(`     → ${toolResult}`);
      }
      continue;
    }

    console.log('✅ Final answer:', result.text);
    console.log('   model:', result.modelUsed, '| latency:', result.latencyMs, 'ms | fallbacks:', result.fallbacksTried);
    return;
  }

  console.warn('Reached MAX_ITERATIONS without a final answer');
}

main().catch(err => {
  console.error('Loop failed:', err);
  process.exit(1);
});