import { describe, it, expect, vi, afterEach } from 'vitest';
import { StyrRouter } from './index.js';
import type { StyrMessage } from './index.js';

const A = 'test/model-a';
const B = 'test/model-b';
const NEMOTRON = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const GEMMA = 'google/gemma-4-31b-it:free';

const ARGS_400_BODY = JSON.stringify({
  error: { message: 'messages[1].tool_calls[0].function.arguments must be a valid JSON object string' },
});

const okJson = (text = 'ok') => () =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const err = (status: number, body: string) => () => new Response(body, { status });

const sse = (chunks: object[]) => () =>
  new Response(chunks.map(c => `data: ${JSON.stringify(c)}`).join('\n\n') + '\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

type FetchCall = { model: string; body: any };

/** Stub global fetch with a per-model queue of response factories (last one repeats). */
function stubFetch(plan: Record<string, Array<() => Response>>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ model: body.model, body });
    const queue = plan[body.model];
    if (!queue?.length) throw new Error(`no fetch stub for ${body.model}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return next();
  });
  return calls;
}

const router = (models: { id: string }[], extra: any = {}) =>
  new StyrRouter({ models, apiKey: 'k', ...extra });

afterEach(() => vi.unstubAllGlobals());

describe('SoW-OSS-003 Fase 1 — arguments always valid on the wire', () => {
  it('raw broken string arguments → serialized as {} (replay prod)', async () => {
    const calls = stubFetch({ [A]: [okJson()] });
    const messages = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_sprint_status', arguments: '{"a":1,' }] },
    ] as unknown as StyrMessage[];

    await router([{ id: A }]).call(messages);

    const args = calls[0].body.messages[0].tool_calls[0].function.arguments;
    expect(args).toBe('{}');
    expect(JSON.parse(args)).toEqual({});
  });

  it('valid object arguments → single-encoded JSON string (no double encoding)', async () => {
    const calls = stubFetch({ [A]: [okJson()] });
    const messages = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'explain_phase', arguments: { phase: 'BUILD' } }] },
    ] as unknown as StyrMessage[];

    await router([{ id: A }]).call(messages);

    const args = calls[0].body.messages[0].tool_calls[0].function.arguments;
    expect(args).toBe('{"phase":"BUILD"}');
  });
});

describe('SoW-OSS-003 Fase 1b — 400 arguments is not fatal', () => {
  it('call(): one sanitized retry on the same model, then success', async () => {
    const calls = stubFetch({ [A]: [err(400, ARGS_400_BODY), okJson()] });
    const onFallback = vi.fn();

    const res = await router([{ id: A }], { onFallback }).call([{ role: 'user', content: 'hi' }]);

    expect(res.text).toBe('ok');
    expect(res.fallbacksTried).toBe(0);
    expect(calls.filter(c => c.model === A)).toHaveLength(2);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('call(): persistent 400 arguments → falls back to next model', async () => {
    const calls = stubFetch({ [A]: [err(400, ARGS_400_BODY)], [B]: [okJson('from-b')] });
    const onFallback = vi.fn();

    const res = await router([{ id: A }, { id: B }], { onFallback }).call([{ role: 'user', content: 'hi' }]);

    expect(res.modelUsed).toBe(B);
    expect(res.fallbacksTried).toBe(1);
    expect(calls.filter(c => c.model === A)).toHaveLength(2); // original + sanitized retry
    expect(calls.filter(c => c.model === B)).toHaveLength(1);
    expect(onFallback).toHaveBeenCalledWith(A, expect.stringContaining('arguments'), B);
  });

  it('call(): generic 400 (not arguments-related) stays fatal', async () => {
    const calls = stubFetch({ [A]: [err(400, JSON.stringify({ error: { message: 'unsupported parameter' } }))] });

    await expect(router([{ id: A }]).call([{ role: 'user', content: 'hi' }])).rejects.toThrow(/Auth\/validation error/);
    expect(calls).toHaveLength(1);
  });

  it('call(): 401 stays fatal', async () => {
    const calls = stubFetch({ [A]: [err(401, 'unauthorized')] });

    await expect(router([{ id: A }]).call([{ role: 'user', content: 'hi' }])).rejects.toThrow(/401|Auth/);
    expect(calls).toHaveLength(1);
  });

  it('stream(): 400 arguments → sanitized retry → success, no error event', async () => {
    stubFetch({
      [A]: [err(400, ARGS_400_BODY), sse([{ choices: [{ delta: { content: 'hi' } }] }])],
    });

    const events = [];
    for await (const e of router([{ id: A }]).stream([{ role: 'user', content: 'x' }])) events.push(e);

    expect(events.some(e => e.type === 'error')).toBe(false);
    expect(events.some(e => e.type === 'text_delta' && e.text === 'hi')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('stream(): persistent 400 arguments → falls back to next model', async () => {
    stubFetch({
      [A]: [err(400, ARGS_400_BODY)],
      [B]: [sse([{ choices: [{ delta: { content: 'from-b' } }] }])],
    });

    const events = [];
    for await (const e of router([{ id: A }, { id: B }]).stream([{ role: 'user', content: 'x' }])) events.push(e);

    expect(events.some(e => e.type === 'error')).toBe(false);
    const done = events.find(e => e.type === 'done') as any;
    expect(done?.modelUsed).toBe(B);
  });
});

describe('SoW-OSS-004 Fase 2 — strategy + demotion', () => {
  it("strategy 'quality' routes to gemma even when nemotron is listed first", async () => {
    const calls = stubFetch({ [GEMMA]: [okJson()], [NEMOTRON]: [okJson()] });

    const res = await router([{ id: NEMOTRON }, { id: GEMMA }], { strategy: 'quality' }).call([
      { role: 'user', content: 'hi' },
    ]);

    expect(res.modelUsed).toBe(GEMMA);
    expect(calls[0].model).toBe(GEMMA);
  });

  it("options.strategy overrides config; default 'fallback' keeps config order", async () => {
    const calls = stubFetch({ [GEMMA]: [okJson()], [NEMOTRON]: [okJson()] });
    const r = router([{ id: NEMOTRON }, { id: GEMMA }]);

    await r.call([{ role: 'user', content: 'hi' }]); // fallback → nemotron first
    expect(calls[0].model).toBe(NEMOTRON);

    await r.call([{ role: 'user', content: 'hi' }], { strategy: 'quality' }); // override → gemma
    expect(calls[1].model).toBe(GEMMA);
  });

  it('demotes a model to the end after 2 consecutive failures', async () => {
    const calls = stubFetch({ [A]: [err(502, 'Failed to apply prompt template')], [B]: [okJson('from-b')] });
    const r = router([{ id: A }, { id: B }], { demotionPenaltyMs: 60000 });

    await r.call([{ role: 'user', content: 'x' }]); // A fails (1), B ok
    await r.call([{ role: 'user', content: 'x' }]); // A fails (2) → demoted, B ok
    const res = await r.call([{ role: 'user', content: 'x' }]); // B first now

    expect(calls.map(c => c.model)).toEqual([A, B, A, B, B]);
    expect(res.modelUsed).toBe(B);
    expect(res.fallbacksTried).toBe(0);
  });

  it('demoted model returns to its position after the TTL', async () => {
    const calls = stubFetch({ [A]: [err(502, 'boom')], [B]: [okJson('from-b')] });
    const r = router([{ id: A }, { id: B }], { demotionPenaltyMs: 30 });

    await r.call([{ role: 'user', content: 'x' }]);
    await r.call([{ role: 'user', content: 'x' }]); // A demoted here
    await new Promise(r2 => setTimeout(r2, 50)); // let TTL expire
    await r.call([{ role: 'user', content: 'x' }]);

    expect(calls.map(c => c.model)).toEqual([A, B, A, B, A, B]);
  });

  it('reportSuccess resets the failure counter', async () => {
    const calls = stubFetch({
      [A]: [err(502, 'boom'), okJson('recovered'), err(502, 'boom'), err(502, 'boom')],
      [B]: [okJson('from-b')],
    });
    const r = router([{ id: A }, { id: B }], { demotionPenaltyMs: 60000 });

    await r.call([{ role: 'user', content: 'x' }]); // A fails (1), B ok
    await r.call([{ role: 'user', content: 'x' }]); // A ok → counter reset
    await r.call([{ role: 'user', content: 'x' }]); // A fails (1 again — not demoted), B ok
    await r.call([{ role: 'user', content: 'x' }]); // A fails (2) → demoted, B ok
    const res = await r.call([{ role: 'user', content: 'x' }]); // B first now

    expect(calls.map(c => c.model)).toEqual([A, B, A, A, B, A, B, B]);
    expect(res.modelUsed).toBe(B);
  });
});
