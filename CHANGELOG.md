# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [0.1.0] - 2026-10-19

### Added

- **`collect-case.mjs`** — read-only, redacted scene pack collection (logs / guard state / DSH home),
  fail-open per section, `--prune` retention.
- **`make-nurse-profile.mjs`** — derive an official-bundles-only profile from the production profile
  (whitelist by `@deepseek-ai/` prefix), idempotent, hard-gated on the safe home.
- **`nurse-ctl.mjs`** — start / stop / status the safe instance on a separate port; three hard gates
  (home, single-instance mutex, port) and a never-misfire stop gate.
- **`nurse-orchestrate.mjs`** — orchestrator for collect → launch → inject → validate → execute →
  verify → report, with fail-closed lane / degrade gates and a smoke gate call site.
- **`nurse-verify.mjs`** — isolated-instance verification: HTTP liveness, boot payload, official-only
  plugin set, API probe, strict-surface zero-change, and an attribution experiment.
- **`restore-case.mjs`** — byte-exact rollback of pre-write backups (sha256 verified on both ends,
  reverse order, link-refusing).
- **`retention.mjs`** — case retention cleanup: dry-run by default, config-gated apply,
  production root requires `--allow-production`, never follows links.
- **`lib/`** — `butler-bridge`, `case-state`, `misfix`, `nurse-profile-report`, `proposal-guard`,
  `redact`, `restart-advisory`, `smoke-gate` (the toolkit's own modules), plus published dependency
  pieces `guard-launcher`, `guard-http`, `powershell-exe`, `dsh-rpc-client`, and the new thin shell
  `dsh-host-rpc`.
- `package.json` with `bin` entries, AGPL-3.0 + commercial dual licensing.

### Changed (relative to the private source tree)

- **Every machine-absolute path is gone**: the workspace root resolves through `DSH_ROOT`
  (default `~/DSH`); the DSH home honours `DSH_HOME` / `BUTLER_DSH_HOME`; backups honour
  `DSH_ARCHIVE_DIR`.
- Absolute `file:///…` imports of `guard-launcher.mjs` / `guard-http.mjs` / `powershell-exe.mjs`
  were replaced with **relative** imports after those pieces were copied into `lib/`.
- `nurse-orchestrate.mjs` / `nurse-verify.mjs` now import the RPC shim from `./lib/dsh-host-rpc.mjs`.
  The published shim re-exports the **publishable** `dsh-rpc-client.mjs` and keeps `withDshHome()`;
  the local credential resolver is not published (cookies come from `cookieSecret` /
  `DSH_RPC_COOKIE_SECRET`).
- `smoke-gate`'s default smoke script no longer points at a private test tree; it comes from
  `DSH_SMOKE_SCRIPT` (unset ⇒ `unavailable` ⇒ the gate blocks, fail-closed).
- `restore-case`'s audit module path now resolves through `DSH_BUTLER_LIB`.
- The `_test/` suite (11 files) is **not** part of this release (see README §8).
