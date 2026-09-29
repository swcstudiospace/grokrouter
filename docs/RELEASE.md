# Source release procedure

GrokRouter is distributed as source from the canonical repository `swcstudiospace/grokrouter`. The Mac source installer builds and ad-hoc signs the application locally; the Windows source installer builds it locally from the same tag. Windows remains a preview until its native lifecycle is verified. No release, command, or registry URL may point at another repository.

## Prepare the candidate

1. Start from current main on a separate branch. Preserve unrelated local changes.
   If the Grok Bot feed reports a version with no manifest (`python3 scripts/check-grokbot-version.py`), follow [VERSION-TRACKING.md](VERSION-TRACKING.md) first. Never edit a version string merely to get past the gate.
2. Keep all package and lockfile versions, the runtime version, host error version, and remote installer version consistent. Both source installers must pin the canonical repository and the candidate tag: `REPOSITORY`/`SOURCE_REF` in `scripts/install-macos.sh` and `$Repository`/`$SourceRef` (including the usage comment) in `scripts/install-windows.ps1`. The README must contain the macOS and Windows install commands for `swcstudiospace/grokrouter`, both pinned to the same tag. Run `node scripts/verify-release.mjs`; it enforces all of this.
3. The README may name the candidate tag before it exists, but must also give the from-clone alternative for each platform and say that the tag is published only after live acceptance. `source-v0.1.0-beta.48` does not exist yet; the **Tag source release** workflow creates it after the acceptance record passes.
4. Run `npm ci --prefix runtime --ignore-scripts --no-audit --no-fund`, `npm test`, and `npm run build:macos`. Windows CI must build both architectures and their Setup artifacts, parse `scripts/install-windows.ps1` with Windows PowerShell and `pwsh`, and run the source installer twice from the checkout.
5. Test the source installer from a clean candidate ZIP using a separate Applications test directory and `GROKROUTER_NO_OPEN=1`. Verify the actual built app version, signature, and archive checksum.

## Record live acceptance

Install the exact candidate on a supported Mac. Complete install → explicit verified stock restore → reinstall. Then create genuinely new Bots and complete every requirement in [FRESH-BOT-ACCEPTANCE.md](FRESH-BOT-ACCEPTANCE.md), including each enabled provider's actual tool results, returned-child result, no duplicate delivery, native slash discovery, deterministic controls, and per-Bot isolation. Also verify channel controls and independent request behavior.

Store redacted visible and runtime receipts in the verification record. Do not upload credentials, raw conversations unrelated to the tests, private Bot files, or proprietary host source.

`docs/release-acceptance.json` must identify the candidate version, supported Grok app versions, a passed result and evidence for every required gate, and the current digest from:

```bash
node scripts/verify-acceptance.mjs --digest
```

Then verify it:

```bash
node scripts/verify-acceptance.mjs
```

A changed production source invalidates the record. Rerun the affected live checks and record the complete candidate status before updating the digest; do not simply copy the new digest into an old record. A failed or missing provider capability is not a release pass. Earlier version evidence cannot substitute for the current candidate.

## Publish without a broken download interval

1. Commit the candidate, evidence, and release notes. Open a PR and wait for the required Mac and Windows checks and CodeQL analysis. Resolve findings before merging.
2. Merge the verified candidate. Main requires passing checks; do not bypass protection.
3. Dispatch **Tag source release** for the exact version on main, or use `[tag-release]` in the release commit message. The workflow reruns CI for that commit, runs `node scripts/verify-release.mjs <version>` (the tagged README must pin that exact tag on both platforms), checks the source-bound live record, then creates the annotated source tag. A published tag must never be moved. A repeated run is allowed only if the tag already names the identical commit.
4. Verify the tag resolves to the accepted commit, download both pinned installers and the source archive, and verify the downloaded source. Existing Actions artifacts are not a substitute for this public-download check.
5. Remove the candidate notice and from-clone fallback wording from the README in a documentation-only PR, and state only the versions and capabilities the release proved.
6. Publish source release notes linking the immutable tag and its known limitations. Do not attach an unsigned Mac binary as a beginner download.
7. Reconcile support issues with the verified fixes. Distinguish an original failure that is fixed from a subsequent unsupported-version report, and avoid claiming user confirmation that has not arrived.

## Exact host compatibility

The desktop app version and cloud-host hash are separate gates. A rotating cloud host must have an independently reviewed exact SHA-256 and byte count, every required anchor and patch seam exactly once, a successful read-only transformation/syntax check, and live acceptance. A newer desktop app also needs its own inspected and tested compatibility entry ([VERSION-TRACKING.md](VERSION-TRACKING.md)). Never change only the version string to bypass a refusal.

Structural checking provides a safe diagnostic fingerprint. It does **not** establish stock provenance and cannot authorize patching or restoration of a reviewed version's host. The single exception is the user's explicit, default-off opt-in for a Grok Bot strictly newer than every reviewed version; it never applies to a reviewed, older, or in-between version. An unknown or foreign live host stays untouched even when an older trusted backup exists. Upgrade reconstruction is limited to known router transformations over an exactly trusted original. Explicit stock restoration is a separate user operation.

For a registry update:

1. Collect `HOSTSHA1`, `HOSTSHA2`, `HOSTBYTES`, `CLOUDARCH`, `ANCHORS`, `PATCHANCHORS`, and `PATCHDRYRUN`.
2. Inspect the untouched stock host through the local or Bot-computer development workflow. Keep proprietary source outside the repository and release payload.
3. Add only the independently reviewed exact pair to the appropriate compatibility file.
4. Sign with `node scripts/sign-host-registry.mjs compatibility/<version>-hosts.json`. The fork's private key remains at `~/.config/grokrouter/release/host-registry-private.pem` (override with `GROKROUTER_HOST_REGISTRY_PRIVATE_KEY`); never print or copy it into the workspace, CI, or a log. Its public half is `compatibility/registry-public-key.pem`. The fork generated this key; upstream signatures are not trusted, and every shipped registry must verify with it.
5. Verify signature acceptance and tamper rejection, then the exact live repair and fresh-Bot gate before publishing support for that host.
6. Commit the registry and signature together. Installed routers download updates from `https://raw.githubusercontent.com/swcstudiospace/grokrouter/main/compatibility/` and verify the signature against the bundled public key.

Changing anchors, the transformation, supported desktop versions, or the signing key requires a new installer and complete acceptance, not merely a registry update.

Every release gate must contain separate dated evidence under `versions` for each exact version in `compatibility/supported-apps.json`. A successful test on one desktop version cannot authorize another. Keep signatures and host manifests separated by desktop version. The unreviewed-version opt-in is not a release claim for any version; it needs its own live check (see [FRESH-BOT-ACCEPTANCE.md](FRESH-BOT-ACCEPTANCE.md)) but never substitutes for a reviewed manifest.
