/**
 * Styrr — Minimal LLM Router with Multi-Model Fallback
 *
 * Zero dependencies. Works in CF Workers, Lambda, Node.js, Deno.
 * Extracted from Remo OSS (remo-api/services/llm-router.ts).
 *
 * Usage:
 *   import { StyrRouter } from 'styrr';
 *   const router = new StyrRouter({ models: [...], apiKey: '...' });
 *   const result = await router.call(messages);
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface StyrModel {
  /** Model ID (e.g., "nvidia/nemotron-3-super-120b:free") */
  id: string;
  /** Provider identifier for URL/auth routing */
  provider?: 'openrouter' | 'openai' | 'bedrock' | 'nvidia' | 'huggingface' | 'ollama' | 'custom';
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
  /** Default API key (OpenRouter format) */
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
}

// ─── Router ─────────────────────────────────────────────────────────────

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

  /**
   * Route a message through the model chain.
   * Tries each model in order. Falls back on 429 (rate limit) or 5xx.
   * Fails fast on 401/400 (auth/validation — won't retry with different model).
   */
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

          // Auth/validation errors: fail fast (don't try other models)
          if (status === 401 || status === 400) {
            throw new Error(`Styrr: Auth/validation error on ${model.id}: ${errorMsg}`);
          }

          // Rate limit or server error: try next model
          if (status === 429 || status === 404 || status >= 500) {
            errors.push({ model: model.id, error: `${status}: ${errorMsg}` });

            // Notify fallback callback
            if (this.config.onFallback && i < this.config.models.length - 1) {
              this.config.onFallback(model.id, errorMsg, this.config.models[i + 1].id);
            }
            break; // move to next model
          }

          // Unknown error on last retry: move to next model
          if (retry === this.config.maxRetriesPerModel) {
            errors.push({ model: model.id, error: errorMsg });
            break;
          }
        }
      }
    }

    // All models failed
    if (this.config.onAllFailed) {
      this.config.onAllFailed(errors);
    }
    throw new Error(`Styrr: All ${this.config.models.length} models failed. Errors: ${JSON.stringify(errors)}`);
  }

  /**
   * Convenience: single prompt (wraps in system + user messages)
   */
  async prompt(userMessage: string, systemPrompt?: string, options?: StyrCallOptions): Promise<StyrResponse> {
    const messages: StyrMessage[] = [];
    if (systemPrompt || options?.systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt || options!.systemPrompt! });
    }
    messages.push({ role: 'user', content: userMessage });
    return this.call(messages, options);
  }

  // ─── Private ────────────────────────────────────────────────────────

  private async callModel(model: StyrModel, messages: StyrMessage[], options?: StyrCallOptions): Promise<Omit<StyrResponse, 'fallbacksTried'>> {
    const baseUrl = model.baseUrl || this.config.baseUrl;
    const apiKey = model.apiKey || this.config.apiKey;
    const timeout = model.timeoutMs || this.config.timeoutMs;

    // Normalize messages: convert camelCase (Tinkuy) → snake_case (API)
    const normalizedMessages = messages.map(m => {
      const msg: any = { role: m.role, content: m.content };
      // Handle tool_call_id (snake or camel)
      const toolCallId = m.tool_call_id || (m as any).toolCallId;
      if (toolCallId) msg.tool_call_id = toolCallId;
      // Handle tool_calls on assistant messages
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

    const body: any = {
      model: model.id,
      messages: normalizedMessages,
      max_tokens: options?.maxTokens || model.maxTokens || 4096,
      temperature: options?.temperature ?? 0.7,
    };

    if (options?.tools?.length) {
      body.tools = options.tools;
    }

    if (options?.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const start = Date.now();

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      const err: any = new Error(`${response.status}: ${errBody.slice(0, 200)}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;

    const choice = data.choices?.[0];
    const text = choice?.message?.content || '';
    const toolCalls = choice?.message?.tool_calls?.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: tryParseJSON(tc.function?.arguments),
    }));

    // Try parsing as JSON
    const parsed = tryParseJSON(text);

    return {
      text,
      parsed: parsed !== undefined ? parsed : undefined,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      modelUsed: model.id,
      latencyMs,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function tryParseJSON(text: string | undefined): any {
  if (!text) return undefined;
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}
