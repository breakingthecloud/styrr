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
  /** Routing strategy for model ordering (default: 'fallback' = config order). SoW-OSS-004 D3 */
  strategy?: RoutingStrategy;
  /** Ms a repeatedly-failing model stays demoted to the end of the list (default: 30000). SoW-OSS-004 D2 */
  demotionPenaltyMs?: number;
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
  /** Override routing strategy for this call */
  strategy?: RoutingStrategy;
}

import { getProviderForModel } from './providers/index.js';
import type { ProviderCallParams } from './providers/index.js';
import type { StyrStreamEvent } from './stream.js';
import { selectByStrategy, fitsContext } from './pricing.js';
import type { RoutingStrategy } from './pricing.js';
import { sanitizeMessages, toWireToolCall, isArgumentsValidationError } from './sanitize.js';

export class StyrRouter {
  private config: Required<Pick<StyrConfig, 'baseUrl' | 'maxRetriesPerModel' | 'timeoutMs'>> & StyrConfig;
  /** In-memory demotion state: modelId → consecutive failures + dead-until timestamp (SoW-OSS-004 D2) */
  private demotion = new Map<string, { failures: number; deadUntil: number }>();

  constructor(config: StyrConfig) {
    this.config = {
      baseUrl: 'https://openrouter.ai/api/v1',
      maxRetriesPerModel: 1,
      timeoutMs: 30000,
      ...config,
    };
  }

  /**
   * Report a provider failure for a model (429/5xx). After 2 consecutive
   * failures the model is demoted to the end of the rotation for
   * `demotionPenaltyMs` (default 30s), then returns to its position.
   */
  reportFailure(modelId: string, _reason?: string): void {
    const entry = this.demotion.get(modelId) ?? { failures: 0, deadUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= 2) {
      entry.deadUntil = Date.now() + (this.config.demotionPenaltyMs ?? 30000);
    }
    this.demotion.set(modelId, entry);
  }

  /** Report a success — resets the model's failure counter and demotion. */
  reportSuccess(modelId: string): void {
    this.demotion.delete(modelId);
  }

  /**
   * Order models by strategy (SoW-OSS-004 D3) and move demoted (dead) models
   * to the end — they remain as last-resort fallbacks.
   */
  private orderedModels(strategy: RoutingStrategy, inputChars: number): StyrModel[] {
    const ids = this.config.models.map(m => m.id);
    let sorted = selectByStrategy(ids, strategy, inputChars);

    const fitting = sorted.filter(id => fitsContext(id, inputChars));
    if (fitting.length > 0) sorted = fitting;

    const now = Date.now();
    const alive: string[] = [];
    const dead: string[] = [];
    for (const id of sorted) {
      const d = this.demotion.get(id);
      if (d && d.deadUntil > now) dead.push(id);
      else alive.push(id);
    }

    const byId = new Map(this.config.models.map(m => [m.id, m]));
    return [...alive, ...dead]
      .map(id => byId.get(id))
      .filter((m): m is StyrModel => m !== undefined);
  }

