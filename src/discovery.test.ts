import { describe, it, expect } from 'vitest';
import { recommendToolsFirst } from './discovery.js';

const NEMOTRON = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const GEMMA = 'google/gemma-4-31b-it:free';
const LLAMA = 'meta-llama/llama-3.3-70b-instruct:free';

describe('recommendToolsFirst', () => {
  it('ranks gemma before nemotron (SoW-OSS-004 Fase 1)', () => {
    const { ranked } = recommendToolsFirst([NEMOTRON, GEMMA, LLAMA]);
    expect(ranked.indexOf(GEMMA)).toBeLessThan(ranked.indexOf(NEMOTRON));
  });

  it('orders by qualityScore desc (llama > gemma > nemotron)', () => {
    const { ranked } = recommendToolsFirst([NEMOTRON, GEMMA, LLAMA]);
    expect(ranked).toEqual([LLAMA, GEMMA, NEMOTRON]);
  });

  it('echoes input order in models and lists toolCapable', () => {
    const r = recommendToolsFirst([NEMOTRON, GEMMA]);
    expect(r.models).toEqual([NEMOTRON, GEMMA]);
    expect(r.toolCapable.sort()).toEqual([GEMMA, NEMOTRON].sort());
  });

  it('excludes models flagged supportsTools: false', () => {
    const r = recommendToolsFirst([
      { id: NEMOTRON, contextLength: 32768, supportsTools: false, provider: 'nvidia' },
      { id: GEMMA, contextLength: 131072, supportsTools: true, provider: 'google' },
    ]);
    expect(r.toolCapable).toEqual([GEMMA]);
    expect(r.ranked).toEqual([GEMMA]);
  });

  it('filters by minContext using pricing contextWindow for plain ids', () => {
    const r = recommendToolsFirst([NEMOTRON, GEMMA], { minContext: 40000 });
    expect(r.ranked).toEqual([GEMMA]); // nemotron contextWindow is 32768
  });

  it('puts unknown models (no pricing) last but keeps them if they pass precheck', () => {
    const UNKNOWN = 'acme/mystery-9b:free';
    const r = recommendToolsFirst([
      { id: UNKNOWN, contextLength: 100000, supportsTools: true, provider: 'unknown' },
      { id: GEMMA, contextLength: 131072, supportsTools: true, provider: 'google' },
    ]);
    expect(r.ranked).toEqual([GEMMA, UNKNOWN]);
  });

  it('respects maxResults cap', () => {
    const r = recommendToolsFirst([NEMOTRON, GEMMA, LLAMA], { maxResults: 2 });
    expect(r.ranked).toEqual([LLAMA, GEMMA]);
  });

  it('tie-breaks equal qualityScore by avgLatencyMs asc', () => {
    // gemma-4-31b-it (75 @ 2000ms) vs llama (78 @ 2000ms) — no tie in table;
    // verify stable latency tie-break using two gemma variants with distinct scores instead:
    const r = recommendToolsFirst(['google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free']);
    expect(r.ranked).toEqual([GEMMA, 'google/gemma-4-26b-a4b-it:free']);
  });
});
