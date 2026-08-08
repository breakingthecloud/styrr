/**
 * Styrr v0.6.0 — Quality free-model router (CF Worker)
 *
 * The canonical pattern we shipped with SoWOSS-003/004:
 *  1. discoverFreeModels() → free + supportsTools + context >= 8K
 *  2. recommendToolsFirst(discovered) → ranked quality-first (gemma before nemotron)
 *  3. cache the ranked ids in KV (cron refresh; app only consumes + caches)
 *  4. StyrRouter with strategy:'quality' → dead models (502/429) are demoted
 *     in-memory for demotionPenaltyMs (default 30s) and come back after TTL.
 *
 * Endpoints:
 *   POST /chat  { "message": string, "tools"?: StyrToolSchema[] } → answer
 *   GET  /models → ranked ids + cache meta
 *   GET  /health → ok
 *
 * Setup: pnpm create:kv && pnpm run dev
 */

import {
  discoverFreeModels,
  recommendToolsFirst,
  StyrRouter,
  type StyrToolSchema,
} from '@carloscortezcloud/styrr-llm';

export interface Env {
  MODEL_RANKING: KVNamespace;
  OPENROUTER_API_KEY: string;
}

interface ChatRequest {
  message?: string;
  tools?: StyrToolSchema[];
}

const RANK_KEY = 'ranked_free';

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const ranked = await refreshRanking(env);
      console.log(`[styrr-quality] cached ${ranked.length} ranked free models`);
    } catch (err) {
      console.error('[styrr-quality] refresh failed:', err);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/chat' && request.method === 'POST') return handleChat(request, env);
    if (url.pathname === '/models') return handleModels(env);
    if (url.pathname === '/health') return Response.json({ status: 'ok' });
    return new Response('Not Found', { status: 404 });
  },
};

// ── Ranking + cache ─────────────────────────────────────────────────────

async function refreshRanking(env: Env): Promise<string[]> {
  const discover = await discoverFreeModels({
    minContextLength: 8192,
    maxResults: 20,
    requireToolSupport: true,
  });

  // recommendToolsFirst takes the DiscoveredModel[] (already tool-capable +
  // context checked) and sorts tool-capable by quality desc, latency asc.
  const { ranked } = recommendToolsFirst(discover.models, { minContext: 8192 });

  await env.MODEL_RANKING.put(RANK_KEY, JSON.stringify(ranked), { expirationTtl: 172800 });
  console.log(`V[styrr-quality] ${discover.toolCapable} tool-capable → ${ranked.length} ranked`);
  return ranked;
}

async function getRankedModels(env: Env): Promise<string[]> {
  const cached = await env.MODEL_RANKING.get(RANK_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      // corrupted cache → refresh
    }
  }
  return refreshRanking(env);
}

// ── Handlers ────────────────────────────────────────────────────────────

async function handleChat(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as ChatRequest;
    const modelIds = await getRankedModels(env);
    if (!modelIds.length) {
      return Response.json({ error: 'No available models. Try again later.' }, { status: 503 });
    }

    const router = new StyrRouter({
      apiKey: env.OPENROUTER_API_KEY,
      strategy: 'quality',            // quality first (SoWOSS-004 D3)
      demotionPenaltyMs: 30000,       // dead models return after 30s
      models: modelIds.map(id => ({ id })),
      onFallback: (failed, err, next) => {
        console.warn(`[styrr-quality] ${failed} → ${next}: ${err}`);
      },
    });

    const result = await router.call(
      [{ role: 'user', content: body.message || 'Hello' }] as any,
      { tools: body.tools, strategy: 'quality' },
    );

    return Response.json({
      text: result.text,
      modelUsed: result.modelUsed,
      latencyMs: result.latencyMs,
      fallbacksTried: result.fallbacksTried,
    });
  } catch {
    return Response.json({ error: 'All models failed. Try again in a few minutes.' }, { status: 503 });
  }
}

async function handleModels(env: Env): Promise<Response> {
  const ranked = await getRankedModels(env);
  return Response.json({ count: ranked.length, ranked, cacheKey: RANK_KEY, ttlSeconds: 172800 });
}