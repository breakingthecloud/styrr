export interface StyrStreamUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type StyrStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; toolCall: { id: string; name: string; arguments: any } }
  | { type: 'tool_call_done'; toolCall: { id: string; name: string; arguments: any } }
  | { type: 'done'; modelUsed: string; usage?: StyrStreamUsage }
  | { type: 'error'; error: string };

export async function* parseSSEStream(response: Response): AsyncGenerator<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body for streaming');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch {
          // skip malformed lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* openAIStreamToEvents(response: Response, modelId: string): AsyncGenerator<StyrStreamEvent> {
  const toolCalls = new Map<number, { id: string; name: string; args: string[] }>();
  let usage: StyrStreamUsage | undefined;

  for await (const chunk of parseSSEStream(response)) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta || {};

    if (delta.content) {
      yield { type: 'text_delta', text: delta.content };
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls.has(idx)) {
          const id = tc.id || `call_${idx}`;
          const name = tc.function?.name || '';
          toolCalls.set(idx, { id, name, args: [] });
          yield { type: 'tool_call_start', toolCall: { id, name, arguments: null } };
        }
        if (tc.function?.arguments) {
          toolCalls.get(idx)!.args.push(tc.function.arguments);
        }
      }
    }

    if (choice.finish_reason === 'tool_calls') {
      for (const [, tc] of toolCalls) {
        const fullArgs = tc.args.join('');
        const parsed = tryParseJSON(fullArgs);
        yield {
          type: 'tool_call_done',
          toolCall: { id: tc.id, name: tc.name, arguments: parsed !== undefined ? parsed : fullArgs },
        };
      }
      toolCalls.clear();
    }

    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      };
    }
  }

  yield { type: 'done', modelUsed: modelId, usage };
}

function tryParseJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
