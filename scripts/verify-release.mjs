#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'swcstudiospace/grokrouter';
const RAW = `https://raw\\.githubusercontent\\.com/${REPOSITORY.replace('/', '\\/')}/(source-v[\\w.-]+)/scripts`;
const MAC_COMMAND = new RegExp(`/usr/bin/curl [^\\n]*${RAW}/install-macos\\.sh[^\\n]*/bin/bash /tmp/grokrouter-install\\.sh`);
const WINDOWS_COMMAND = new RegExp(`powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${RAW}/install-windows\\.ps1 \\| iex"`);

// A `requested` version means the commit is being tagged. Otherwise the README
// may keep the last published tag while a candidate is prepared: advancing it
// before the tag exists caused issue #8. The tagged commit must pin itself.
export async function verifyRelease(root, requested) {
  const read = (path) => readFile(resolve(root, path), 'utf8');
  const json = async (path) => JSON.parse(await read(path));
  const version = (await json('package.json')).version;
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(version)) throw new Error('Invalid release version');
  if (requested && requested !== version) throw new Error(`Requested ${requested}; checked-out source is ${version}`);
  const tag = `source-v${version}`;
  for (const path of ['runtime/package.json', 'installer-windows/package.json', 'runtime/package-lock.json', 'installer-windows/package-lock.json']) {
    const data = await json(path);
    if (data.version !== version || (data.packages && data.packages['']?.version !== version)) throw new Error(`${path} does not match ${version}`);
  }
  if (!(await read('runtime/run-provider.mjs')).includes(`const ROUTER_VERSION = "${version}";`)) throw new Error('Runtime version mismatch');
  if (!(await read('patch/router_patch.py')).includes(`version: "${version}"`)) throw new Error('Host adapter version mismatch');
  if (!(await read('remote/install.sh')).includes(`ROUTER_VERSION="${version}"`)) throw new Error('Remote installer version mismatch');
  const sourceInstallers = {
    'scripts/install-macos.sh': [`REPOSITORY="${REPOSITORY}"`, `SOURCE_REF="${tag}"`],
    'scripts/install-windows.ps1': [`$Repository = '${REPOSITORY}'`, `$SourceRef = '${tag}'`],
  };
  for (const [path, required] of Object.entries(sourceInstallers)) {
    const text = await read(path);
    // Every pinned ref, including the usage comment, must be this release.
    const refs = new Set(text.match(/source-v[\w.-]+/g) || []);
    if (!required.every((line) => text.includes(line)) || refs.size !== 1 || !refs.has(tag)) throw new Error(`Source installer version mismatch: ${path}`);
  }
  // Info.plist is a build template; the build writes both actual version fields.
  const readme = await read('README.md');
  const mac = readme.match(MAC_COMMAND);
  const windows = readme.match(WINDOWS_COMMAND);
  if (!mac || !windows) throw new Error(`README needs immutable ${REPOSITORY} source installer commands for macOS and Windows`);
  if (mac[1] !== windows[1]) throw new Error(`README pins macOS to ${mac[1]} but Windows to ${windows[1]}`);
  if (requested && mac[1] !== tag) throw new Error(`README pins ${mac[1]}; the tagged commit must pin ${tag}`);
  return { version, tag, readmeTag: mac[1] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyRelease(process.cwd(), process.argv[2]);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
