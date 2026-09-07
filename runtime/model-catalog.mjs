import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCatalog, parseCatalog } from "./openrouter-catalog.mjs";
import {
  XAI_API_BASE_URL,
  XAI_SUBSCRIPTION_BASE_URL,
  accessToken as xaiAccessToken,
  assertBearerOrigin,
} from "./xai-oauth.mjs";

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
const CATALOG_TTL_MS = 60 * 60_000;
const DISCOVERY_TIMEOUT_MS = 20_000;

function cachePath(config, provider) {
  return config.modelCatalogPath
    ? `${config.modelCatalogPath}.${provider}.json`
    : join(runtimeDirectory, `model-catalog.${provider}.json`);
}

async function readCache(config, provider) {
  try {
    const parsed = JSON.parse(await readFile(cachePath(config, provider), "utf8"));
    if (!Array.isArray(parsed?.models) || typeof parsed.fetchedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(config, provider, models) {
  try {
    const pathname = cachePath(config, provider);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, JSON.stringify({ fetchedAt: Date.now(), models }), { mode: 0o600 });
  } catch {
    // A cache write failure only costs a refetch.
  }
}

function normalizeEntry(entry, extra = {}) {
  const id = typeof entry === "string" ? entry : String(entry?.id ?? entry?.value ?? "").trim();
  if (!id) return null;
  return {
    id,
    name: String(entry?.name ?? entry?.displayName ?? id).trim() || id,
    contextLength: Number(entry?.context_length ?? entry?.contextLength ?? 0) || 0,
    free: false,
    tools: true,
    ...extra,
  };
}

/** OpenAI-compatible `GET /v1/models` on one host, using a bearer token. */
async function fetchOpenAIModels(baseUrl, token, fetchImpl, extra) {
  const url = `${String(baseUrl).replace(/\/$/, "")}/models`;
  assertBearerOrigin(url);
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`model list request failed (${response.status})`);
  const payload = await response.json().catch(() => ({}));
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return rows.map((row) => normalizeEntry(row, extra)).filter(Boolean);
}

/**
 * Live xAI catalog. Models served by the subscription proxy are flagged so a
 * turn can be routed to the quota path instead of the metered public API.
 */
async function discoverXai(config, fetchImpl) {
  const token = await xaiAccessToken(config, fetchImpl);
  const publicBase = String(config.xaiBaseUrl || XAI_API_BASE_URL);
  const subscriptionBase = String(config.xaiSubscriptionBaseUrl || XAI_SUBSCRIPTION_BASE_URL);
  const [subscription, metered] = await Promise.all([
    fetchOpenAIModels(subscriptionBase, token, fetchImpl, { subscription: true }).catch(() => []),
    fetchOpenAIModels(publicBase, token, fetchImpl, { subscription: false }).catch((error) => { throw error; }),
  ]);
  const merged = new Map();
  for (const model of [...metered, ...subscription]) merged.set(model.id, model);
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Live Anthropic catalog from the Claude Agent SDK's own control channel. The
 * query is opened with an empty streaming prompt so no turn is billed; only
 * the model list is read before it is closed.
 */
async function discoverAnthropic(config, queryFactory) {
  const query = queryFactory ? queryFactory() : (await import("@anthropic-ai/claude-agent-sdk")).query;
  const conversation = query({
    prompt: (async function* empty() {})(),
    options: {
      cwd: config.workingDirectory || "/workspace",
      permissionMode: "bypassPermissions",
      ...(config.anthropicExecutablePath ? { pathToClaudeCodeExecutable: config.anthropicExecutablePath } : {}),
    },
  });
  try {
    const rows = await conversation.supportedModels();
    return (Array.isArray(rows) ? rows : [])
      .map((row) => normalizeEntry(row, { alias: typeof row?.resolvedModel === "string" ? row.resolvedModel : undefined }))
      .filter(Boolean);
  } finally {
    try {
      conversation.close?.();
      await conversation.return?.(undefined);
    } catch {
      // Closing a control-only query must never fail a listing.
    }
  }
}

function configuredEntries(config, key) {
  const listed = Array.isArray(config?.[key]) ? config[key] : [];
  return listed.filter((item) => typeof item === "string").map((id) => normalizeEntry(id)).filter(Boolean);
}

/**
 * Returns `{ models, stale, source }` for one provider. Discovery failures fall
 * back to the cached copy and then to the packaged list, so a control never
 * fails just because a catalog is unreachable.
 */
export async function loadProviderModels(provider, config, dependencies = {}, options = {}) {
  const { now = Date.now(), force = false, cacheOnly = false } = options;
  const fetchImpl = dependencies.catalogFetch || dependencies.fetchImpl || fetch;
  if (provider === "openrouter") {
    const catalog = await loadCatalog(config, fetchImpl, { now, force, cacheOnly });
    if (catalog.models.length) return catalog;
    return { models: configuredEntries(config, "openRouterModels"), stale: true, source: "configured" };
  }
  if (provider === "codex") {
    return { models: configuredEntries(config, "codexModels"), stale: false, source: "configured" };
  }
  const cached = await readCache(config, provider);
  if (cached && (cacheOnly || (!force && now - cached.fetchedAt < CATALOG_TTL_MS))) {
    return { models: cached.models, stale: now - cached.fetchedAt >= CATALOG_TTL_MS, source: "cache" };
  }
  if (cacheOnly) return { models: [], stale: true, source: "none" };
  try {
    const models = provider === "xai"
      ? await discoverXai(config, fetchImpl)
      : await discoverAnthropic(config, dependencies.anthropicQueryFactory);
    if (!models.length) throw new Error("provider returned an empty model list");
    await writeCache(config, provider, models);
    return { models, stale: false, source: "provider" };
  } catch (error) {
    if (cached) return { models: cached.models, stale: true, source: "cache", error: error?.message };
    const key = provider === "xai" ? "xaiModels" : "anthropicModels";
    return { models: configuredEntries(config, key), stale: true, source: "configured", error: error?.message };
  }
}

/** Model IDs the xAI subscription proxy serves, from the cached catalog. */
export async function xaiSubscriptionModelIds(config) {
  const configured = Array.isArray(config.xaiSubscriptionModels) ? config.xaiSubscriptionModels : [];
  if (configured.length) return configured;
  const cached = await readCache(config, "xai");
  return (cached?.models || []).filter((model) => model.subscription).map((model) => model.id);
}

export { parseCatalog };
