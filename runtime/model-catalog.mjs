import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isOpenRouterModelId, loadCatalog, parseCatalog } from "./openrouter-catalog.mjs";
import {
  XAI_API_BASE_URL,
  XAI_SUBSCRIPTION_BASE_URL,
  accessToken as xaiAccessToken,
  assertBearerOrigin,
} from "./xai-oauth.mjs";

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
const CATALOG_TTL_MS = 60 * 60_000;
const DISCOVERY_TIMEOUT_MS = 20_000;
// The bundled 0.151.0 catalog is ~400 KB because every entry carries its base
// instructions; the cap leaves room to grow while bounding a runaway child.
const CODEX_CATALOG_MAX_BYTES = 16 * 1024 * 1024;
const MODEL_ID = /^[a-z0-9][a-z0-9._:+-]{0,127}$/i;
const REASONING_LEVEL = /^[a-z]{1,16}$/;

/**
 * Remote catalogs are untrusted: an ID is stored, listed, or handed to a CLI
 * or SDK only when it matches this shape (no spaces or shell metacharacters).
 */
export function isValidModelId(provider, id) {
  if (typeof id !== "string") return false;
  return provider === "openrouter" ? isOpenRouterModelId(id) : MODEL_ID.test(id);
}

function cachePath(config, provider) {
  return config.modelCatalogPath
    ? `${config.modelCatalogPath}.${provider}.json`
    : join(runtimeDirectory, `model-catalog.${provider}.json`);
}

async function readCache(config, provider) {
  try {
    const parsed = JSON.parse(await readFile(cachePath(config, provider), "utf8"));
    if (!Array.isArray(parsed?.models) || typeof parsed.fetchedAt !== "number") return null;
    return { ...parsed, models: parsed.models.filter((model) => isValidModelId(provider, model?.id)) };
  } catch {
    return null;
  }
}

async function writeCache(config, provider, models) {
  const fetchedAt = Date.now();
  try {
    const pathname = cachePath(config, provider);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, JSON.stringify({ fetchedAt, models }), { mode: 0o600 });
  } catch {
    // A cache write failure only costs a refetch.
  }
  return fetchedAt;
}

