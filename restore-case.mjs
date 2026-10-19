#!/usr/bin/env node
/**
 * restore-case.mjs —— 小护士 case **写前备份的逐字节回滚器**（D-R-2 / C-G4 · 2026-10-10 · 卡 cf217275）
 *
 * ── 缺口（台账3 K 域 D-R-2 🔴）──
 *   备份侧早在（`lib\proposal-guard.mjs#executeProposal` 落 `case-<ts>\before\` + sha256），
 *   但 `tools\dsh-nurse\` 19 个文件里 `restore|rollback` **0 命中** ⇒ 「写前必备份 + **一键恢复脚本**」
 *   只有前半句（方案 §5 G4）。回滚只能靠人手工把 `before\` 里的文件拷回去 ——
 *   既不知道拷哪、也不知道拷完了对不对。
 *
 * ── 本脚本做什么 ──
 *   读 `case-<ts>\manifest.json`（执行器写的 `backups[]`），**逐文件**：
 *     ① 核备份副本 sha256 == manifest 记录的 `sha256`（备份自身坏了就拒，fail-closed）
 *     ② 把副本写回 `backups[].path`（**不存在即建父目录**；绝不递归删、绝不碰目录）
 *     ③ 写回后**再核一次 sha256**（逐字节回滚的判据）
 *   输出**三件结论**（照方案 §5 G4 / 卡要点 2）：
 *     · **hash**：每个文件的 `before(备份) / after(落地)` 两个 sha256 + 汇总 `allMatch`
 *     · **字节**：备份字节数 vs 落地字节数（逐文件 + 合计）
 *     · **链接**：`lstat().nlink` + 是否符号链接/junction（**是链接一律拒动** —— 不跟链接是铁律）
 *
 * ── 硬闸（fail-closed；每一条都对应一次真机教训）──
 *   ① **默认 dry-run**：不传 `--apply` 只报告（`runRestore()` 内部第一道门，不在 CLI 层装饰）；
 *   ② **只动 manifest 里显式列出的文件**：不扫目录、不猜路径、不递归、不删任何东西；
 *   ③ **目标/备份是链接 ⇒ 拒**（junction 递归写会跟到别的树；`Remove-Item -Recurse` 先例）；
 *   ④ **备份副本 sha 与 manifest 不符 ⇒ 拒**（宁可不回滚，也不把坏副本盖回生产）；
 *   ⑤ 回滚顺序 = **倒序**（后写的先回），与 `applied` 顺序相反；
 *   ⑥ 环境不可用（case 目录/manifest 不存在）≠ 失败：明确 exit 3 并说清缺什么。
 *
 * 用法：
 *   node restore-case.mjs --case <case目录>              # dry-run：只报告将回滚什么
 *   node restore-case.mjs --case <case目录> --apply      # 真回滚
 *   node restore-case.mjs --latest --safe-root <dir>     # 取该安全根里**最近**一个有备份的 case
 *   [--only <目标文件绝对路径>]... [--force] [--json] [--no-audit] [--home <dir>]
 * 退出码：0 正常（含"无可回滚项"）· 1 有项未还原 · 2 用法错 · 3 环境不可用
 *
 * ⚠️ **未过演练不许列桌面一键项**（方案 §5 G4 原文）：本脚本 2026-10-10 已过 L1 沙箱演练
 *    （见 `_archive\nurse-b6-20261010-084543\drill-record-*.json`），但**桌面入口故意未建**
 *    —— 它需要一个"选哪个 case"的交互，属另一件事（见该卡交付报告 §待拍板）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const EXIT_OK = 0
export const EXIT_FAIL = 1
export const EXIT_USAGE = 2
export const EXIT_ENV = 3
export const DEFAULT_SAFE_ROOT = path.join(os.homedir(), '.dsh-safe')
const AUDIT_MODULE = path.join(process.env.DSH_BUTLER_LIB || path.join(os.homedir(), 'DSH', 'tools', 'dsh-butler', 'lib'), 'audit.mjs')

/** 参数解析（同时支持 `--k v`；未知参数一律拒，别静默忽略）。 */
export function parse(argv) {
  const o = { apply: false, force: false, caseDir: null, latest: false, safeRoot: DEFAULT_SAFE_ROOT, only: [], json: false, audit: true, home: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] ?? '')
    const next = () => String(argv[++i] ?? '')
    if (a === '--apply') o.apply = true
    else if (a === '--force') o.force = true
    else if (a === '--case') o.caseDir = path.resolve(next())
    else if (a === '--latest') o.latest = true
    else if (a === '--safe-root') o.safeRoot = path.resolve(next())
    else if (a === '--only') o.only.push(path.resolve(next()))
    else if (a === '--json') o.json = true
    else if (a === '--no-audit') o.audit = false
    else if (a === '--home') o.home = path.resolve(next())
    else if (a === '--help' || a === '-h') o.help = true
    else if (a.trim()) o.unknown = a
  }
  return o
}

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') } catch { return null }
}