  async call(messages: StyrMessage[], options?: StyrCallOptions): Promise<StyrResponse> {
    const errors: { model: string; error: string }[] = [];
    const strategy = options?.strategy ?? this.config.strategy ?? 'fallback';
    const inputChars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
    const models = this.orderedModels(strategy, inputChars);
    let workingMessages: StyrMessage[] = messages;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      let sanitizedRetried = false;

      for (let retry = 0; retry <= this.config.maxRetriesPerModel; retry++) {
        try {
          const result = await this.callModel(model, workingMessages, options);
          this.reportSuccess(model.id);
          return { ...result, fallbacksTried: i };
        } catch (err: any) {
          const status = err.status || 0;
          const errorMsg = err.message || 'Unknown error';

          if (status === 401) {
            throw new Error(`Styrr: Auth/validation error on ${model.id}: ${errorMsg}`);
          }

          if (status === 400 && isArgumentsValidationError(status, errorMsg)) {
            // Recoverable (SoW-OSS-003 D2): sanitize tool_call arguments and retry once,
            // then treat as fallback-worthy instead of fatal.
            if (!sanitizedRetried) {
              sanitizedRetried = true;
              workingMessages = sanitizeMessages(workingMessages);
              retry--; // sanitized retry doesn't consume the retry budget
              continue;
            }
            errors.push({ model: model.id, error: `400: ${errorMsg}` });
            if (this.config.onFallback && i < models.length - 1) {
              this.config.onFallback(model.id, errorMsg, models[i + 1].id);
            }
            break;
          }

          if (status === 400) {
            throw new Error(`Styrr: Auth/validation error on ${model.id}: ${errorMsg}`);
          }

          if (status === 429 || status === 404 || status >= 500) {
            this.reportFailure(model.id, `${status}: ${errorMsg}`);
            errors.push({ model: model.id, error: `${status}: ${errorMsg}` });

            if (this.config.onFallback && i < models.length - 1) {
              this.config.onFallback(model.id, errorMsg, models[i + 1].id);
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
    throw new Error(`Styrr: All ${models.length} models failed. Errors: ${JSON.stringify(errors)}`);
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
    const strategy = options?.strategy ?? this.config.strategy ?? 'fallback';
    const inputChars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
    const models = this.orderedModels(strategy, inputChars);
    let workingMessages: StyrMessage[] = messages;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      let lastError = '';
      let sanitizedRetried = false;

      for (let retry = 0; retry <= this.config.maxRetriesPerModel; retry++) {
        try {
          yield* this.streamModel(model, workingMessages, options);
          this.reportSuccess(model.id);
          return;
        } catch (err: any) {
          const status = err.status || 0;
          lastError = err.message || 'Unknown error';

          if (status === 401) {
            yield { type: 'error', error: `Auth/validation error on ${model.id}: ${lastError}` };
            return;
          }

          if (status === 400 && isArgumentsValidationError(status, lastError)) {
            // Recoverable (SoW-OSS-003 D2): sanitize tool_call arguments and retry once,
            // then fall to the next model before emitting a final error.
            if (!sanitizedRetried) {
              sanitizedRetried = true;
              workingMessages = sanitizeMessages(workingMessages);
              retry--; // sanitized retry doesn't consume the retry budget
              continue;
            }
            errors.push({ model: model.id, error: `400: ${lastError}` });
            if (this.config.onFallback && i < models.length - 1) {
              this.config.onFallback(model.id, lastError, models[i + 1].id);
            }
            break;
          }

          if (status === 400) {
            yield { type: 'error', error: `Auth/validation error on ${model.id}: ${lastError}` };
            return;
          }

          if (status === 429 || status === 404 || status >= 500) {
            this.reportFailure(model.id, `${status}: ${lastError}`);
            errors.push({ model: model.id, error: `${status}: ${lastError}` });

            if (this.config.onFallback && i < models.length - 1) {
              this.config.onFallback(model.id, lastError, models[i + 1].id);
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
    yield { type: 'error', error: `All ${models.length} models failed. Errors: ${JSON.stringify(errors)}` };
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
        // SoW-OSS-003: arguments always serialized as a valid JSON object string
        msg.tool_calls = toolCalls.map(toWireToolCall);
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
        // SoW-OSS-003: arguments always serialized as a valid JSON object string
        msg.tool_calls = toolCalls.map(toWireToolCall);
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

export { discoverFreeModels, lastResortModels, recommendToolsFirst } from './discovery.js';
export type { DiscoveredModel, DiscoveryResult, DiscoveryOptions, OpenRouterModel, RecommendOptions, RecommendResult } from './discovery.js';
export { sanitizeToolCall, safeArguments, sanitizeMessages, toPlainObject, toWireToolCall, isArgumentsValidationError } from './sanitize.js';
export type { SanitizedToolCall } from './sanitize.js';
export type { StyrStreamEvent, StyrStreamUsage } from './stream.js';
export { parseSSEStream, openAIStreamToEvents } from './stream.js';
