export interface StyrModel {
  /** Model ID (e.g., "nvidia/nemotron-3-super-120b:free") */
  id: string;
  /** Provider identifier for URL/auth routing */
  provider?: 'openrouter' | 'opencode-go' | 'openai' | 'bedrock' | 'nvidia' | 'huggingface' | 'ollama' | 'custom' | string;
  /** Base URL override (default: OpenRouter) */
  baseUrl?: string;
  /** API key override (uses router-level key if not set) */
  apiKey?: string;
  /** Extra request headers for this model (merged over provider headers). */
  headers?: Record<string, string>;
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
  /** Default API key (legacy single-provider). Prefer `apiKeys` for multi-provider. */
  apiKey?: string;
  /** Per-provider API keys, e.g. { openrouter: env.OPENROUTER_API_KEY, 'opencode-go': env.OPENCODE_API_KEY } */
  apiKeys?: Partial<Record<string, string>>;
  /** Per-provider base URL and header overrides. */
  providers?: Partial<Record<string, { baseUrl: string; headers?: Record<string, string> }>>;
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

import { getProviderForModel, DEFAULT_PROVIDER_BASE_URLS } from './providers/index.js';
import type { ProviderCallParams } from './providers/index.js';
import type { StyrStreamEvent } from './stream.js';
import { selectByStrategy, fitsContext } from './pricing.js';
import type { RoutingStrategy } from './pricing.js';
import { sanitizeMessages, toWireToolCall, isArgumentsValidationError } from './sanitize.js';

export class StyrRouter {
  private config: Required<Pick<StyrConfig, 'baseUrl' | 'maxRetriesPerModel' | 'timeoutMs'>> & StyrConfig;
  /** In-memory demotion state: provider:model key → consecutive failures + dead-until timestamp (SoW-OSS-004 D2) */
  private demotion = new Map<string, { failures: number; deadUntil: number }>();

  constructor(config: StyrConfig) {
    this.config = {
      baseUrl: 'https://openrouter.ai/api/v1',
      maxRetriesPerModel: 1,
      timeoutMs: 30000,
      ...config,
    };
  }

  /** Canonical key — model IDs collide across providers (e.g. minimax-m3). */
  private modelKey(model: Pick<StyrModel, 'id' | 'provider'>): string {
    return model.provider ? `${model.provider}:${model.id}` : model.id;
  }

  /** Resolve the base URL for a model or provider. */
  private resolveBaseUrl(provider?: string): string {
    const p = provider || 'openrouter';
    return this.config.providers?.[p]?.baseUrl
      ?? DEFAULT_PROVIDER_BASE_URLS[p]
      ?? this.config.baseUrl;
  }

  /** Resolve the API key for a model (model override → per-provider → legacy default). */
  private resolveApiKey(model: StyrModel): string | undefined {
    if (model.apiKey) return model.apiKey;
    if (model.provider && this.config.apiKeys?.[model.provider]) {
      return this.config.apiKeys[model.provider];
    }
    return this.config.apiKey;
  }

  /** Resolve extra request headers (provider defaults → provider config → model). */
  private resolveHeaders(model: StyrModel): Record<string, string> | undefined {
    const provider = model.provider || 'openrouter';
    const headers: Record<string, string> = {
      ...(this.config.providers?.[provider]?.headers || {}),
      ...(model.headers || {}),
    };

    // OpenCode Go requires a session header for routing and blocks some default
    // User-Agents at the Cloudflare edge.
    if (provider === 'opencode-go') {
      if (!headers['x-opencode-session'] && !headers['X-Opencode-Session']) {
        headers['x-opencode-session'] = newSessionId();
      }
      if (!headers['User-Agent'] && !headers['user-agent']) {
        headers['User-Agent'] = 'cc-mng/0.1.0';
      }
    }

    return Object.keys(headers).length > 0 ? headers : undefined;
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
   *
   * For `fallback`, the configured order is preserved as-is (callers such as MNG
   * already pass a ranked catalog). Other strategies sort by pricing.
   */
  private orderedModels(strategy: RoutingStrategy, inputChars: number): StyrModel[] {
    let ordered: StyrModel[];

    if (strategy === 'fallback') {
      ordered = [...this.config.models];
    } else {
      const ids = this.config.models.map(m => m.id);
      const sortedIds = selectByStrategy(ids, strategy, inputChars);
      ordered = [];
      for (const id of sortedIds) {
        const matches = this.config.models.filter(m => m.id === id && !ordered.includes(m));
        ordered.push(...matches);
      }
      for (const m of this.config.models) {
        if (!ordered.includes(m)) ordered.push(m);
      }
    }

    const fitting = ordered.filter(m => fitsContext(m.id, inputChars));
    if (fitting.length > 0) ordered = fitting;

    const now = Date.now();
    const alive: StyrModel[] = [];
    const dead: StyrModel[] = [];
    for (const model of ordered) {
      const d = this.demotion.get(this.modelKey(model));
      if (d && d.deadUntil > now) dead.push(model);
      else alive.push(model);
    }

    return [...alive, ...dead];
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
          this.reportSuccess(this.modelKey(model));
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
            this.reportFailure(this.modelKey(model), `${status}: ${errorMsg}`);
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
          this.reportSuccess(this.modelKey(model));
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
            this.reportFailure(this.modelKey(model), `${status}: ${lastError}`);
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
    const apiKey = options?.apiKey || this.resolveApiKey(model);
    const baseUrl = options?.baseUrl || model.baseUrl || this.resolveBaseUrl(model.provider);
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
      headers: this.resolveHeaders(model),
      signal: AbortSignal.timeout(timeout),
    };

    yield* provider.stream(params);
  }

  private async callModel(model: StyrModel, messages: StyrMessage[], options?: StyrCallOptions): Promise<Omit<StyrResponse, 'fallbacksTried'>> {
    const provider = getProviderForModel(model);
    const apiKey = options?.apiKey || this.resolveApiKey(model);
    const baseUrl = options?.baseUrl || model.baseUrl || this.resolveBaseUrl(model.provider);
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
      headers: this.resolveHeaders(model),
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

function newSessionId(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `styrr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
export { OpenAICompatProvider, BedrockProvider, HuggingFaceProvider, DEFAULT_PROVIDER_BASE_URLS } from './providers/index.js';
export type { StyrProvider } from './providers/index.js';

export { rankCatalog, toStyrModels, buildModelChain, catalogKey, blendedCostPer1M } from './catalog.js';
export type { CatalogModel, RoutingRules } from './catalog.js';

export { discoverFreeModels, lastResortModels, recommendToolsFirst } from './discovery.js';
export type { DiscoveredModel, DiscoveryResult, DiscoveryOptions, OpenRouterModel, RecommendOptions, RecommendResult } from './discovery.js';
export { sanitizeToolCall, safeArguments, sanitizeMessages, toPlainObject, toWireToolCall, isArgumentsValidationError } from './sanitize.js';
export type { SanitizedToolCall } from './sanitize.js';
export type { StyrStreamEvent, StyrStreamUsage } from './stream.js';
export { parseSSEStream, openAIStreamToEvents } from './stream.js';