/** 安全根的 `case-<ts>` 里挑**最近**一个 manifest 带非空 `backups[]` 的（只读）。 */
export function latestCaseWithBackups(safeRoot = DEFAULT_SAFE_ROOT) {
  let names = []
  try { names = fs.readdirSync(safeRoot) } catch { return null }
  const cands = []
  for (const n of names) {
    if (!/^case-/.test(n)) continue
    const dir = path.join(safeRoot, n)
    try {
      const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
      if (Array.isArray(mf.backups) && mf.backups.length) cands.push({ dir, at: fs.statSync(dir).mtimeMs, n: mf.backups.length })
    } catch { /* 无 manifest / 坏 manifest ⇒ 不是可回滚 case */ }
  }
  cands.sort((a, b) => b.at - a.at)
  return cands[0] ?? null
}

/**
 * 核心：算出/执行回滚。**dry-run 在这里判**（`opts.apply !== true` ⇒ 一条都不写）。
 * @param {object} o parse() 产出
 * @param {{auditMod?:object}} [deps]
 */
export function planRestore(o, deps = {}) {
  let caseDir = o.caseDir
  if (!caseDir && o.latest) {
    const hit = latestCaseWithBackups(o.safeRoot)
    if (!hit) return { env: true, reason: `安全根 ${o.safeRoot} 下没有带写前备份的 case（无可回滚项）` }
    caseDir = hit.dir
  }
  if (!caseDir) return { usage: true, reason: '缺少 --case <case目录>（或 --latest）' }
  const manifestFile = path.join(caseDir, 'manifest.json')
  if (!fs.existsSync(caseDir)) return { env: true, reason: `case 目录不存在：${caseDir}` }
  if (!fs.existsSync(manifestFile)) return { env: true, reason: `case 里没有 manifest.json（没有它无法知道备份该回滚到哪）：${manifestFile}` }
  let mf
  try { mf = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch (e) {
    return { env: true, reason: `manifest.json 不是合法 JSON：${e.message}` }
  }
  const entries = Array.isArray(mf.backups) ? mf.backups : []
  const dryRun = o.apply !== true   // ① 函数内第一道门
  const rows = []
  let restored = 0
  let failed = 0
  let skipped = 0
  // ⑤ 倒序：后写的先回
  for (const e of [...entries].reverse()) {
    const target = e && typeof e.path === 'string' ? path.resolve(e.path) : null
    const backup = e ? (typeof e.backup === 'string' && path.isAbsolute(e.backup) ? e.backup : (e.backupRel ? path.join(caseDir, e.backupRel.replace(/\//g, path.sep)) : null)) : null
    const row = {
      target, backup, backupRel: e ? (e.backupRel ?? null) : null, expectedSha: e ? (e.sha256 ?? null) : null,
      backupSha: null, beforeBytes: null, afterBytes: null, nlink: null, isLink: false,
      action: null, note: '',
    }
    if (!target || !backup) { row.action = 'error'; row.note = 'manifest 条目缺 path/backup ⇒ 拒（不猜）'; failed++; rows.push(row); continue }
    if (o.only.length && !o.only.includes(target)) continue
    // ③ 链接闸（先 lstat，别跟随）
    let lst = null
    try { lst = fs.lstatSync(target) } catch { lst = null }
    if (lst && lst.isSymbolicLink()) { row.action = 'refuse'; row.note = `目标是符号链接/junction ⇒ 拒动（不跟链接）`; row.isLink = true; failed++; rows.push(row); continue }
    let lbak = null
    try { lbak = fs.lstatSync(backup) } catch { lbak = null }
    if (!lbak) { row.action = 'error'; row.note = `备份副本不存在：${backup}`; failed++; rows.push(row); continue }
    if (lbak.isSymbolicLink()) { row.action = 'refuse'; row.note = '备份副本是符号链接/junction ⇒ 拒（不跟链接）'; row.isLink = true; failed++; rows.push(row); continue }
    row.backupSha = sha256File(backup)
    row.beforeBytes = lbak.size
    row.nlink = lst ? lst.nlink : null
    // ④ 备份自检：与 manifest 记录比对（只在 manifest 有 sha 时）
    if (row.expectedSha && row.backupSha !== row.expectedSha && o.force !== true) {
      row.action = 'refuse'
      row.note = `备份副本 sha ≠ manifest 记录（${String(row.backupSha).slice(0, 12)} ≠ ${String(row.expectedSha).slice(0, 12)}）⇒ 拒（要强回加 --force）`
      failed++; rows.push(row); continue
    }
    if (row.backupSha === null) { row.action = 'error'; row.note = '备份副本读不出 sha256'; failed++; rows.push(row); continue }
    const curSha = sha256File(target)
    row.currentSha = curSha
    if (curSha === row.backupSha) { row.action = 'skip'; row.note = '当前内容已等于备份内容（无需回滚）'; skipped++; rows.push(row); continue }
    if (dryRun) { row.action = 'plan'; row.note = 'dry-run：将把备份副本写回（未写盘）'; rows.push(row); continue }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(backup, target)
      const after = sha256File(target)
      row.afterBytes = fs.statSync(target).size
      row.nlink = fs.lstatSync(target).nlink
      if (after === row.backupSha) { row.action = 'restored'; restored++ } else { row.action = 'error'; row.note = `写回后 sha 不符（${String(after).slice(0, 12)} ≠ ${String(row.backupSha).slice(0, 12)}）`; failed++ }
    } catch (err) { row.action = 'error'; row.note = String(err && err.message ? err.message : err); failed++ }
    rows.push(row)
  }
  const allMatch = rows.filter((r) => r.action === 'restored').every((r) => r.afterBytes === r.beforeBytes)
  return {
    ok: failed === 0, env: false, dryRun, caseDir, manifestFile,
    kind: mf.kind ?? null, backupLayout: mf.backupLayout ?? 'legacy-flat（basename 落盘 · D-R-1 修复前）',
    entries: entries.length, rows, restored, failed, skipped,
    conclusions: {
      hash: { allMatch: failed === 0, perFile: rows.map((r) => ({ target: r.target, backup: r.backupSha, landed: r.action === 'restored' ? r.backupSha : r.currentSha })) },
      bytes: { totalBackup: rows.reduce((a, r) => a + (r.beforeBytes ?? 0), 0), totalLanded: rows.reduce((a, r) => a + (r.afterBytes ?? r.beforeBytes ?? 0), 0) },
      links: { symlinkRefused: rows.filter((r) => r.isLink).length, nlinks: rows.map((r) => ({ target: r.target, nlink: r.nlink })) },
    },
  }
}

/** 审计一行（fail-open；`--no-audit` 或不传 home 时走生产审计）。 */
async function leaveTrace(o, res, deps = {}) {
  if (o.audit === false || res.env || res.dryRun) return { ok: true, skipped: res.dryRun ? 'dry-run 不留审计' : 'enabled=false' }
  try {
    const mod = deps.auditMod ?? await import(pathToFileURL(AUDIT_MODULE).href)
    return mod.appendAudit({
      kind: 'nurse', event: 'nurse-case-restore', caseId: path.basename(res.caseDir),
      restored: res.restored, failed: res.failed, skipped: res.skipped, entries: res.entries,
      allMatch: res.conclusions.hash.allMatch, bytes: res.conclusions.bytes.totalLanded,
      targets: res.rows.filter((r) => r.action === 'restored').map((r) => r.target).slice(0, 20),
    }, o.home ? { home: o.home } : {})
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
}

function main() {
  const o = parse(process.argv.slice(2))
  if (o.help) {
    console.log('用法：node restore-case.mjs --case <case目录> [--apply]  或  --latest --safe-root <dir> [--apply]')
    console.log('      输出三件结论：hash / 字节 / 链接；默认 dry-run。')
    process.exitCode = EXIT_OK
    return
  }
  if (o.unknown) { console.error(`✗ 未知参数：${o.unknown}`); process.exitCode = EXIT_USAGE; return }
  const res = planRestore(o)
  if (res.usage) { console.error(`✗ ${res.reason}`); process.exitCode = EXIT_USAGE; return }
  if (res.env) { console.error(`✗ ${res.reason}`); process.exitCode = EXIT_ENV; return }
  const run = async () => {
    const trace = await leaveTrace(o, res)
    if (o.json) { console.log(JSON.stringify({ ...res, audit: trace }, null, 2)); process.exitCode = res.ok ? EXIT_OK : EXIT_FAIL; return }
    console.log(`小护士 case 回滚（${res.dryRun ? 'dry-run · 未写盘' : 'apply'}）`)
    console.log(`  case：${res.caseDir}`)
    console.log(`  备份布局：${res.backupLayout} · 备份项 ${res.entries} 个`)
    for (const r of res.rows) console.log(`  [${r.action}] ${r.target}\n        ${r.note}${r.backupSha ? ` · sha ${String(r.backupSha).slice(0, 12)} · ${r.beforeBytes}B · nlink ${r.nlink ?? '—'}` : ''}`)
    console.log(`  三件结论：hash 全等=${res.conclusions.hash.allMatch} · 字节 备份${res.conclusions.bytes.totalBackup} → 落地${res.conclusions.bytes.totalLanded} · 链接 拒动${res.conclusions.links.symlinkRefused}（nlink 已逐文件列出）`)
    console.log(`  ${res.dryRun ? '计划' : '已还原'} ${res.dryRun ? res.rows.filter((r) => r.action === 'plan').length : res.restored} · 跳过 ${res.skipped} · 失败 ${res.failed}${res.dryRun ? '（加 --apply 执行）' : ''}`)
    console.log(`  审计：${trace.ok ? (trace.skipped ?? 'ok') : `失败（不阻断）：${trace.error}`}`)
    process.exitCode = res.ok ? EXIT_OK : EXIT_FAIL
  }
  return run()
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] || '').toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase() } catch { return false }
})()
if (isMain) {
  try { await main() } catch (e) { console.error(`✗ restore-case 异常：${e && e.stack || e}`); process.exitCode = EXIT_FAIL }
}
