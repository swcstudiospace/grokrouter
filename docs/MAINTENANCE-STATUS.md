# Maintenance status

## Fork status (beta.48 candidate)

This repository, `swcstudiospace/grokrouter`, is the maintained fork. The `0.1.0-beta.48` candidate is pending live acceptance; its tag `source-v0.1.0-beta.48` does not exist until **Tag source release** runs after acceptance.

How the fork reached this point, from git history:

- No revert commit exists in the fork.
- The "0.30 and 0.44 only" refusal users saw came from the installers' hardcoded supported-version lists, not from a rollback.
- The README install command still downloaded upstream beta.46 from the original repository, so users got upstream code rather than the fork.
- Upstream separately published beta.47, which added 0.36.0 and removed structural host trust.
- Beta.48 merges upstream beta.47 and keeps the fork's providers, live model discovery, 0.44.0 manifest, and version tracking. 0.44.0 now sits under beta.47's exact per-version gates with a signed registry. Install commands, registry refresh, and the registry signing key now belong to this fork.

Open items:

| Item | State |
| --- | --- |
| Live 0.44.0 probe proving beta.47's three patch seams, then fresh-Bot acceptance | Pending |
| Live 0.61.0 host probe (self-hosted `grokbot-box` runner or manual) and review | Pending; 0.61.0 is usable only through the experimental opt-in |
| Live check of the unreviewed-version opt-in on a newer Grok Bot | Pending |
| Windows native install and fresh-Bot acceptance; first run of the new Windows source-installer CI smoke | Pending |
| Live Codex account catalog refresh, Anthropic and xAI provider runs | Pending |
| Beta.48 acceptance record, then the `source-v0.1.0-beta.48` tag | Pending acceptance |

See the [verification matrix](TEST-MATRIX.md) for each claim's evidence.

## Upstream beta.47

The exact production source `644a9c4` passed every required Mac live gate on official Grok Bot 0.30.0 and 0.36.0 on September 9, 2026. The [acceptance record](release-acceptance.json) and [verification matrix](TEST-MATRIX.md) contain the release decision and limitations. PR #12 merged with all required checks passing. The protected tag workflow passed and the upstream source prerelease `source-v0.1.0-beta.47` was published on September 9, 2026 ([publication record](release-beta47-publication.md)). The exact public install command downloaded, built, and installed successfully in an isolated test folder.

### Changes

- Restored exact stock hash and byte-count trust, authenticated previous-router upgrades by byte-for-byte reconstruction, and stopped automatic replacement of unknown or foreign live hosts from an older backup.
- Added separate official 0.36.0 desktop and signed host-registry gates, retaining strict 0.30.0 support and vendor-signature checks.
- Made desktop Doctor verify live adapter identity and stock-backup health independently. Install and Repair register native commands before restarting the host, with bounded workflow-specific deadlines and authoritative receipts.
- Repaired native slash invocations, reasoning status, durable per-Bot settings, addressed group controls, and independent continuation suppression.
- Repaired native child completion and single final delivery, bounded empty-response recovery, and receipt-backed one-time launch acknowledgments.
- Kept greetings tool-free, decoded exact literal delivery envelopes as inert text, and isolated native memory extraction and episode summaries from chat tools, threads, and completion state.
- Pinned Windows packaging dependencies and added version consistency, source-bound per-version acceptance, Mac/Windows CI, CodeQL, and protected release tagging.

### Verified

The final artifact passed install → verified stock restore → reinstall, strict desktop health, two genuinely new Bots per version, all six native menu controls, command edge cases, exact text, per-Bot and channel isolation, both providers' real computer tools and completed-child delivery, and clean source installation. Automated tests and required Mac/Windows/CodeQL checks passed. Known provider and platform limits are explicit in the matrix.

### Support disposition

These are upstream issue numbers from the beta.47 review.

| Issue | Disposition |
| --- | --- |
| #1 | Open: reported full host fingerprints have not been independently authenticated. No wildcard acceptance was added. |
| #2 | Open: truncated host fingerprint is insufficient for an exact compatibility entry. |
| #3 | Open: unknown/truncated host fingerprints and prior focus symptoms need exact safe diagnostics. |
| #5 | Open: native Windows timeout and prior-router state remain unverified. Windows is a source preview. |
| #7 | Closed: the official 0.36.0 version/Repair blocker is addressed and verified on the reviewed host. Reporter confirmation is distinct from maintainer acceptance. |
| #8 | Closed: the exact pinned source download returned HTTP 200. This closes the download defect only. |

The original implementation checkout and all unrelated local edits remain preserved; see [local-change reconciliation](LOCAL-CHANGE-RECONCILIATION.md). No proprietary host source or credentials are included in the repository or release payload.
