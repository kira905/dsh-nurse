# dsh-nurse · Safe-mode Repair Layer for DSH

> When the production instance will not start or behaves suspiciously, do not edit files on
> production in the dark. This toolkit gives you an isolated channel: start a safe instance from an
> **official-plugins-only** profile, in a **separate home**, on a **separate port (3091)**;
> collect the scene → inject a repair proposal → **whitelist validation** → execute (with
> pre-write backups) → verify (does production boot?) → **byte-exact rollback**, all recorded in a
> case state machine.
>
> Seven CLIs + thirteen library modules, **zero third-party runtime dependencies**.

---

## Read this first

### ① Only three of seven CLIs reject unknown arguments

| CLI | Unknown argument | Consequence |
|---|---|---|
| `nurse-orchestrate.mjs` | error, exit 2 | safe (fail-closed) |
| `restore-case.mjs` | error, exit 2 | safe |
| `retention.mjs` | error, exit 2 | safe |
| `collect-case.mjs` | silently ignored, keeps going | ⚠️ really collects (writes a case dir) |
| `nurse-ctl.mjs` | silently ignored | ⚠️ really starts / stops the 3091 instance |
| `make-nurse-profile.mjs` | silently ignored | ⚠️ really writes `.dsh-safe/profiles/nurse` |
| `nurse-verify.mjs` | silently ignored | ⚠️ really writes the evidence dir |

Since 2026-10-30 all seven CLIs implement `-h` / `--help` and reject unknown arguments (exit 2, never executes).
The argument tables below are the authoritative reference.

### ② Writes default to dry-run

`restore-case`, `retention`, `nurse-ctl start|stop` all support `--dry-run`, and for the first two the
dry-run gate lives **inside the write function**. `collect-case --dry-run` only prints the plan.

### ③ Host-only dependencies are NOT bundled

- `dsh-butler` kernel (`lane-gate.mjs`, `autonomy-state.mjs`, `residue-reaper.mjs`) and
  `dsh-upgrade-silence.mjs` are imported **dynamically by path** (`DSH_ROOT` / `DSH_BUTLER_LIB`
  overridable). When absent, the orchestrator **refuses to start** (`stage: 'lane-gate'` /
  `'degrade-gate'`, exit 3) — deliberate fail-closed behaviour, not a bug.
- The **local credential resolver** for `lib/dsh-host-rpc.mjs` is not published. Cookies come from
  `cookieSecret` → `DSH_RPC_COOKIE_SECRET` → optional local credential module.

### ④ Platform

Windows-first: `nurse-ctl` launches the instance through `lib/guard-launcher.mjs`
(`CreateProcessW`, hidden console); `lib/powershell-exe.mjs` prefers pwsh 7 and falls back to 5.1.
Instance-launching paths are not verified on Linux/macOS.

---

## 1. What it does

```
① collect the scene (read-only, redacted)          collect-case.mjs
①.5 takeover declaration (tell the guard: repairing)
② start the safe instance (official-only)          make-nurse-profile.mjs -> nurse-ctl.mjs
③ inject the repair proposal                       --proposal or --inject llm
④ whitelist validation + pre-write backup          lib/proposal-guard.mjs
④.8 smoke gate (before touching production)        lib/smoke-gate.mjs
⑤ verify (production boots / boot payload)         nurse-verify.mjs
⑥ report + terminal state + SLI                    lib/butler-bridge.mjs
⑦ on failure: byte-exact rollback                  restore-case.mjs
⑧ retention cleanup                                retention.mjs
```

`nurse-orchestrate.mjs` chains ①–⑥ (each step written to case state, resumable).

---

## Shared-source notice

Some files in this repository **share a source with an internal production implementation**
(the same engineering effort, evolved over time, with two landing places).

