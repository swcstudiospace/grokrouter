import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
const CATALOG_TTL_MS = 60 * 60_000;
const CATALOG_FETCH_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 40;

function priceNumber(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function parseCatalog(payload) {
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const models = [];
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:+-]*$/i.test(id)) continue;
    const prompt = priceNumber(entry?.pricing?.prompt);
    const completion = priceNumber(entry?.pricing?.completion);
    const supported = Array.isArray(entry?.supported_parameters)
      ? entry.supported_parameters.filter((item) => typeof item === "string")
      : [];
    models.push({
      id,
      name: typeof entry?.name === "string" ? entry.name.trim() : id,
      contextLength: Number(entry?.context_length) || 0,
      free: id.endsWith(":free") || (prompt === 0 && completion === 0),
      tools: supported.includes("tools"),
      reasoning: supported.includes("reasoning"),
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

export function freeModels(models) {
  return models.filter((model) => model.free);
}

export function searchModels(models, term) {
  const needle = String(term || "").trim().toLowerCase();
  if (!needle) return [];
  return models.filter((model) => model.id.toLowerCase().includes(needle)
    || model.name.toLowerCase().includes(needle));
}

export function findModel(models, id) {
  const wanted = String(id || "").toLowerCase();
  return models.find((model) => model.id.toLowerCase() === wanted) || null;
}

function formatContext(length) {
  if (!length) return "";
  if (length >= 1_000_000) return `${(length / 1_000_000).toFixed(length % 1_000_000 ? 1 : 0)}M ctx`;
  return `${Math.round(length / 1000)}k ctx`;
}

export function formatModelLine(model) {
  const notes = [
    model.free ? "free" : "",
    model.tools ? "tools" : "no tools",
    formatContext(model.contextLength),
  ].filter(Boolean);
  return `• ${model.id} — ${notes.join(", ")}`;
}

export function formatModelPage(models, { title, page = 1, pageSize = PAGE_SIZE, moreCommand = "" } = {}) {
  const pages = Math.max(1, Math.ceil(models.length / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * pageSize;
  const slice = models.slice(start, start + pageSize);
  // The first line keeps a stable `<title>:` shape so callers can match it.
  const lines = [
    `${title}:`,
    `Showing ${slice.length} of ${models.length} (page ${current}/${pages}).`,
    ...slice.map(formatModelLine),
  ];
  if (current < pages && moreCommand) lines.push(`More: send ${moreCommand} ${current + 1}`);
  return lines.join("\n");
}

function catalogCachePath(config) {
  return config.openRouterCatalogPath || join(runtimeDirectory, "openrouter-catalog.json");
}

async function readCachedCatalog(config) {
  try {
    const parsed = JSON.parse(await readFile(catalogCachePath(config), "utf8"));
    if (!Array.isArray(parsed?.models) || typeof parsed.fetchedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCachedCatalog(config, models) {
  try {
    const pathname = catalogCachePath(config);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, JSON.stringify({ fetchedAt: Date.now(), models }), { mode: 0o600 });
  } catch {
    // A cache miss only costs a refetch; it must never break a control.
  }
}

/**
 * Returns `{ models, stale }` from the public OpenRouter model list. The
 * endpoint needs no credential, so the request never carries the key.
 * Failures fall back to the last cached copy (marked stale) or an empty list.
 */
export async function loadCatalog(config, fetchImpl = fetch, { now = Date.now(), force = false, cacheOnly = false } = {}) {
  const cached = await readCachedCatalog(config);
  if (cached && !force && (cacheOnly || now - cached.fetchedAt < CATALOG_TTL_MS)) {
    return { models: cached.models, stale: now - cached.fetchedAt >= CATALOG_TTL_MS, source: "cache" };
  }
  // Switching models must stay fast and offline; only the browse commands
  // refresh the catalog from the network.
  if (cacheOnly) return { models: [], stale: true, source: "none" };
  const baseUrl = String(config.openRouterBaseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      headers: { Accept: "application/json", "X-Title": "GrokRouter" },
      signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OpenRouter catalog request failed (${response.status})`);
    const models = parseCatalog(await response.json());
    if (!models.length) throw new Error("OpenRouter catalog was empty");
    await writeCachedCatalog(config, models);
    return { models, stale: false, source: "network" };
  } catch (error) {
    if (cached) return { models: cached.models, stale: true, source: "cache", error: error?.message };
    return { models: [], stale: true, source: "none", error: error?.message };
  }
}
