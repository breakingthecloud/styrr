import { describe, it, expect } from 'vitest';
import {
  toPlainObject,
  safeArguments,
  sanitizeToolCall,
  sanitizeMessages,
  toWireToolCall,
  isArgumentsValidationError,
} from './sanitize.js';

describe('toPlainObject', () => {
  it('returns plain objects as-is', () => {
    expect(toPlainObject({ a: 1 })).toEqual({ a: 1 });
  });
  it('rejects arrays, null and scalars', () => {
    expect(toPlainObject([])).toBeNull();
    expect(toPlainObject(null)).toBeNull();
    expect(toPlainObject('str')).toBeNull();
    expect(toPlainObject(42)).toBeNull();
    expect(toPlainObject(undefined)).toBeNull();
  });
});

describe('safeArguments', () => {
  it('parses a valid JSON object string', () => {
    expect(safeArguments({ arguments: '{"a":1}' })).toEqual({ a: 1 });
  });
  it('returns {} for a broken JSON string', () => {
    expect(safeArguments({ arguments: '{"a":1,' })).toEqual({});
  });
  it('returns {} for a JSON array string (not a plain object)', () => {
    expect(safeArguments({ arguments: '[]' })).toEqual({});
    expect(safeArguments({ arguments: '[1,2]' })).toEqual({});
  });
  it('returns {} for an array value', () => {
    expect(safeArguments({ arguments: [] })).toEqual({});
  });
  it('keeps nested plain objects serializable', () => {
    const args = { a: { b: [1, 2, { c: null }] }, d: undefined };
    const out = safeArguments({ arguments: args });
    expect(out.a).toEqual({ b: [1, 2, { c: null }] });
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(JSON.parse(JSON.stringify(out))).toEqual({ a: { b: [1, 2, { c: null }] } });
  });
  it('reads OpenAI shape function.arguments', () => {
    expect(safeArguments({ function: { arguments: '{"x":"y"}' } })).toEqual({ x: 'y' });
  });
  it('prefers top-level arguments over function.arguments', () => {
    expect(safeArguments({ arguments: { top: 1 }, function: { arguments: '{"nested":2}' } })).toEqual({ top: 1 });
  });
  it('returns {} for a circular object (non-serializable)', () => {
    const circular: any = { a: 1 };
    circular.self = circular;
    expect(safeArguments({ arguments: circular })).toEqual({});
  });
  it('returns {} for missing arguments', () => {
    expect(safeArguments({})).toEqual({});
    expect(safeArguments(null)).toEqual({});
  });
});

describe('sanitizeToolCall', () => {
  it('normalizes tinkuy shape', () => {
    expect(sanitizeToolCall({ id: 'c1', name: 'get_sprint_status', arguments: '{}' })).toEqual({
      id: 'c1',
      name: 'get_sprint_status',
      function: { name: 'get_sprint_status', arguments: {} },
    });
  });
  it('normalizes OpenAI shape', () => {
    expect(
      sanitizeToolCall({ id: 'c2', type: 'function', function: { name: 'explain_phase', arguments: { phase: 'BUILD' } } })
    ).toEqual({
      id: 'c2',
      name: 'explain_phase',
      function: { name: 'explain_phase', arguments: { phase: 'BUILD' } },
    });
  });
});

describe('toWireToolCall', () => {
  it('serializes arguments as a valid JSON object string', () => {
    const wire = toWireToolCall({ id: 'c1', name: 'x', arguments: '{"a":1,' });
    expect(wire.type).toBe('function');
    expect(wire.function.arguments).toBe('{}');
    expect(JSON.parse(wire.function.arguments)).toEqual({});
  });
  it('is idempotent (wire → wire keeps the same string)', () => {
    const once = toWireToolCall({ id: 'c1', name: 'x', arguments: { a: 1 } });
    const twice = toWireToolCall(once);
    expect(twice.function.arguments).toBe(once.function.arguments);
    expect(twice.function.arguments).toBe('{"a":1}');
  });
});

describe('sanitizeMessages', () => {
  it('sanitizes toolCalls (camelCase) into wire tool_calls', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: '{"a":1,' }] },
    ]);
    expect(out[0]).toEqual({ role: 'user', content: 'hi' });
    const msg: any = out[1];
    expect(msg.toolCalls).toBeUndefined();
    expect(msg.tool_calls[0].function.arguments).toBe('{}');
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({});
  });
  it('sanitizes existing tool_calls shape too', () => {
    const out: any = sanitizeMessages([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: 'not json' } }] },
    ]);
    expect(out[0].tool_calls[0].function.arguments).toBe('{}');
  });
});

describe('isArgumentsValidationError', () => {
  it('matches arguments/valid JSON/validation 400s', () => {
    expect(isArgumentsValidationError(400, 'messages[1].tool_calls[0].function.arguments must be a valid JSON object string')).toBe(true);
    expect(isArgumentsValidationError(400, 'validation error')).toBe(true);
  });
  it('rejects generic 400s and other statuses', () => {
    expect(isArgumentsValidationError(400, 'model not supported')).toBe(false);
    expect(isArgumentsValidationError(401, 'arguments must be a valid JSON object')).toBe(false);
  });
});
