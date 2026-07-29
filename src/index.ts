export interface StyrModel {
  /** Model ID (e.g., "nvidia/nemotron-3-super-120b:free") */
  id: string;
  /** Provider identifier for URL/auth routing */
  provider?: 'openrouter' | 'openai' | 'bedrock' | 'nvidia' | 'huggingface' | 'ollama' | 'custom' | string;
  /** Base URL override (default: OpenRouter) */
  baseUrl?: string;
  /** API key override (uses router-level key if not set) */
  apiKey?: string;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Max output tokens (default: 4096) */
  maxTokens?: number;
}

export interface StyrMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

export interface StyrToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface StyrConfig {
  /** Ordered list of models — first is primary, rest are fallbacks */
  models: StyrModel[];
  /** Default API key */
  apiKey: string;
  /** Default base URL (default: https://openrouter.ai/api/v1) */
  baseUrl?: string;
  /** Max retries per model before falling to next (default: 1) */
  maxRetriesPerModel?: number;
  /** Global timeout override (default: 30000ms) */
  timeoutMs?: number;
  /** Called on each fallback (for logging/observability) */
  onFallback?: (modelId: string, error: string, nextModelId: string) => void;
  /** Called on final failure (all models exhausted) */
  onAllFailed?: (errors: { model: string; error: string }[]) => void;
}

export interface StyrResponse {
  /** Generated text content */
  text: string;
  /** Parsed JSON (if response is valid JSON) */
  parsed?: any;
  /** Tool calls (if model returned tool_use) */
  toolCalls?: { id: string; name: string; arguments: any }[];
  /** Which model actually responded */
  modelUsed: string;
  /** Total latency in ms */
  latencyMs: number;
  /** How many models were tried before success */
  fallbacksTried: number;
  /** Raw response headers (for token counting if available) */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface StyrCallOptions {
  /** Override system prompt for this call */
  systemPrompt?: string;
  /** Tool schemas (enables tool_use/function_calling) */
  tools?: StyrToolSchema[];
  /** Force JSON response format */
  responseFormat?: 'json' | 'text';
  /** Temperature (0-2) */
  temperature?: number;
  /** Max tokens for this call */
  maxTokens?: number;
  /** Override API key for this call */
  apiKey?: string;
  /** Override base URL for this call */
  baseUrl?: string;
}

import { getProviderForModel } from './providers/index.js';
import type { ProviderCallParams } from './providers/index.js';
import type { StyrStreamEvent } from './stream.js';

export class StyrRouter {
  private config: Required<Pick<StyrConfig, 'baseUrl' | 'maxRetriesPerModel' | 'timeoutMs'>> & StyrConfig;

  constructor(config: StyrConfig) {
    this.config = {
      baseUrl: 'https://openrouter.ai/api/v1',
      maxRetriesPerModel: 1,
      timeoutMs: 30000,
      ...config,
    };
  }

  async call(messages: StyrMessage[], options?: StyrCallOptions): Promise<StyrResponse> {
    const errors: { model: string; error: string }[] = [];

    for (let i = 0; i < this.config.models.length; i++) {
      const model = this.config.models[i];

      for (let retry = 0; retry <= this.config.maxRetriesPerModel; retry++) {
        try {
          const result = await this.callModel(model, messages, options);
          return { ...result, fallbacksTried: i };
        } catch (err: any) {
          const status = err.status || 0;
          const errorMsg = err.message || 'Unknown error';

          if (status === 401 || status === 400) {
            throw new Error(`Styrr: Auth/validation error on ${model.id}: ${errorMsg}`);
          }

          if (status === 429 || status === 404 || status >= 500) {
            errors.push({ model: model.id, error: `${status}: ${errorMsg}` });

            if (this.config.onFallback && i < this.config.models.length - 1) {
              this.config.onFallback(model.id, errorMsg, this.config.models[i + 1].id);
            }
            break;
          }

          if (retry === this.config.maxRetriesPerModel) {
            errors.push({ model: model.id, error: errorMsg });
            break;
          }
        }
      }
    }

    if (this.config.onAllFailed) {
      this.config.onAllFailed(errors);
    }
    throw new Error(`Styrr: All ${this.config.models.length} models failed. Errors: ${JSON.stringify(errors)}`);
  }

