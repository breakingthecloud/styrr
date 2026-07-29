import { Model, type BaseModelConfig, type StreamOptions, type Message } from '@strands-agents/sdk';
import type { ModelStreamEvent } from '@strands-agents/sdk';
import { StyrRouter, type StyrModel } from '@carloscortezcloud/styrr-llm';
import { messagesToStyrr, toolSpecsToStyrr, systemPromptToText } from './mappers.js';

export interface StyrModelProviderConfig extends BaseModelConfig {
  models: StyrModel[];
  apiKey: string;
  baseUrl?: string;
  onFallback?: (modelId: string, error: string, nextModelId: string) => void;
}

export class StyrModelProvider extends Model<StyrModelProviderConfig> {
  private _config: StyrModelProviderConfig;
  private router: StyrRouter;

  constructor(config: StyrModelProviderConfig) {
    super();
    this._config = { ...config };
    this.router = createRouter(config);
  }

  updateConfig(modelConfig: StyrModelProviderConfig): void {
    this._config = { ...this._config, ...modelConfig };
    this.router = createRouter(this._config);
  }

  getConfig(): StyrModelProviderConfig {
    return { ...this._config };
  }

  get modelId(): string | undefined {
    return this._config.models[0]?.id;
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const systemText = options?.systemPrompt ? systemPromptToText(options.systemPrompt) : undefined;
    const styrrMessages = messagesToStyrr(messages, systemText);

    const tools = options?.toolSpecs?.length ? toolSpecsToStyrr(options.toolSpecs) : undefined;

    yield { type: 'modelMessageStartEvent', role: 'assistant' };

    let hasOpenBlock = false;
    let toolAccum: { id: string; name: string } | null = null;

    for await (const event of this.router.stream(styrrMessages, { tools })) {
      switch (event.type) {
        case 'text_delta':
          if (!hasOpenBlock) {
            yield { type: 'modelContentBlockStartEvent', start: undefined };
            hasOpenBlock = true;
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: event.text },
          };
          break;

        case 'tool_call_start':
          if (hasOpenBlock) {
            yield { type: 'modelContentBlockStopEvent' };
            hasOpenBlock = false;
          }
          toolAccum = { id: event.toolCall.id, name: event.toolCall.name };
          yield {
            type: 'modelContentBlockStartEvent',
            start: {
              type: 'toolUseStart',
              toolUseId: event.toolCall.id,
              name: event.toolCall.name,
            },
          };
          hasOpenBlock = true;
          break;

        case 'tool_call_done':
          if (toolAccum) {
            const args = typeof event.toolCall.arguments === 'string'
              ? event.toolCall.arguments
              : JSON.stringify(event.toolCall.arguments);
            yield {
              type: 'modelContentBlockDeltaEvent',
              delta: { type: 'toolUseInputDelta', input: args },
            };
            yield { type: 'modelContentBlockStopEvent' };
            hasOpenBlock = false;
            toolAccum = null;
          }
          break;

        case 'done':
          if (hasOpenBlock) {
            yield { type: 'modelContentBlockStopEvent' };
          }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
          yield {
            type: 'modelMetadataEvent',
            usage: event.usage
              ? {
                  inputTokens: event.usage.promptTokens ?? 0,
                  outputTokens: event.usage.completionTokens ?? 0,
                  totalTokens: event.usage.totalTokens ?? 0,
                }
              : undefined,
          };
          return;

        case 'error':
          if (hasOpenBlock) {
            yield { type: 'modelContentBlockStopEvent' };
          }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
          return;
      }
    }

    if (hasOpenBlock) {
      yield { type: 'modelContentBlockStopEvent' };
    }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function createRouter(config: StyrModelProviderConfig): StyrRouter {
  return new StyrRouter({
    models: config.models,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    onFallback: config.onFallback,
  });
}
