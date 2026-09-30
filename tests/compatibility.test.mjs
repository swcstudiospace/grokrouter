import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const text = p => readFile(new URL(p, root), 'utf8');
const json = async p => JSON.parse(await text(p));
const { versions, delegation } = await json('compatibility/supported-apps.json');
const semver = (value) => value.split('.').map(Number);
const newer = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

test('delegation mode starts after the last host-adapter version and the installer pins the same floor', async () => {
  assert.match(delegation.minimumVersion, /^\d+\.\d+\.\d+$/);
  for (const version of versions) assert.ok(newer(delegation.minimumVersion, version), `${delegation.minimumVersion} must be newer than adapter version ${version}`);
  assert.ok(delegation.verifiedVersions.length > 0);
  for (const version of delegation.verifiedVersions) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.ok(!newer(delegation.minimumVersion, version), `${version} is below the delegation floor`);
  }
  const installer = await text('remote/install-delegation.sh');
  assert.ok(installer.includes(`MINIMUM_GROK_VERSION="${delegation.minimumVersion}"`));
  assert.doesNotMatch(installer, /router_patch\.py|bin\/host-registry|pkill|sand-host/);
  const readme = await text('README.md');
  assert.ok(readme.includes(`Grok Bot ${delegation.minimumVersion}`));
});

test('every exact desktop version has a signed registry and a matching strict manifest', async () => {
  assert.ok(versions.length > 0);
  assert.equal(new Set(versions).size, versions.length);
  const swift = await text('installer/GrokBotRouterInstaller.swift');
  const windows = await text('installer-windows/main.cjs');
  assert.deepEqual(JSON.parse(swift.match(/supportedGrokVersions = (\[[^\n]+\])/)[1]), versions);
  assert.deepEqual(JSON.parse(windows.match(/SUPPORTED_GROK_VERSIONS = (\[[^\n]+\])/)[1]), versions);
  for (const version of versions) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    const registry = await json(`compatibility/${version}-hosts.json`);
    const manifest = await json(`patch/manifests/${version}.json`);
    assert.equal(manifest.grokBotVersion, version);
    assert.equal(manifest.anchorVerifiedHosts.enabled, false);
    assert.deepEqual(manifest.stockHosts, registry.stockHosts);
    execFileSync(process.execPath, [fileURLToPath(new URL('remote/verify-host-registry.mjs', root)),
      fileURLToPath(new URL(`compatibility/${version}-hosts.json`, root)),
      fileURLToPath(new URL(`compatibility/${version}-hosts.json.sig`, root)),
      fileURLToPath(new URL('compatibility/registry-public-key.pem', root)), version]);
  }
});

test('a valid signature for one desktop version cannot authorize another', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('remote/verify-host-registry.mjs', root)),
    fileURLToPath(new URL('compatibility/0.30.0-hosts.json', root)),
    fileURLToPath(new URL('compatibility/0.30.0-hosts.json.sig', root)),
    fileURLToPath(new URL('compatibility/registry-public-key.pem', root)), '0.36.0']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString(), /Grok Bot version/);
});

test('management selects only the configured version registry and rejects unsupported configuration', {skip: process.platform === 'win32'}, async () => {
  const stage = await realpath(await mkdtemp(join(tmpdir(), 'grokrouter-versions-')));
  try {
    for (const directory of ['bin', 'compatibility', 'cache']) await mkdir(join(stage, directory));
    for (const file of ['host-registry', 'verify-host-registry.mjs']) await copyFile(new URL(`remote/${file}`, root), join(stage, 'bin', file));
    for (const file of ['supported-apps.json', 'registry-public-key.pem', ...versions.flatMap(v => [`${v}-hosts.json`, `${v}-hosts.json.sig`])]) await copyFile(new URL(`compatibility/${file}`, root), join(stage, 'compatibility', file));
    const env = {...process.env, ROUTER_HOST_REGISTRY_ROOT: join(stage, 'cache')};
    for (const version of versions) {
      await writeFile(join(stage, 'provider.json'), JSON.stringify({grokBotVersion: version}));
      assert.equal(execFileSync('bash', [join(stage, 'bin/host-registry'), 'version'], {env, encoding:'utf8'}).trim(), version);
      assert.equal(execFileSync('bash', [join(stage, 'bin/host-registry'), 'verify'], {env, encoding:'utf8'}).trim(), join(stage, `compatibility/${version}-hosts.json`));
    }
    await writeFile(join(stage, 'provider.json'), JSON.stringify({grokBotVersion: '../../other'}));
    const rejected = spawnSync('bash', [join(stage, 'bin/host-registry'), 'verify'], {env});
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr.toString(), /unsupported/);
  } finally { await rm(stage, {recursive: true, force: true}); }
});