function normalizeEntry(provider, entry, extra = {}) {
  const id = typeof entry === "string" ? entry.trim() : String(entry?.id ?? entry?.value ?? "").trim();
  if (!isValidModelId(provider, id)) return null;
  return {
    id,
    name: String(entry?.name ?? entry?.displayName ?? id).trim().slice(0, 120) || id,
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
  return rows.map((row) => normalizeEntry("xai", row, extra)).filter(Boolean);
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
    fetchOpenAIModels(publicBase, token, fetchImpl, { subscription: false }),
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
      tools: [],
      maxTurns: 1,
      settingSources: [],
      ...(config.anthropicExecutablePath ? { pathToClaudeCodeExecutable: config.anthropicExecutablePath } : {}),
    },
  });
  try {
    const rows = await conversation.supportedModels();
    return (Array.isArray(rows) ? rows : [])
      .map((row) => normalizeEntry("anthropic", row, {
        alias: isValidModelId("anthropic", row?.resolvedModel) ? row.resolvedModel : undefined,
      }))
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

/**
 * Parses `codex debug models` JSON. Only `visibility: "list"` models are what
 * the Codex picker itself offers; hidden ones are internal or retired.
 */
export function parseCodexModels(stdout) {
  let payload;
  try {
    payload = JSON.parse(String(stdout));
  } catch {
    throw new Error("Codex model catalog was not valid JSON");
  }
  if (!Array.isArray(payload?.models)) throw new Error("Codex model catalog had no models list");
  const models = payload.models
    .filter((row) => row?.visibility === "list" && isValidModelId("codex", row.slug))
    .map((row) => {
      const levels = (Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels : [])
        .map((level) => level?.effort)
        .filter((effort) => typeof effort === "string" && REASONING_LEVEL.test(effort));
      return {
        id: row.slug,
        name: String(row.display_name || row.slug).trim().slice(0, 120) || row.slug,
        contextLength: Number(row.context_window) || 0,
        free: false,
        tools: true,
        reasoningLevels: [...new Set(levels)],
        ...(REASONING_LEVEL.test(String(row.default_reasoning_level)) ? { defaultReasoning: row.default_reasoning_level } : {}),
        priority: Number.isFinite(row.priority) ? row.priority : Number.MAX_SAFE_INTEGER,
      };
    })
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map(({ priority, ...model }) => model);
  if (!models.length) throw new Error("Codex model catalog listed no models");
  return models;
}

function codexCliPath(config) {
  return config.codexPathOverride || join(runtimeDirectory, "node_modules", ".bin", "codex");
}

/**
 * Runs the pinned Codex CLI without a shell. The inherited environment keeps
 * the HOME/CODEX_HOME the SDK uses, so the default mode refreshes the catalog
 * for the signed-in account; `--bundled` reads only the offline copy.
 */
async function discoverCodex(config, execImpl, { bundled = false } = {}) {
  const args = ["debug", "models", ...(bundled ? ["--bundled"] : [])];
  const { stdout } = await execImpl(codexCliPath(config), args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: CODEX_CATALOG_MAX_BYTES,
    timeout: DISCOVERY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (Buffer.byteLength(String(stdout ?? "")) > CODEX_CATALOG_MAX_BYTES) {
    throw new Error("Codex model catalog exceeded the size limit");
  }
  return parseCodexModels(stdout);
}

function packagedEntries(config, provider) {
  const key = { codex: "codexModels", openrouter: "openRouterModels", anthropic: "anthropicModels", xai: "xaiModels" }[provider];
  const listed = Array.isArray(config?.[key]) ? config[key] : [];
  return listed.map((id) => normalizeEntry(provider, id)).filter(Boolean);
}

function packaged(config, provider, error) {
  return {
    models: packagedEntries(config, provider),
    stale: true,
    source: "packaged",
    ...(error ? { error } : {}),
  };
}

function fromCache(cached, now, error) {
  return {
    models: cached.models,
    stale: now - cached.fetchedAt >= CATALOG_TTL_MS,
    source: "cache",
    fetchedAt: cached.fetchedAt,
    ...(error ? { error } : {}),
  };
}

/**
 * Returns `{ models, stale, source, fetchedAt?, error? }` for one provider;
 * `source` is `live`, `bundled` (Codex CLI offline copy), `cache`, or
 * `packaged`. Discovery failures fall back instead of throwing, so a control
 * never fails just because a catalog is unreachable. `cacheOnly` never touches
 * the network or spawns a process.
 */
export async function loadProviderModels(provider, config, dependencies = {}, options = {}) {
  const { now = Date.now(), force = false, cacheOnly = false } = options;
  const fetchImpl = dependencies.catalogFetch || dependencies.fetchImpl || fetch;
  const codexExec = dependencies.codexExec || promisify(execFile);
  if (provider === "openrouter") {
    const catalog = await loadCatalog(config, fetchImpl, { now, force, cacheOnly });
    return catalog.models.length ? catalog : packaged(config, provider, catalog.error);
  }
  const cached = await readCache(config, provider);
  if (cached?.models.length && (cacheOnly || (!force && now - cached.fetchedAt < CATALOG_TTL_MS))) {
    return fromCache(cached, now);
  }
  if (cacheOnly) return packaged(config, provider);
  let failure;
  try {
    const models = provider === "xai"
      ? await discoverXai(config, fetchImpl)
      : provider === "anthropic"
        ? await discoverAnthropic(config, dependencies.anthropicQueryFactory)
        : await discoverCodex(config, codexExec);
    if (!models.length) throw new Error("provider returned an empty model list");
    const fetchedAt = await writeCache(config, provider, models);
    return { models, stale: false, source: "live", fetchedAt };
  } catch (error) {
    failure = String(error?.message || error);
  }
  if (provider === "codex") {
    // The bundled catalog is static, so it is shown but never cached: the next
    // listing retries the account refresh instead of trusting it for an hour.
    try {
      const models = await discoverCodex(config, codexExec, { bundled: true });
      return { models, stale: true, source: "bundled", error: failure };
    } catch {
      // Fall through to the last cached copy.
    }
  }
  if (cached?.models.length) return fromCache(cached, now, failure);
  return packaged(config, provider, failure);
}

function formatAge(milliseconds) {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/** One-phrase provenance for `/models` and doctor, e.g. `cached 5 min ago`. */
export function describeCatalog(catalog, now = Date.now()) {
  if (catalog.source === "live") return `live, updated ${formatAge(now - catalog.fetchedAt)}`;
  if (catalog.source === "cache") {
    return `cached, updated ${formatAge(now - catalog.fetchedAt)}${catalog.stale ? " (stale)" : ""}`;
  }
  if (catalog.source === "bundled") return "Codex CLI bundled list";
  return "packaged list";
}

// Family aliases track the newest release instead of a pinned ID. Each family
// is matched per provider namespace; `:batch` and other variants never match.
const FAMILY_ALIASES = {
  sonnet: "sonnet", claude: "sonnet", opus: "opus", haiku: "haiku", fable: "fable",
  sol: "sol", terra: "terra", luna: "luna", astra: "astra",
  grok: "grok",
};
const CLAUDE_FAMILIES = new Set(["sonnet", "opus", "haiku", "fable"]);
const GPT_FAMILIES = new Set(["sol", "terra", "luna", "astra"]);

function familyPattern(provider, family) {
  if (CLAUDE_FAMILIES.has(family)) {
    const prefix = { anthropic: "", openrouter: "anthropic/" }[provider];
    // Anthropic-direct IDs use dashes (`claude-haiku-4-5`), OpenRouter dots;
    // an optional snapshot date orders same-version releases.
    return prefix === undefined ? null
      : new RegExp(`^${prefix}claude-${family}-(\\d+)(?:[.-](\\d{1,2}))?(?:-(\\d{8}))?$`, "i");
  }
  if (GPT_FAMILIES.has(family)) {
    const prefix = { codex: "", openrouter: "openai/" }[provider];
    return prefix === undefined ? null : new RegExp(`^${prefix}gpt-(\\d+)(?:\\.(\\d{1,2}))?-${family}$`, "i");
  }
  if (family === "grok") {
    const prefix = { xai: "", openrouter: "x-ai/" }[provider];
    return prefix === undefined ? null : new RegExp(`^${prefix}grok-(\\d+)(?:\\.(\\d{1,2}))?$`, "i");
  }
  return null;
}

/**
 * Newest catalog model in the alias's family, or null. Minor versions compare
 * as decimals because vendors name them that way: Grok 4.20 predates 4.3.
 * An undated ID outranks a dated snapshot of the same version (it tracks it).
 */
export function newestFamilyModel(provider, alias, models) {
  const family = FAMILY_ALIASES[String(alias || "").toLowerCase()];
  const pattern = family ? familyPattern(provider, family) : null;
  if (!pattern) return null;
  let best = null;
  for (const model of Array.isArray(models) ? models : []) {
    const match = typeof model?.id === "string" && isValidModelId(provider, model.id) ? model.id.match(pattern) : null;
    if (!match) continue;
    const rank = [Number(match[1]), match[2] ? Number(`0.${match[2]}`) : 0, match[3] ? Number(match[3]) : Infinity];
    const index = best ? rank.findIndex((value, position) => value !== best.rank[position]) : -1;
    if (!best || (index >= 0 && rank[index] > best.rank[index])) best = { id: model.id, rank };
  }
  return best?.id || null;
}

/** Model IDs the xAI subscription proxy serves, from the cached catalog. */
export async function xaiSubscriptionModelIds(config) {
  const configured = Array.isArray(config.xaiSubscriptionModels) ? config.xaiSubscriptionModels : [];
  if (configured.length) return configured;
  const cached = await readCache(config, "xai");
  return (cached?.models || []).filter((model) => model.subscription).map((model) => model.id);
}

export { parseCatalog };
