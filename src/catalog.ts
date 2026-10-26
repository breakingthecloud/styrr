/**
 * Catalog helpers — Styrr stays provider-agnostic: the app owns the catalog and
 * its business rules, Styrr only normalizes, ranks and converts to StyrModels.
 *
 * Model IDs collide across providers (e.g. `minimax-m3` exists on OpenRouter and
 * OpenCode Go), so the canonical key is always `provider:id`.
 */
import type { StyrModel } from './index.js';

export interface CatalogModel {
  /** Provider id, e.g. 'openrouter' | 'opencode-go'. */
  provider: string;
  /** Model id as returned by the provider (bare, e.g. 'minimax-m3'). */
  id: string;
  /** Human label for UIs. */
  label?: string;
  /** USD per 1M input tokens. */
  costInputPer1M: number;
  /** USD per 1M output tokens. */
  costOutputPer1M: number;
  /** Context window in tokens. */
  context: number;
  /** Whether the model supports tool/function calling. */
  toolCall?: boolean;
  /** Optional quality score. Accepts 0-10 or 0-100 (auto-normalized). */
  quality?: number;
}

export interface RoutingRules {
  /** Include free models (cost 0/0). Default false (paid-first). */
  allowFree?: boolean;
  /** Max USD per 1M input tokens. */
  maxInputCostPer1M?: number;
  /** Max USD per 1M output tokens. */
  maxOutputCostPer1M?: number;
  /** Minimum context window. */
  minContext?: number;
  /** Require tool/function calling support. */
  requireTools?: boolean;
  /** Providers to prefer on ties / small score bonus. */
  preferredProviders?: string[];
  /** Weight of quality in the score (default 0.7). */
  weightQuality?: number;
  /** Weight of cost in the score (default 0.3). */
  weightCost?: number;
  /** Regex source strings; matching `provider:id` or `id` are excluded. */
  exclude?: string[];
}

export function catalogKey(model: Pick<CatalogModel, 'provider' | 'id'>): string {
  return `${model.provider}:${model.id}`;
}

function isFree(model: CatalogModel): boolean {
  return model.costInputPer1M === 0 && model.costOutputPer1M === 0;
}

/** Blended cost used for ranking (output is weighted higher: posts are output-heavy). */
export function blendedCostPer1M(model: CatalogModel): number {
  return model.costInputPer1M * 0.35 + model.costOutputPer1M * 0.65;
}

function matchesExclude(model: CatalogModel, patterns: RegExp[]): boolean {
  // Match only the model id: the provider id may contain substrings such as
  // "code" (e.g. "opencode-go") and would wrongly exclude the whole provider.
  return patterns.some((re) => re.test(model.id));
}

function normalizeQuality(model: CatalogModel, maxQuality: number): number {
  const q = model.quality ?? 0;
  if (maxQuality <= 10) return Math.min(1, q / 10);
  return Math.min(1, q / 100);
}

/**
 * Filter by rules and rank best-first. Deterministic: ties break by `provider:id`.
 * Returns an empty array when nothing satisfies the rules (caller decides fallback).
 */
export function rankCatalog(models: CatalogModel[], rules: RoutingRules = {}): CatalogModel[] {
  const {
    allowFree = false,
    maxInputCostPer1M,
    maxOutputCostPer1M,
    minContext,
    requireTools = false,
    preferredProviders = [],
    weightQuality = 0.7,
    weightCost = 0.3,
    exclude = [],
  } = rules;

  const excludes = exclude.map((p) => new RegExp(p, 'i'));

  const filtered = models.filter((m) => {
    if (!allowFree && isFree(m)) return false;
    if (maxInputCostPer1M !== undefined && m.costInputPer1M > maxInputCostPer1M) return false;
    if (maxOutputCostPer1M !== undefined && m.costOutputPer1M > maxOutputCostPer1M) return false;
    if (minContext !== undefined && m.context < minContext) return false;
    if (requireTools && !m.toolCall) return false;
    if (excludes.length && matchesExclude(m, excludes)) return false;
    return true;
  });

  if (filtered.length === 0) return [];

  const maxQuality = Math.max(...filtered.map((m) => m.quality ?? 0), 10);
  const maxCost = Math.max(...filtered.map(blendedCostPer1M), 0.000001);
  const preferred = new Set(preferredProviders);

  const scored = filtered.map((m) => {
    const qualityNorm = normalizeQuality(m, maxQuality);
    const costNorm = blendedCostPer1M(m) / maxCost;
    const providerBonus = preferred.has(m.provider) ? 0.05 : 0;
    const score = weightQuality * qualityNorm - weightCost * costNorm + providerBonus;
    return { model: m, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return catalogKey(a.model).localeCompare(catalogKey(b.model));
  });

  return scored.map((s) => s.model);
}

/** Convert a ranked catalog into Styrr models (preserves order). */
export function toStyrModels(models: CatalogModel[]): StyrModel[] {
  return models.map((m) => ({ id: m.id, provider: m.provider }));
}

/**
 * Pick the top N models, optionally pinning one as primary.
 * The pinned model is kept first (if present in the catalog); fallbacks are the
 * best-ranked distinct models.
 */
export function buildModelChain(
  ranked: CatalogModel[],
  opts: { pinned?: Pick<CatalogModel, 'provider' | 'id'>; limit?: number } = {},
): CatalogModel[] {
  const { pinned, limit = 4 } = opts;
  const result: CatalogModel[] = [];

  if (pinned) {
    const found = ranked.find(
      (m) => m.provider === pinned.provider && m.id === pinned.id,
    );
    if (found) result.push(found);
    else result.push({ ...pinned, costInputPer1M: 0, costOutputPer1M: 0, context: 0 } as CatalogModel);
  }

  for (const m of ranked) {
    if (result.length >= limit) break;
    if (result.some((r) => r.provider === m.provider && r.id === m.id)) continue;
    result.push(m);
  }

  return result.slice(0, limit);
}
