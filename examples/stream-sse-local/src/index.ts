import { StyrRouter } from '@carloscortezcloud/styrr-llm';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Usage: OPENROUTER_API_KEY=sk-... npx tsx src/index.ts');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '3447', 10);

const router = new StyrRouter({
  apiKey,
  models: [
    { id: 'openai/gpt-4o-mini' },
    { id: 'anthropic/claude-3-haiku' },
  ],
});

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/stream') {
    res.writeHead(405);
    res.end('Use POST /stream with { "prompt": "..." }\n');
    return;
  }

  let body = '';
  req.on('data', (chunk: Buffer) => body += chunk.toString());
  req.on('end', async () => {
    let prompt: string;
    try {
      prompt = JSON.parse(body).prompt;
      if (!prompt) throw new Error();
    } catch {
      res.writeHead(400);
      res.end('{"error":"Missing prompt field"}\n');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sessionId = randomUUID();

    for await (const event of router.stream([{ role: 'user', content: prompt }])) {
      switch (event.type) {
        case 'text_delta':
          res.write(`event: text_delta\ndata: ${JSON.stringify({ sessionId, text: event.text })}\n\n`);
          break;
        case 'tool_call_start':
          res.write(`event: tool_call_start\ndata: ${JSON.stringify({ sessionId, toolCall: event.toolCall })}\n\n`);
          break;
        case 'tool_call_done':
          res.write(`event: tool_call_done\ndata: ${JSON.stringify({ sessionId, toolCall: event.toolCall })}\n\n`);
          break;
        case 'done':
          res.write(`event: done\ndata: ${JSON.stringify({ sessionId, modelUsed: event.modelUsed, usage: event.usage })}\n\n`);
          res.end();
          return;
        case 'error':
          res.write(`event: error\ndata: ${JSON.stringify({ sessionId, error: event.error })}\n\n`);
          res.end();
          return;
      }
    }

    res.end();
  });
});

server.listen(PORT, () => {
  console.log(`Styrr streaming SSE server running on http://localhost:${PORT}/stream`);
  console.log(`Example: curl -X POST http://localhost:${PORT}/stream \\`);
  console.log(`  -H 'Content-Type: application/json' \\`);
  console.log(`  -d '{"prompt":"What is the capital of France?"}'`);
});
