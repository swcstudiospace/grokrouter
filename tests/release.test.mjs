import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRelease } from '../scripts/verify-release.mjs';
import { validateAcceptance } from '../scripts/verify-acceptance.mjs';

const RELEASE_FILES = ['package.json', 'runtime/package.json', 'installer-windows/package.json', 'runtime/package-lock.json', 'installer-windows/package-lock.json', 'runtime/run-provider.mjs', 'patch/router_patch.py', 'remote/install.sh', 'scripts/install-macos.sh', 'scripts/install-windows.ps1', 'README.md'];

async function copyRelease() {
  const root = await mkdtemp(join(tmpdir(), 'grokrouter-release-'));
  for (const file of RELEASE_FILES) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), await readFile(new URL(`../${file}`, import.meta.url)));
  }
  return root;
}

const readmeFor = (macTag, windowsTag = macTag, repository = 'swcstudiospace/grokrouter') => [
  `/usr/bin/curl --fail --silent --show-error --location https://raw.githubusercontent.com/${repository}/${macTag}/scripts/install-macos.sh --output /tmp/grokrouter-install.sh && /bin/bash /tmp/grokrouter-install.sh`,
  `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/${repository}/${windowsTag}/scripts/install-windows.ps1 | iex"`,
].join('\n\n');

test('release validation rejects disagreeing package and lockfile versions', async () => {
  const root = await copyRelease();
  try {
    const { version } = await verifyRelease(root);
    await assert.rejects(verifyRelease(root, '0.0.0'), /Requested/);
    const file = join(root, 'runtime/package-lock.json');
    const lock = JSON.parse(await readFile(file));
    lock.packages[''].version = '0.0.0';
    await writeFile(file, JSON.stringify(lock));
    await assert.rejects(verifyRelease(root, version), /runtime\/package-lock/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('both source installers must pin this release from the maintained repository', async () => {
  const root = await copyRelease();
  try {
    const { version, tag } = await verifyRelease(root);
    const windows = join(root, 'scripts/install-windows.ps1');
    const original = await readFile(windows, 'utf8');
    // A stale usage comment would hand users an old one-liner.
    await writeFile(windows, original.replace(`/${tag}/`, '/source-v0.0.0/'));
    await assert.rejects(verifyRelease(root), /install-windows\.ps1/);
    await writeFile(windows, original.replace(`$SourceRef = '${tag}'`, "$SourceRef = 'source-v0.0.0'"));
    await assert.rejects(verifyRelease(root), /install-windows\.ps1/);
    await writeFile(windows, original);
    const mac = join(root, 'scripts/install-macos.sh');
    await writeFile(mac, (await readFile(mac, 'utf8')).replace('swcstudiospace/grokrouter', 'promptadvisers/grokrouter'));
    await assert.rejects(verifyRelease(root, version), /install-macos\.sh/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the tagged README pins both platforms to the new tag while candidates may keep the last one', async () => {
  const root = await copyRelease();
  try {
    const { version, tag } = await verifyRelease(root);
    const readme = join(root, 'README.md');
    await writeFile(readme, readmeFor(tag));
    assert.equal((await verifyRelease(root, version)).readmeTag, tag);
    await writeFile(readme, readmeFor('source-v0.0.1'));
    assert.equal((await verifyRelease(root)).readmeTag, 'source-v0.0.1');
    await assert.rejects(verifyRelease(root, version), /tagged commit must pin/);
    await writeFile(readme, readmeFor(tag, 'source-v0.0.1'));
    await assert.rejects(verifyRelease(root), /Windows to source-v0\.0\.1/);
    await writeFile(readme, readmeFor(tag, tag, 'promptadvisers/grokrouter'));
    await assert.rejects(verifyRelease(root), /README needs/);
    await writeFile(readme, readmeFor(tag).split('\n\n')[0]);
    await assert.rejects(verifyRelease(root), /README needs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a green build cannot substitute for live acceptance or a different candidate', () => {
  const names = ['mac-install-restore-reinstall', 'fresh-bot-controls', 'two-bot-isolation', 'channel-controls', 'codex-capabilities', 'openrouter-capabilities', 'clean-source-install'];
  const record = { version: '1.0.0', sourceDigest: 'abc', status: 'passed', supportedGrokVersions: ['test'], gates: Object.fromEntries(names.map(name => [name, {status: 'passed', evidence: 'test receipt', testedAt: '2026-09-08', versions: {test: {status: 'passed', evidence: 'test receipt', testedAt: '2026-09-08'}}}])) };
  assert.doesNotThrow(() => validateAcceptance(record, '1.0.0', 'abc', ['test']));
  assert.throws(() => validateAcceptance(record, '1.0.0', 'changed', ['test']), /candidate source/);
  assert.throws(() => validateAcceptance({...record, status: 'pending'}, '1.0.0', 'abc', ['test']), /pending/);
  assert.throws(() => validateAcceptance(record, '1.0.0', 'abc', ['test', 'new']), /every supported/);
  const incomplete = structuredClone(record);
  delete incomplete.gates['fresh-bot-controls'].versions.test;
  assert.throws(() => validateAcceptance(incomplete, '1.0.0', 'abc', ['test']), /on Grok Bot test/);
  delete record.gates['openrouter-capabilities'];
  assert.throws(() => validateAcceptance(record, '1.0.0', 'abc', ['test']), /openrouter-capabilities/);
});
