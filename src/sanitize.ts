/**
 * Styrr Sanitize — tool_call argument safety (SoW-OSS-003)
 *
 * Guarantees that any `tool_calls[].function.arguments` forwarded to a
 * provider is ALWAYS a valid JSON object string, regardless of what the
 * model (or the calling app) produced upstream:
 * - raw broken JSON strings → `{}`
 * - arrays / scalars / null → `{}`
 * - valid JSON strings → parsed object (re-serialized on the wire)
 * - plain objects → used as-is (if serializable)
 *
 * Idempotent: sanitizing an already-sanitized tool_call yields the same
 * wire representation, so provider-level re-normalization stays safe.
 */

export interface SanitizedToolCall {
  id: string;
  name: string;
  function: { name: string; arguments: Record<string, unknown> };
}

/** Returns the value only if it is a plain object (not array, not null); else null. */
export function toPlainObject(value: any): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isSerializable(obj: Record<string, unknown>): boolean {
  try {
    JSON.stringify(obj);
    return true;
  } catch {
    return false;
  }
}

/**
 * Coerce a tool_call's arguments into a plain, JSON-serializable object.
 * Accepts both the tinkuy shape (`tc.arguments`) and the OpenAI shape
 * (`tc.function.arguments`). Never returns a non-serializable value.
 */
export function safeArguments(tc: any): Record<string, unknown> {
  const raw = tc?.arguments ?? tc?.function?.arguments;

  const direct = toPlainObject(raw);
  if (direct) return isSerializable(direct) ? direct : {};

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      const obj = toPlainObject(parsed);
      return obj && isSerializable(obj) ? obj : {};
    } catch {
      return {};
    }
  }

  return {};
}

/**
 * Normalize any tool_call shape into `{ id, name, function: { name, arguments } }`
 * with `arguments` guaranteed to be a plain serializable object.
 */
export function sanitizeToolCall(tc: any): SanitizedToolCall {
  const name = tc?.name ?? tc?.function?.name ?? '';
  const id = tc?.id ?? '';
  return { id, name, function: { name, arguments: safeArguments(tc) } };
}

/**
 * Wire format for OpenAI-compatible providers: `arguments` as a JSON string
 * that always parses to an object.
 */
export function toWireToolCall(tc: any): { id: string; type: 'function'; function: { name: string; arguments: string } } {
  const safe = sanitizeToolCall(tc);
  return {
    id: safe.id,
    type: 'function',
    function: { name: safe.name, arguments: JSON.stringify(safe.function.arguments) },
  };
}

/**
 * Return a copy of `messages` where every tool_call (`tool_calls` or
 * camelCase `toolCalls`) is normalized to sanitized wire shape.
 * Messages without tool calls pass through untouched.
 */
export function sanitizeMessages<T = any>(messages: any[]): T[] {
  return messages.map(m => {
    const toolCalls = m?.tool_calls ?? m?.toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return m;
    const copy: any = { ...m, tool_calls: toolCalls.map(toWireToolCall) };
    delete copy.toolCalls;
    return copy;
  });
}

const ARGS_400_PATTERN = /arguments|valid JSON|validation/i;

/**
 * True when a 400 looks like a tool_call arguments validation error
 * (recoverable via sanitization), as opposed to a generic bad request.
 */
export function isArgumentsValidationError(status: number, message: string): boolean {
  return status === 400 && ARGS_400_PATTERN.test(message || '');
}
