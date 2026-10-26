import { describe, it, expect, vi, afterEach } from 'vitest';
import { StyrRouter } from './index.js';
import { rankCatalog, toStyrModels, buildModelChain, catalogKey } from './catalog.js';
import type { CatalogModel } from './catalog.js';

afterEach(() => vi.unstubAllGlobals());

const CATALOG: CatalogModel[] = [
  { provider: 'openrouter', id: 'anthropic/claude-x', label: 'Claude X', costInputPer1M: 3, costOutputPer1M: 15, context: 200000, toolCall: true, quality: 95 },
  { provider: 'opencode-go', id: 'glm-5.3', label: 'GLM 5.3', costInputPer1M: 1.4, costOutputPer1M: 4.4, context: 1000000, toolCall: true, quality: 90 },
  { provider: 'opencode-go', id: 'minimax-m3', label: 'MiniMax M3', costInputPer1M: 0.3, costOutputPer1M: 1.2, context: 1000000, toolCall: true, quality: 84 },
  { provider: 'opencode-go', id: 'free-x', label: 'Free X', costInputPer1M: 0, costOutputPer1M: 0, context: 1000000, toolCall: true, quality: 50 },
  { provider: 'opencode-go', id: 'code-model', label: 'Code', costInputPer1M: 0.1, costOutputPer1M: 0.4, context: 1000000, toolCall: true, quality: 60 },
];

describe('SoW-MNG-010 — catalog ranking', () => {
  it('excludes free models unless allowFree', () => {
    const ranked = rankCatalog(CATALOG, { maxInputCostPer1M: 5, maxOutputCostPer1M: 20 });
    expect(ranked.some((m) => m.id === 'free-x')).toBe(false);

    const withFree = rankCatalog(CATALOG, { allowFree: true, maxInputCostPer1M: 5, maxOutputCostPer1M: 20 });
    expect(withFree.some((m) => m.id === 'free-x')).toBe(true);
  });

  it('respects cost caps', () => {
    const ranked = rankCatalog(CATALOG, { maxInputCostPer1M: 2, maxOutputCostPer1M: 5, exclude: ['code-model'] });
    expect(ranked.map((m) => m.id)).toEqual(['minimax-m3', 'glm-5.3']);
  });

  it('respects minContext, requireTools and exclude', () => {
    const ranked = rankCatalog(CATALOG, {
      allowFree: true,
      minContext: 500000,
      requireTools: true,
      exclude: ['code-model'],
    });
    expect(ranked.every((m) => m.context >= 500000)).toBe(true);
    expect(ranked.some((m) => m.id === 'code-model')).toBe(false);
    expect(ranked.some((m) => m.id === 'anthropic/claude-x')).toBe(false);
  });

  it('ranks by quality/cost blend, deterministic tie-break', () => {
    const ranked = rankCatalog(CATALOG, { exclude: ['code-model'] });
    expect(ranked[0].id).toBe('minimax-m3');
    expect(ranked.map(catalogKey)).toEqual([
      'opencode-go:minimax-m3',
      'opencode-go:glm-5.3',
      'openrouter:anthropic/claude-x',
    ]);
  });

  it('buildModelChain pins the requested model first and avoids duplicates', () => {
    const ranked = rankCatalog(CATALOG, { exclude: ['code-model'] });
    const chain = buildModelChain(ranked, { pinned: { provider: 'opencode-go', id: 'glm-5.3' }, limit: 3 });
    expect(chain.map(catalogKey)).toEqual([
      'opencode-go:glm-5.3',
      'opencode-go:minimax-m3',
      'openrouter:anthropic/claude-x',
    ]);
  });

  it('toStyrModels keeps provider + id', () => {
    const ranked = rankCatalog(CATALOG, {});
    expect(toStyrModels(ranked)[0]).toEqual({ id: 'minimax-m3', provider: 'opencode-go' });
  });
});

describe('SoW-MNG-010 — multi-provider credentials', () => {
  it('uses the opencode-go base URL, its own API key and session headers', async () => {
    const calls: { url: string; auth: string; session: string; ua: string }[] = [];
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      calls.push({
        url: String(url),
        auth: init.headers.Authorization,
        session: init.headers['x-opencode-session'],
        ua: init.headers['User-Agent'],
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const router = new StyrRouter({
      apiKeys: { openrouter: 'or-key', 'opencode-go': 'oc-key' },
      models: [{ id: 'glm-5.3', provider: 'opencode-go' }],
    });

    await router.call([{ role: 'user', content: 'hi' }]);

    expect(calls[0].url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect(calls[0].auth).toBe('Bearer oc-key');
    expect(calls[0].session).toBeTruthy();
    expect(calls[0].ua).toBe('cc-mng/0.1.0');
  });

  it('falls back to the legacy apiKey and OpenRouter base URL', async () => {
    const calls: { url: string; auth: string }[] = [];
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      calls.push({ url: String(url), auth: init.headers.Authorization });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const router = new StyrRouter({ apiKey: 'legacy-key', models: [{ id: 'google/gemma-4-31b-it:free' }] });
    await router.call([{ role: 'user', content: 'hi' }]);

    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0].auth).toBe('Bearer legacy-key');
  });
});