test('an opted-in unreviewed newer version uses its reviewed template and never a registry', {skip: process.platform === 'win32'}, async () => {
  const stage = await realpath(await mkdtemp(join(tmpdir(), 'grokrouter-unreviewed-')));
  try {
    for (const directory of ['bin', 'compatibility', 'cache']) await mkdir(join(stage, directory));
    for (const file of ['host-registry', 'verify-host-registry.mjs']) await copyFile(new URL(`remote/${file}`, root), join(stage, 'bin', file));
    for (const file of ['supported-apps.json', 'registry-public-key.pem', ...versions.flatMap(v => [`${v}-hosts.json`, `${v}-hosts.json.sig`])]) await copyFile(new URL(`compatibility/${file}`, root), join(stage, 'compatibility', file));
    const env = {...process.env, ROUTER_HOST_REGISTRY_ROOT: join(stage, 'cache')};
    const registry = (...args) => spawnSync('bash', [join(stage, 'bin/host-registry'), ...args], {env, encoding: 'utf8'});
    const newest = versions.at(-1);
    const newer = newest.replace(/^(\d+)\./, (_, major) => `${Number(major) + 1}.`);
    await writeFile(join(stage, 'provider.json'), JSON.stringify({grokBotVersion: newer, unreviewedVersion: true, templateManifestVersion: newest}));
    assert.equal(registry('version').stdout.trim(), newer);
    assert.deepEqual(registry('patch-args').stdout.trim().split('\n'),
      ['--manifest', join(stage, `patch/manifests/${newest}.json`), '--unreviewed-version', newer]);
    const verified = registry('verify');
    assert.equal(verified.status, 0);
    assert.equal(verified.stdout, '');
    assert.match(verified.stderr, /unreviewed/);
    assert.notEqual(registry('refresh').status, 0);

    // A reviewed version keeps its exact gates even if an old opt-in remains.
    await writeFile(join(stage, 'provider.json'), JSON.stringify({grokBotVersion: newest, unreviewedVersion: true, templateManifestVersion: newest}));
    assert.deepEqual(registry('patch-args').stdout.trim().split('\n'), ['--manifest', join(stage, `patch/manifests/${newest}.json`)]);
    assert.equal(registry('verify').stdout.trim(), join(stage, `compatibility/${newest}-hosts.json`));

    for (const config of [
      {grokBotVersion: newer, templateManifestVersion: newest},
      {grokBotVersion: '0.40.0', unreviewedVersion: true, templateManifestVersion: newest},
      {grokBotVersion: '0.0.1', unreviewedVersion: true, templateManifestVersion: newest},
      {grokBotVersion: newer, unreviewedVersion: true, templateManifestVersion: newer},
      {grokBotVersion: newer, unreviewedVersion: true, templateManifestVersion: '../../other'},
      {grokBotVersion: `${newer};true`, unreviewedVersion: true, templateManifestVersion: newest},
    ]) {
      await writeFile(join(stage, 'provider.json'), JSON.stringify(config));
      const rejected = registry('patch-args');
      assert.notEqual(rejected.status, 0, JSON.stringify(config));
      assert.match(rejected.stderr, /unsupported/);
    }
  } finally { await rm(stage, {recursive: true, force: true}); }
});
