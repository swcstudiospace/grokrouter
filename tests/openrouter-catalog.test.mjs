import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findModel,
  formatModelPage,
  freeModels,
  loadCatalog,
  parseCatalog,
  searchModels,
} from "../runtime/openrouter-catalog.mjs";

const payload = {
  data: [
    { id: "openai/gpt-6-astra", name: "OpenAI: GPT-6 Astra", context_length: 1050000, pricing: { prompt: "0.00001", completion: "0.00005" }, supported_parameters: ["tools", "reasoning"] },
    { id: "google/gemma-4-31b-it:free", name: "Google: Gemma 4 31B (free)", context_length: 131072, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["temperature"] },
    { id: "minimax/minimax-m3:free", name: "MiniMax M3 (free)", context_length: 200000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
    { id: "openrouter/free", name: "OpenRouter Free Router", context_length: 0, pricing: { prompt: "0", completion: "0" }, supported_parameters: [] },
    { id: "not a model id", name: "junk", pricing: {} },
    { id: "anthropic/claude-sonnet-4.6", name: "Anthropic: Claude Sonnet 4.6", context_length: 1000000, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools"] },
  ],
};

test("parses the public catalog and marks free and tool-capable models", () => {
  const models = parseCatalog(payload);
  assert.deepEqual(models.map((model) => model.id), [
    "anthropic/claude-sonnet-4.6",
    "google/gemma-4-31b-it:free",
    "minimax/minimax-m3:free",
    "openai/gpt-6-astra",
    "openrouter/free",
  ]);
  assert.deepEqual(freeModels(models).map((model) => model.id), [
    "google/gemma-4-31b-it:free",
    "minimax/minimax-m3:free",
    "openrouter/free",
  ]);
  assert.equal(findModel(models, "MiniMax/minimax-m3:FREE").tools, true);
  assert.equal(findModel(models, "google/gemma-4-31b-it:free").tools, false);
  assert.equal(findModel(models, "nobody/nothing"), null);
  assert.deepEqual(searchModels(models, "gemma").map((model) => model.id), ["google/gemma-4-31b-it:free"]);
  assert.deepEqual(searchModels(models, "  "), []);
});

test("formats a bounded page with a continuation hint", () => {
  const models = parseCatalog(payload);
  const text = formatModelPage(models, { title: "All OpenRouter models", page: 1, pageSize: 2, moreCommand: "/models all" });
  assert.match(text, /^All OpenRouter models \(5 models, page 1\/3\):/);
  assert.match(text, /• anthropic\/claude-sonnet-4.6 — tools, 1M ctx/);
  assert.match(text, /• google\/gemma-4-31b-it:free — free, no tools, 131k ctx/);
  assert.match(text, /More: send \/models all 2$/);
  const last = formatModelPage(models, { title: "All", page: 99, pageSize: 2, moreCommand: "/models all" });
  assert.match(last, /page 3\/3/);
  assert.doesNotMatch(last, /More:/);
});

test("caches the catalog for an hour and falls back to a stale copy on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbot-router-catalog-"));
  const config = { openRouterCatalogPath: join(root, "catalog.json") };
  let requests = 0;
  const okFetch = async (url, init) => {
    requests += 1;
    assert.equal(url, "https://openrouter.ai/api/v1/models");
    assert.equal(init.headers.Authorization, undefined);
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  try {
    const first = await loadCatalog(config, okFetch, { now: 1_000 });
    assert.equal(first.source, "network");
    assert.equal(first.models.length, 5);
    const cachedFile = JSON.parse(await readFile(config.openRouterCatalogPath, "utf8"));
    assert.equal(cachedFile.models.length, 5);

    const second = await loadCatalog(config, okFetch, { now: cachedFile.fetchedAt + 60_000 });
    assert.equal(second.source, "cache");
    assert.equal(requests, 1);

    const failing = async () => { throw new Error("offline"); };
    const stale = await loadCatalog(config, failing, { now: cachedFile.fetchedAt + 2 * 60 * 60_000 });
    assert.equal(stale.stale, true);
    assert.equal(stale.models.length, 5);

    const empty = await loadCatalog({ openRouterCatalogPath: join(root, "missing.json") }, failing);
    assert.deepEqual(empty.models, []);
    assert.equal(empty.stale, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