- **How much**: measured by the **line-level shared-source ratio** (among same-named comparable files, how
  many non-empty lines of this repository's files are found in the reference files, multiset-deducted); this
  repository's "≥50% line-share" figure is **100%**.
- **What that means**: this repository is a **distilled export** of that implementation — **neither a verbatim
  copy nor a fully rewritten independent implementation**. Before reading any single file as an "independent
  reference implementation", run the check below.
- **How to re-run it**: the shared-source scanner ships with `dsh-quality-toolkit` as `dsh-sim-scan.mjs`
  (`--repo <this repo> --prod-root <reference root>`); the bucket thresholds and the measurement caliber live
  in its `config/sim-scan.json`, not buried in code.
- **License**: see `LICENSE` at the repository root (when a subdirectory carries its own exception, that
  subdirectory's `LICENSE` wins).

## 2. Repository layout (20 files)

```
dsh-nurse/
├── collect-case.mjs              # scene pack collection (read-only, redacted, fail-open)
├── make-nurse-profile.mjs        # derive an official-bundles-only profile
├── nurse-ctl.mjs                 # start/stop/status the safe instance (three hard gates)
├── nurse-orchestrate.mjs         # orchestrator (①-⑥, fail-closed gates)
├── nurse-verify.mjs              # isolated-instance verification
├── restore-case.mjs              # byte-exact rollback of pre-write backups
├── retention.mjs                 # case retention cleanup (dry-run by default, never follows links)
├── lib/
│   ├── butler-bridge.mjs         # audit / alert / report / knowledge bridge (optional kernel)
│   ├── case-state.mjs            # case state machine (atomic writes, budget, SLI)
│   ├── misfix.mjs                # mis-repair rate judgement
│   ├── nurse-profile-report.mjs  # profile report parsing + legit heal-link detection
│   ├── proposal-guard.mjs        # proposal whitelist + pre-write backup + execute
│   ├── redact.mjs                # output redaction
│   ├── restart-advisory.mjs      # "restart recommended" channel (never restarts)
│   ├── smoke-gate.mjs            # smoke gate decision (pure, fail-closed)
│   ├── guard-launcher.mjs        # hidden-console launcher
│   ├── guard-http.mjs            # single source of the HTTP liveness rule
│   ├── powershell-exe.mjs        # PowerShell selection (pwsh 7 first)
│   ├── dsh-rpc-client.mjs        # DSH Host HTTP RPC client (publishable piece)
│   └── dsh-host-rpc.mjs          # thin shell over the above + withDshHome()
├── README.md / README.en.md / CHANGELOG.md / LICENSE / package.json
├── .gitignore / .gitattributes
```

---

## 3. Requirements

- **Node.js ≥ 20**, **Windows** (instance launching / PowerShell actions)
- Main package `@deepseek-ai/dsh` installed in the default global npm location
  (`nurse-ctl` uses `APPDATA/npm/node_modules/@deepseek-ai/dsh/lib/bin.js`)
- You provide: `pwsh`, the main package, the optional `dsh-butler` kernel

| Variable | Meaning | Default |
|---|---|---|
| `DSH_ROOT` | workspace root (`logs/`, `tools/`) | `~/DSH` |
| `DSH_HOME` / `BUTLER_DSH_HOME` | DSH home | `~/.dsh` |
| `DSH_BUTLER_LIB` | `dsh-butler/lib` | `<DSH_ROOT>/tools/dsh-butler/lib` |
| `DSH_SMOKE_SCRIPT` | smoke script path (unset ⇒ gate blocks) | empty |
| `DSH_RPC_COOKIE_SECRET` | RPC cookie secret (base64) | empty |
| `DSH_NURSE_SAFE_ROOT` | safe home root | `~/.dsh-safe` |
| `NURSE_SMOKE` / `NURSE_RESTART_ADVISORY` | `0` disables | enabled |

---

## 4. Commands (the authoritative argument table)

| CLI | Arguments | Notes |
|---|---|---|
| `collect-case.mjs` | *(none)* · `--dry-run` · `--tail <n>` · `--days <n>` · `--prune` · `--with-config-dump` | unknown args ignored |
| `make-nurse-profile.mjs` | *(none)* · `--dry-run` · `--modules <self-links\|junction-prod\|none>` · `--home <p>` · `--source <dir>` | home must live under `.dsh-safe` |
| `nurse-ctl.mjs` | `status` · `start [--dry-run] [--port 3091] [--profile nurse] [--home <p>] [--cwd <d>]` · `stop [--dry-run]` | refuses 3080; single-instance mutex |
| `nurse-orchestrate.mjs` | `--plan` / `--apply` · `--proposal <json>` · `--inject llm` · `--port <n>` · `--case <id>` · `--safe-root <d>` · `--no-smoke` / `--smoke-script <p>` / `--allow-smoke-skip` · `--no-silence` · `--allow-degraded` · `--json` · `--help` | unknown args rejected |
| `nurse-verify.mjs` | *(none)* · `--baseline` · `--safe-root <d>` · `--attribution` · `--port <n>` | unknown args ignored |
| `restore-case.mjs` | `--case <dir>` / `--latest` · `--apply` · `--only <path>` · `--force` · `--no-audit` · `--json` · `--help` | unknown args rejected |
| `retention.mjs` | *(none)* · `--apply` · `--allow-production` · `--safe-root <d>` · `--days <n>` · `--json` | unknown args rejected |

Exit codes: `0` ok · `1` failure / environment · `2` usage or hard gate · `3` environment or gate
(orchestrator: lane-gate / degrade-gate).

---

## 5. Isolated-discipline (hard-coded)

1. **Home gate**: every write target must live under `~/.dsh-safe` (`DSH_NURSE_SAFE_ROOT` moves the root).
2. **Port gate**: 3080 refused; 3091 occupied ⇒ error, never kill the occupant.
3. **Proposal whitelist**: only `write` / `mkdir` / `copy`; paths must stay under allowed roots.
4. **Pre-write backup**: every touched file copied to `case-<ts>/before/` with sha256.
5. **Never follow links**: junctions / symlinks are skipped or refused.
6. **Dry-run by default** for restore / retention / ctl.
7. **Never auto-restart**: `restart-advisory` only files a to-do card.

---

## 6. Known limitations

- All seven CLIs implement `--help` (exit 0) and reject unknown arguments (exit 2) since 2026-10-30.
- With the kernel absent the orchestrator refuses to run (intentional).
- `smoke-gate` is unavailable unless `DSH_SMOKE_SCRIPT` is set.
- Without the local credential module you must pass `cookieSecret` / `DSH_RPC_COOKIE_SECRET`.
- Not verified on non-Windows platforms.
- The `_test/` suite (11 files) is **not** published: its assertions are tied to private-tree
  literals and absolute imports, so they would fail after sanitisation. See the Chinese README §8.

---

## 7. License

**AGPL-3.0 + commercial license (dual licensing)**, see [LICENSE](./LICENSE).
Personal / study / open-source use: free under AGPL-3.0 (derivatives must stay AGPL-3.0).
Closed-source / commercial use: obtain a commercial license via a repository Issue.

---

## 8. Related repositories

`dsh-butler-archive` · `dsh-diagnostics-extra` · `dsh-quality-toolkit` · `dsh-ops-toolkit` ·
`dsh-board-toolkit` · `dsh-memory-toolkit` · `dsh-imgtmpl` · `dsh-gongwen` ·
`dsh-api-balance-folded` · `dsh-notekit` · `dsh-host-adapter-client` (same names on GitHub and Gitee).
