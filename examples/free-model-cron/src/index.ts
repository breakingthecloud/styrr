import { discoverFreeModels, lastResortModels, StyrRouter } from '@carloscortezcloud/styrr-llm';

export interface Env {
  MODELS_CACHE: KVNamespace;
  OPENROUTER_API_KEY: string;
}

const CACHE_KEY = 'free_models';
const CACHE_TTL = 172800;

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const result = await discoverFreeModels({
        minContextLength: 8192,
        maxResults: 10,
        requireToolSupport: true,
      });

      const modelIds = result.models.map(m => m.id);

      await env.MODELS_CACHE.put(CACHE_KEY, JSON.stringify(modelIds), {
        expirationTtl: CACHE_TTL,
      });

      console.log(`[model-cron] Cached ${modelIds.length} free models. Total available: ${result.totalFree}`);
    } catch (err) {
      console.error('[model-cron] Failed to refresh models:', err);
    }
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    if (url.pathname === '/models') {
      return handleModels(env);
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function getActiveModels(env: Env): Promise<{ id: string }[]> {
  const cached = await env.MODELS_CACHE.get(CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached).map((id: string) => ({ id }));
    } catch {
      // corrupted cache, fall through
    }
  }
  return lastResortModels().map(id => ({ id }));
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { message: string };
    const models = await getActiveModels(env);

    if (models.length === 0) {
      return Response.json({
        text: 'All free AI models are currently unavailable. Please try again later or configure your own API key.',
        error_type: 'models_unavailable',
      }, { status: 503 });
    }

    const router = new StyrRouter({
      apiKey: env.OPENROUTER_API_KEY,
      models,
      onFallback: (failed, _err, next) => {
        console.warn(`[chat] ${failed} failed, trying ${next}`);
      },
    });

    const result = await router.prompt(body.message || 'Hello');
    return Response.json({
      text: result.text,
      modelUsed: result.modelUsed,
      latencyMs: result.latencyMs,
    });
  } catch {
    return Response.json({
      text: 'Sorry, all AI models are currently unavailable. Please try again in a few minutes.',
      error_type: 'all_models_failed',
    }, { status: 503 });
  }
}

async function handleModels(env: Env): Promise<Response> {
  const models = await getActiveModels(env);
  return Response.json({
    count: models.length,
    models: models.map(m => m.id),
    cachedAt: new Date().toISOString(),
  });
}