  async prompt(userMessage: string, systemPrompt?: string, options?: StyrCallOptions): Promise<StyrResponse> {
    const messages: StyrMessage[] = [];
    if (systemPrompt || options?.systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt || options!.systemPrompt! });
    }
    messages.push({ role: 'user', content: userMessage });
    return this.call(messages, options);
  }

  async *stream(messages: StyrMessage[], options?: StyrCallOptions): AsyncGenerator<StyrStreamEvent> {
    const errors: { model: string; error: string }[] = [];

    for (let i = 0; i < this.config.models.length; i++) {
      const model = this.config.models[i];
      let lastError = '';

      for (let retry = 0; retry <= this.config.maxRetriesPerModel; retry++) {
        try {
          yield* this.streamModel(model, messages, options);
          return;
        } catch (err: any) {
          const status = err.status || 0;
          lastError = err.message || 'Unknown error';

          if (status === 401 || status === 400) {
            yield { type: 'error', error: `Auth/validation error on ${model.id}: ${lastError}` };
            return;
          }

          if (status === 429 || status === 404 || status >= 500) {
            errors.push({ model: model.id, error: `${status}: ${lastError}` });

            if (this.config.onFallback && i < this.config.models.length - 1) {
              this.config.onFallback(model.id, lastError, this.config.models[i + 1].id);
            }
            break;
          }

          if (retry === this.config.maxRetriesPerModel) {
            errors.push({ model: model.id, error: lastError });
            break;
          }
        }
      }
    }

    if (this.config.onAllFailed) {
      this.config.onAllFailed(errors);
    }
    yield { type: 'error', error: `All ${this.config.models.length} models failed. Errors: ${JSON.stringify(errors)}` };
  }

  private async *streamModel(model: StyrModel, messages: StyrMessage[], options?: StyrCallOptions): AsyncGenerator<StyrStreamEvent> {
    const provider = getProviderForModel(model);
    const apiKey = options?.apiKey || model.apiKey || this.config.apiKey;
    const baseUrl = options?.baseUrl || model.baseUrl || this.config.baseUrl;
    const timeout = model.timeoutMs || this.config.timeoutMs;

    const normalizedMessages = messages.map(m => {
      const msg: any = { role: m.role, content: m.content };
      const toolCallId = m.tool_call_id || (m as any).toolCallId;
      if (toolCallId) msg.tool_call_id = toolCallId;
      const toolCalls = (m as any).tool_calls || (m as any).toolCalls;
      if (toolCalls?.length) {
        msg.tool_calls = toolCalls.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name || tc.function?.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || tc.function?.arguments || {}),
          },
        }));
      }
      return msg;
    });

    const params: ProviderCallParams = {
      model: model.id,
      messages: normalizedMessages,
      maxTokens: options?.maxTokens || model.maxTokens || 4096,
      temperature: options?.temperature ?? 0.7,
      responseFormat: options?.responseFormat,
      tools: options?.tools,
      apiKey,
      baseUrl,
      signal: AbortSignal.timeout(timeout),
    };

    yield* provider.stream(params);
  }

  private async callModel(model: StyrModel, messages: StyrMessage[], options?: StyrCallOptions): Promise<Omit<StyrResponse, 'fallbacksTried'>> {
    const provider = getProviderForModel(model);
    const apiKey = options?.apiKey || model.apiKey || this.config.apiKey;
    const baseUrl = options?.baseUrl || model.baseUrl || this.config.baseUrl;
    const timeout = model.timeoutMs || this.config.timeoutMs;

    const normalizedMessages = messages.map(m => {
      const msg: any = { role: m.role, content: m.content };
      const toolCallId = m.tool_call_id || (m as any).toolCallId;
      if (toolCallId) msg.tool_call_id = toolCallId;
      const toolCalls = (m as any).tool_calls || (m as any).toolCalls;
      if (toolCalls?.length) {
        msg.tool_calls = toolCalls.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name || tc.function?.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || tc.function?.arguments || {}),
          },
        }));
      }
      return msg;
    });

    const params: ProviderCallParams = {
      model: model.id,
      messages: normalizedMessages,
      maxTokens: options?.maxTokens || model.maxTokens || 4096,
      temperature: options?.temperature ?? 0.7,
      responseFormat: options?.responseFormat,
      tools: options?.tools,
      apiKey,
      baseUrl,
      signal: AbortSignal.timeout(timeout),
    };

    const start = Date.now();

    const result = await provider.call(params);

    const latencyMs = Date.now() - start;
    const text = result.text;
    const parsed = tryParseJSON(text);

    return {
      text,
      parsed: parsed !== undefined ? parsed : undefined,
      toolCalls: result.toolCalls,
      modelUsed: model.id,
      latencyMs,
      usage: result.usage,
    };
  }
}

function tryParseJSON(text: string | undefined): any {
  if (!text) return undefined;
  try {
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

export { estimateCost, findPricing, selectByStrategy, fitsContext, MODEL_PRICING } from './pricing.js';
export type { ModelPricing, RoutingStrategy } from './pricing.js';

export { getProviderForModel } from './providers/index.js';
export { OpenAICompatProvider, BedrockProvider, HuggingFaceProvider } from './providers/index.js';
export type { StyrProvider } from './providers/index.js';

export { discoverFreeModels, lastResortModels } from './discovery.js';
export type { DiscoveredModel, DiscoveryResult, DiscoveryOptions, OpenRouterModel } from './discovery.js';
export type { StyrStreamEvent, StyrStreamUsage } from './stream.js';
export { parseSSEStream, openAIStreamToEvents } from './stream.js';
