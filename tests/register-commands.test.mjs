import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NATIVE_COMMAND_NAMES,
  nativeCommandDefinitions,
  registrationExpression,
  summarizeStats,
} from "../scripts/register-native-commands.mjs";

const script = fileURLToPath(new URL("../scripts/register-native-commands.mjs", import.meta.url));

test("the seven shipped commands carry their ownership markers and /route is the only model-invocable one", () => {
  assert.deepEqual([...NATIVE_COMMAND_NAMES], ["provider", "models", "model", "reasoning", "router", "doctor", "route"]);
  const definitions = nativeCommandDefinitions();
  assert.deepEqual(definitions.map((definition) => definition.name), [...NATIVE_COMMAND_NAMES]);
  for (const definition of definitions) {
    assert.ok(definition.description.length > 10, definition.name);
    assert.ok(definition.body.includes(`GROKROUTER_NATIVE_CONTROL: ${definition.name.toUpperCase()}`), definition.name);
    assert.ok(definition.markdown.startsWith("---\n"), definition.name);
    assert.match(definition.markdown, definition.name === "route" ? /^disable-model-invocation: false$/m : /^disable-model-invocation: true$/m);
  }
  const route = definitions.find((definition) => definition.name === "route");
  assert.match(route.body, /grokbot-router run --task-file/);
  for (const name of ["provider", "models", "model", "reasoning", "router", "doctor"]) {
    assert.match(definitions.find((definition) => definition.name === name).body, new RegExp(`grokbot-router control "/${name}`));
  }
});

test("a command without its marker is refused before anything reaches Grok Bot", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokrouter-register-"));
  try {
    await mkdir(join(root, "route"), { recursive: true });
    await writeFile(join(root, "route", "SKILL.md"), "---\nname: route\ndescription: Something else\n---\n\n# not ours\n");
    assert.throws(() => nativeCommandDefinitions(root, ["route"]), /ownership marker/);
    await writeFile(join(root, "route", "SKILL.md"), "no frontmatter at all\nGROKROUTER_NATIVE_CONTROL: ROUTE\n");
    assert.throws(() => nativeCommandDefinitions(root, ["route"]), /invalid frontmatter/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the registration expression embeds the definitions and operation exactly once", () => {
  const definitions = nativeCommandDefinitions();
  const expression = registrationExpression(definitions, "sync");
  assert.ok(expression.includes("GROKROUTER_NATIVE_CONTROL: ROUTE"));
  assert.ok(expression.includes(JSON.stringify("sync")));
  assert.ok(!expression.includes("__GROKROUTER_NATIVE_SKILLS__"));
  assert.ok(!expression.includes("__GROKROUTER_NATIVE_OPERATION__"));
  assert.ok(expression.includes("app.workflows.install"));
  assert.ok(registrationExpression(definitions, "remove").includes(JSON.stringify("remove")));
  assert.throws(() => registrationExpression(definitions, "wipe"), /Unknown registration operation/);
  assert.throws(() => registrationExpression(definitions, "sync", "no markers here"), /bridge marker/);
});

test("the receipt summary names installs, updates, removals, and preserved conflicts", () => {
  assert.match(summarizeStats({ installed: 1, updated: 6, unchanged: 0, removed: 2, conflicts: 1, bots: 12 }, "sync"),
    /Verified 7 GrokRouter commands for 12 Bots[\s\S]*Removed 2 duplicate[\s\S]*1 user-owned slash commands were preserved/);
  assert.match(summarizeStats({ removed: 7, bots: 12 }, "remove"), /Removed 7 GrokRouter command entries/);
});

test("--print lists the commands without touching Grok Bot and unknown options are refused", () => {
  const printed = execFileSync(process.execPath, [script, "--print"], { encoding: "utf8" });
  assert.match(printed, /^\/route: Delegate a task/m);
  assert.equal(printed.trim().split("\n").length, 7);
  const refused = spawnSync(process.execPath, [script, "--bogus"], { encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Unknown option --bogus/);
  const help = execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.match(help, /register-native-commands\.mjs \[--remove\]/);
});
