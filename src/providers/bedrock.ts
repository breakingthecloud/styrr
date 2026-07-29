import type { StyrProvider, ProviderCallParams, ProviderCallResponse } from './base.js';
import type { StyrStreamEvent, StyrStreamUsage } from '../stream.js';

export class BedrockProvider implements StyrProvider {
  readonly name = 'bedrock';

  async call(params: ProviderCallParams): Promise<ProviderCallResponse> {
    const { model, messages, maxTokens, temperature, tools, signal } = params;
    const region = params.baseUrl || 'us-east-1';

    let BedrockRuntimeClient: any;
    let ConverseCommand: any;
    let ConverseStreamCommand: any;
    try {
      const mod = await import('@aws-sdk/client-bedrock-runtime');
      BedrockRuntimeClient = mod.BedrockRuntimeClient;
      ConverseCommand = mod.ConverseCommand;
      ConverseStreamCommand = mod.ConverseStreamCommand;
    } catch {
      throw new Error(
        'BedrockProvider requires @aws-sdk/client-bedrock-runtime. Install with: npm install @aws-sdk/client-bedrock-runtime'
      );
    }

    const modelId = mapModelId(model);

    const systemMessages: { text: string }[] = [];
    const converseMessages: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push({ text: msg.content });
      } else if (msg.role === 'user') {
        converseMessages.push({ role: 'user', content: [{ text: msg.content }] });
      } else if (msg.role === 'assistant') {
        const content: any[] = [];
        if (msg.content) content.push({ text: msg.content });
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            content.push({
              toolUse: {
                toolUseId: tc.id,
                name: tc.name || tc.function?.name,
                input: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments || {}),
              },
            });
          }
        }
        converseMessages.push({ role: 'assistant', content });
      } else if (msg.role === 'tool') {
        converseMessages.push({
          role: 'user',
          content: [{
            toolResult: {
              toolUseId: msg.tool_call_id || '',
              content: [{ text: msg.content }],
              status: 'success',
            },
          }],
        });
      }
    }

    const input: any = {
      modelId,
      messages: converseMessages,
      inferenceConfig: {
        maxTokens: maxTokens ?? 4096,
        temperature: temperature ?? 0.7,
      },
    };

    if (systemMessages.length > 0) input.system = systemMessages;

    if (tools?.length) {
      input.toolConfig = {
        tools: tools.map(t => ({
          toolSpec: {
            name: t.function.name,
            description: t.function.description,
            inputSchema: { json: t.function.parameters },
          },
        })),
      };
    }

    const client = new BedrockRuntimeClient({ region });
    const command = new ConverseCommand(input);
    const data = await client.send(command);

    const output = data.output?.message;
    const text = output?.content?.find((c: any) => c.text)?.text || '';
    const toolBlocks = output?.content?.filter((c: any) => c.toolUse) || [];

    const toolCalls = toolBlocks.map((tb: any) => ({
      id: tb.toolUse.toolUseId,
      name: tb.toolUse.name,
      arguments: tb.toolUse.input,
    }));

    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.usage ? {
        promptTokens: data.usage.inputTokens,
        completionTokens: data.usage.outputTokens,
        totalTokens: (data.usage.inputTokens || 0) + (data.usage.outputTokens || 0),
      } : undefined,
    };
  }

  async *stream(params: ProviderCallParams): AsyncGenerator<StyrStreamEvent> {
    const { model, messages, maxTokens, temperature, tools, signal } = params;
    const region = params.baseUrl || 'us-east-1';

    let BedrockRuntimeClient: any;
    let ConverseStreamCommand: any;
    try {
      const mod = await import('@aws-sdk/client-bedrock-runtime');
      BedrockRuntimeClient = mod.BedrockRuntimeClient;
      ConverseStreamCommand = mod.ConverseStreamCommand;
    } catch {
      throw new Error(
        'BedrockProvider requires @aws-sdk/client-bedrock-runtime. Install with: npm install @aws-sdk/client-bedrock-runtime'
      );
    }

    const modelId = mapModelId(model);

    const systemMessages: { text: string }[] = [];
    const converseMessages: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push({ text: msg.content });
      } else if (msg.role === 'user') {
        converseMessages.push({ role: 'user', content: [{ text: msg.content }] });
      } else if (msg.role === 'assistant') {
        const content: any[] = [];
        if (msg.content) content.push({ text: msg.content });
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            content.push({
              toolUse: {
                toolUseId: tc.id,
                name: tc.name || tc.function?.name,
                input: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments || {}),
              },
            });
          }
        }
        converseMessages.push({ role: 'assistant', content });
      } else if (msg.role === 'tool') {
        converseMessages.push({
          role: 'user',
          content: [{
            toolResult: {
              toolUseId: msg.tool_call_id || '',
              content: [{ text: msg.content }],
              status: 'success',
            },
          }],
        });
      }
    }

    const input: any = {
      modelId,
      messages: converseMessages,
      inferenceConfig: {
        maxTokens: maxTokens ?? 4096,
        temperature: temperature ?? 0.7,
      },
    };

    if (systemMessages.length > 0) input.system = systemMessages;

    if (tools?.length) {
      input.toolConfig = {
        tools: tools.map(t => ({
          toolSpec: {
            name: t.function.name,
            description: t.function.description,
            inputSchema: { json: t.function.parameters },
          },
        })),
      };
    }

    const client = new BedrockRuntimeClient({ region });
    const command = new ConverseStreamCommand(input);
    const response = await client.send(command);

    const toolCalls = new Map<number, { id: string; name: string; args: string[] }>();
    let usage: StyrStreamUsage | undefined;

    for await (const event of response.stream as AsyncIterable<any>) {
      if (event.contentBlockDelta) {
        const delta = event.contentBlockDelta.delta;
        if (delta?.text) {
          yield { type: 'text_delta', text: delta.text };
        }
        if (delta?.toolUse?.input) {
          const idx = event.contentBlockDelta.contentBlockIndex ?? 0;
          if (!toolCalls.has(idx)) {
            toolCalls.set(idx, { id: '', name: '', args: [] });
          }
          toolCalls.get(idx)!.args.push(delta.toolUse.input);
        }
      }

      if (event.contentBlockStart) {
        const start = event.contentBlockStart.start;
        if (start?.toolUse) {
          const idx = event.contentBlockStart.contentBlockIndex ?? 0;
          toolCalls.set(idx, {
            id: start.toolUse.toolUseId,
            name: start.toolUse.name,
            args: [],
          });
          yield {
            type: 'tool_call_start',
            toolCall: { id: start.toolUse.toolUseId, name: start.toolUse.name, arguments: null },
          };
        }
      }

      if (event.messageStop) {
        for (const [, tc] of toolCalls) {
          const fullArgs = tc.args.join('');
          try {
            yield {
              type: 'tool_call_done',
              toolCall: { id: tc.id, name: tc.name, arguments: JSON.parse(fullArgs) },
            };
          } catch {
            yield {
              type: 'tool_call_done',
              toolCall: { id: tc.id, name: tc.name, arguments: fullArgs },
            };
          }
        }
        toolCalls.clear();
      }

      if (event.metadata?.usage) {
        usage = {
          promptTokens: event.metadata.usage.inputTokens,
          completionTokens: event.metadata.usage.outputTokens,
          totalTokens: (event.metadata.usage.inputTokens || 0) + (event.metadata.usage.outputTokens || 0),
        };
      }
    }

    yield { type: 'done', modelUsed: modelId, usage };
  }
}

function mapModelId(model: string): string {
  if (model.includes(':')) return model.split(':')[0];
  if (model.startsWith('anthropic/')) return model.replace('anthropic/', '');
  if (model.startsWith('meta/')) return model.replace('meta/', '');
  if (model.startsWith('mistral/')) return model.replace('mistral/', '');
  return model;
}
