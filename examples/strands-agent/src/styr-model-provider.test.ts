import { describe, it, expect, vi } from 'vitest';
import { Message, TextBlock } from '@strands-agents/sdk';
import { StyrModelProvider } from '@carloscortezcloud/styrr-strands';

function mockRouter(events: any[]) {
  return {
    stream: vi.fn((_messages: any, _options?: any) => {
      async function* gen(): any {
        for (const e of events) yield e;
      }
      return gen();
    }),
  };
}

async function collectEvents(gen: any): Promise<any[]> {
  const events: any[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeProvider() {
  const provider = new StyrModelProvider({
    models: [{ id: 'test-model' }],
    apiKey: 'test-key',
  });
  return provider as any;
}

describe('StyrModelProvider', () => {
  it('emits correct text lifecycle for a simple response', async () => {
    const provider = makeProvider();
    provider.router = mockRouter([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'done', modelUsed: 'openai/gpt-4o-mini', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    ]);

    const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })];
    const events = await collectEvents(provider.stream(messages));

    expect(events[0]).toEqual({ type: 'modelMessageStartEvent', role: 'assistant' });
    expect(events[1]).toEqual({ type: 'modelContentBlockStartEvent', start: undefined });
    expect(events[2]).toEqual({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hello' } });
    expect(events[3]).toEqual({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: ' world' } });
    expect(events[4]).toEqual({ type: 'modelContentBlockStopEvent' });
    expect(events[5]).toEqual({ type: 'modelMessageStopEvent', stopReason: 'endTurn' });
    expect(events[6]).toEqual({
      type: 'modelMetadataEvent',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it('emits tool use lifecycle when tool_calls are returned', async () => {
    const provider = makeProvider();
    provider.router = mockRouter([
      { type: 'text_delta', text: 'Let me check' },
      { type: 'tool_call_start', toolCall: { id: 'call_1', name: 'get_weather', arguments: null } },
      { type: 'tool_call_done', toolCall: { id: 'call_1', name: 'get_weather', arguments: { location: 'Paris' } } },
      { type: 'text_delta', text: 'Done.' },
      { type: 'done', modelUsed: 'openai/gpt-4o-mini' },
    ]);

    const messages = [new Message({ role: 'user', content: [new TextBlock('Weather?')] })];
    const events = await collectEvents(provider.stream(messages));

    expect(events[0]).toEqual({ type: 'modelMessageStartEvent', role: 'assistant' });
    expect(events[1]).toEqual({ type: 'modelContentBlockStartEvent', start: undefined });
    expect(events[2]).toEqual({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Let me check' } });
    expect(events[3]).toEqual({ type: 'modelContentBlockStopEvent' });
    expect(events[4]).toMatchObject({
      type: 'modelContentBlockStartEvent',
      start: { type: 'toolUseStart', toolUseId: 'call_1', name: 'get_weather' },
    });
    expect(events[5]).toEqual({ type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{"location":"Paris"}' } });
    expect(events[6]).toEqual({ type: 'modelContentBlockStopEvent' });
    expect(events[7]).toEqual({ type: 'modelContentBlockStartEvent', start: undefined });
    expect(events[8]).toEqual({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Done.' } });
    expect(events[9]).toEqual({ type: 'modelContentBlockStopEvent' });
    expect(events[10]).toEqual({ type: 'modelMessageStopEvent', stopReason: 'endTurn' });
    expect(events[11]).toEqual({ type: 'modelMetadataEvent', usage: undefined });
  });

  it('emits error event when Styrr stream errors', async () => {
    const provider = makeProvider();
    provider.router = mockRouter([
      { type: 'text_delta', text: 'Partial' },
      { type: 'error', error: 'Model crashed' },
    ]);

    const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })];
    const events = await collectEvents(provider.stream(messages));

    expect(events[0]).toEqual({ type: 'modelMessageStartEvent', role: 'assistant' });
    expect(events[1]).toEqual({ type: 'modelContentBlockStartEvent', start: undefined });
    expect(events[2]).toEqual({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Partial' } });
    expect(events[3]).toEqual({ type: 'modelContentBlockStopEvent' });
    expect(events[4]).toEqual({ type: 'modelMessageStopEvent', stopReason: 'endTurn' });
  });

  it('passes tools from StreamOptions to StyrRouter', async () => {
    const mockStream = vi.fn((_messages: any, _options?: any) => {
      async function* gen(): any {
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', modelUsed: 'test' };
      }
      return gen();
    });

    const provider = makeProvider();
    provider.router = { stream: mockStream };

    const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })];
    await collectEvents(provider.stream(messages, {
      toolSpecs: [{ name: 'get_time', description: 'Get current time', inputSchema: { type: 'object', properties: {} } }],
    }));

    expect(mockStream).toHaveBeenCalledTimes(1);
    const callArgs = mockStream.mock.calls[0];
    const options = callArgs[1];
    expect(options.tools).toHaveLength(1);
    expect(options.tools[0].function.name).toBe('get_time');
  });

  it('updateConfig replaces the router config', () => {
    const provider = new StyrModelProvider({
      models: [{ id: 'first-model' }],
      apiKey: 'key1',
    }) as any;

    provider.updateConfig({
      models: [{ id: 'second-model' }],
      apiKey: 'key2',
    });

    const config = provider.getConfig();
    expect(config.models[0].id).toBe('second-model');
    expect(config.apiKey).toBe('key2');
  });

  it('modelId returns the first model ID', () => {
    const provider = new StyrModelProvider({
      models: [{ id: 'openai/gpt-4o-mini' }, { id: 'nvidia/fallback' }],
      apiKey: 'test-key',
    });
    expect(provider.modelId).toBe('openai/gpt-4o-mini');
  });

  it('modelId returns undefined when models array is empty', () => {
    const provider = new StyrModelProvider({
      models: [],
      apiKey: 'test-key',
    });
    expect(provider.modelId).toBeUndefined();
  });
});
