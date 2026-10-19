#!/usr/bin/env node
/**
 * retention.mjs —— 小护士 case 现场包的保留期清理（方案 §5.1 retention 行 · 主人 2026-09-21 D3 拍板
 *   「retention 挂 tickd」；配套 tickd job `nurse-retention`）
 *
 * 为什么单独一个脚本（而不是复用 `collect-case.mjs --prune`）：
 *   ① `collect-case.mjs --prune` 只在**人工**跑采集器时才会被执行（实测：`~/.dsh-safe` 下 9 个 case
 *      全在位、age 6.46 天 ⇒ **无界累积**）；tickd job 需要一个**零副作用、默认不删、失败容忍**的入口。
 *   ② 删文件**不可逆**（方案 §4.4 修订块 D3 明写：必须 dry-run + 留痕 + 审计）。
 *
 * ── 安全设计（fail-closed；每一条都对应一次真机教训）─────────────────────────────
 *   ① **默认 dry-run**：不传 `--apply` 只报告。真删放行 = 改**配置**不是改代码
 *      （`~/.dsh/butler-nurse-retention.json` 的 `apply:true`，缺省 false）。
 *   ② `--apply` 打**默认 safeRoot**（`~/.dsh-safe`）还必须显式 `--allow-production`
 *      （照 2026-09-17 六包施工 ①-2 卡事故的加固口径：沙箱参数解析失败会静默回落生产根）。
 *   ③ **路径硬闸**：待删目录必须 `path.resolve()` 后落在 safeRoot 之下、名字以 `case-` 开头；
 *      `safeRoot` 自身一律不删。
 *   ④ **不跟链接**（persona 铁律）：`lstatSync().isSymbolicLink()` 为真的目录**跳过 + 告警**
 *      —— junction/reparse point 递归删会**跟随链接删掉目标内容**（`<DSH_ROOT>\_archive` 等先例）。
 *   ⑤ **保留期判据取 case 自己的事实**：优先 `case-<ts>/state.json` 的 `updatedAt`（回退 `manifest.createdAt`、
 *      再回退目录 mtime）—— 不用 mtime 单判，避免杀软/备份工具扫一下就"续命"。
 *
 * ── 失败容忍（tickd 纪律）──────────────────────────────────────────────────
 *   单条删除失败 / safeRoot 不存在 / 无过期项 ⇒ 一律 **exit 0**（只记留痕），
 *   避免 `lib\tickd-health.mjs`（failures≥2 且 lastStatus!=ok ⇒ 🟡/🔴）天天刷日报。
 *   只有**用法错误**（未知参数）与 `--apply` 打生产根没带 `--allow-production` 才非 0。
 *
 * 用法：
 *   node retention.mjs [--dry-run|--apply] [--allow-production] [--safe-root <dir>]
 *                      [--retention-days 7] [--json] [--no-audit] [--no-report]
 * 退出码：0 正常（含"无过期项"/"单项失败但整体完成"）· 2 用法或闸拒绝 · 3 环境不可用（safeRoot 不在）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_ROOT = process.env.DSH_ROOT || path.join(os.homedir(), 'DSH')
const DSH_BUTLER_LIB = path.join(DSH_ROOT, 'tools', 'dsh-butler', 'lib')
const DEFAULT_SAFE_ROOT = path.join(os.homedir(), '.dsh-safe')
const CONFIG_FILE = path.join(os.homedir(), '.dsh', 'butler-nurse-retention.json')
const REPORT_DIR = path.join(DSH_ROOT, 'logs')

export const EXIT_OK = 0
export const EXIT_USAGE = 2
export const EXIT_ENV = 3
export const RETENTION_DAYS_DEFAULT = 7

/** 解析参数（**同时支持 `--k v` 与 `--k=v`** —— 单 token 形态必须解析成功，见文件头 ②）。 */
export function parse(argv) {
  const o = { apply: false, forceDry: false, allowProduction: false, safeRoot: DEFAULT_SAFE_ROOT, retentionDays: null, json: false, audit: true, report: true, sample: null }
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] ?? '')
    const eq = a.indexOf('=')
    const key = eq >= 0 ? a.slice(0, eq) : a
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined
    const next = () => (inline !== undefined ? inline : argv[++i])
    if (key === '--apply') o.apply = true
    else if (key === '--dry-run') { o.apply = false; o.forceDry = true }
    else if (key === '--allow-production') o.allowProduction = true
    else if (key === '--safe-root') o.safeRoot = path.resolve(String(next()))
    else if (key === '--retention-days') o.retentionDays = Number(next())
    else if (key === '--json') o.json = true
    else if (key === '--no-audit') o.audit = false
    else if (key === '--no-report') o.report = false
    else if (key === '--help' || key === '-h') o.help = true
    else if (a.trim()) o.unknown = a
  }
  return o
}

/** 读配置（缺省 apply:false = dry-run；fail-safe：读不到就按最保守走）。 */
export function readConfig(file = CONFIG_FILE) {
  const base = { apply: false, retentionDays: RETENTION_DAYS_DEFAULT }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ...base, ...j, apply: j?.apply === true, retentionDays: Number.isFinite(Number(j?.retentionDays)) ? Number(j.retentionDays) : base.retentionDays, file }
  } catch { return { ...base, file, missing: true } }
}

/**
 * 闸（纯函数，单测可直接调）：返回 {ok, code, reason, apply}
 *
 * **真删的口径（写死，别在别处再写一套）**：
 *   · 模式 = apply 当且仅当 **（CLI `--apply` 或 配置 `apply:true`）且 未显式 `--dry-run`**；
 *   · **配置 `apply:true` = 放行层**（改开关不改代码 —— 大管家纪律）；
 *   · CLI `--apply` 打**默认安全根**时若配置没放行，则还需 `--allow-production`
 *     （防"沙箱参数解析失败 → 静默回落生产根"这类事故；与 restore-*.mjs 同款加固）。
 */
export function guardOptions(o, cfg = readConfig()) {
  if (o.unknown) return { ok: false, code: 'unknown-arg', reason: `未知参数：${o.unknown}`, apply: false }
  const cfgApply = cfg.apply === true
  const wantApply = o.forceDry !== true && (o.apply === true || cfgApply === true)
  const isProd = path.resolve(o.safeRoot).toLowerCase() === path.resolve(DEFAULT_SAFE_ROOT).toLowerCase()
  if (wantApply && isProd && o.apply === true && !cfgApply && !o.allowProduction) {
    return {
      ok: false, code: 'need-allow-production', apply: false,
      reason: `CLI --apply 打默认安全根 ${o.safeRoot} 需 --allow-production，或改用配置放行（${CONFIG_FILE} 的 apply:true）—— fail-closed`,
    }
  }
  const days = o.retentionDays ?? cfg.retentionDays
  return {
    ok: true,
    code: wantApply ? 'apply' : 'dry-run',
    apply: wantApply,
    reason: wantApply
      ? `apply（保留期 ${days} 天；放行来源：${cfgApply ? `配置 ${cfg.file}` : 'CLI --apply'}）`
      : `dry-run（默认；保留期 ${days} 天；要真删设 ${CONFIG_FILE} 的 apply:true 或显式 --apply）`,
  }
}

/** case 年龄（天）：以 case 自己的事实为准（state.updatedAt → manifest.createdAt → 目录 mtime）。 */
export function caseAgeDays(dir, now = Date.now()) {
  let at = null
  let source = null
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
    if (st?.updatedAt) { at = Date.parse(st.updatedAt); source = 'state.json#updatedAt' }
  } catch { /* 下一步兜底 */ }
  if (!Number.isFinite(at)) {
    try {
      const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
      if (mf?.createdAt) { at = Date.parse(mf.createdAt); source = 'manifest.json#createdAt' }
    } catch { /* 下一步兜底 */ }
  }
  if (!Number.isFinite(at)) {
    try { at = fs.statSync(dir).mtimeMs; source = 'dir#mtime' } catch { return { days: null, source: null } }
  }
  return { days: (now - at) / 86_400_000, source }
}

/**
 * 计划：扫 safeRoot 下 `case-*`，产出 { expired, kept, skipped, notes }。
 * **纯只读**（不删任何东西）—— 真删在 `runRetention` 的 apply 分支里。
 */
export function planRetention({ safeRoot = DEFAULT_SAFE_ROOT, retentionDays = RETENTION_DAYS_DEFAULT, now = Date.now() } = {}) {
  const out = { safeRoot, retentionDays, expired: [], kept: [], skipped: [], notes: [] }
  let names = []
  try { names = fs.readdirSync(safeRoot) } catch { out.notes.push(`安全根不可读/不存在：${safeRoot}`); out.missing = true; return out }
  const rootAbs = path.resolve(safeRoot)
  for (const n of names) {
    if (!/^case-/.test(n)) continue
    const p = path.join(safeRoot, n)
    let st
    try { st = fs.lstatSync(p) } catch { out.skipped.push({ name: n, why: 'lstat 失败' }); continue }
    // ④ **先判链接、再判目录**：Windows 上 junction 的 lstat 是 `isSymbolicLink()=true` 且
    //    `isDirectory()=false`（lstat 不跟随）—— 顺序反了会被记成"不是目录"而**丢掉告警语义**
    //    （真机单测实测踩中：junction 夹具被跳过但 warn 未置位）。
    if (st.isSymbolicLink()) { out.skipped.push({ name: n, why: '是符号链接/junction ⇒ 拒绝递归删（不跟链接）', warn: true }); continue }
    if (!st.isDirectory()) { out.skipped.push({ name: n, why: '不是目录' }); continue }
    // ③ 路径硬闸
    const rel = path.relative(rootAbs, path.resolve(p))
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') { out.skipped.push({ name: n, why: `路径不在安全根内（被拒）：${p}`, warn: true }); continue }
    const { days, source } = caseAgeDays(p, now)
    if (days === null) { out.skipped.push({ name: n, why: '年龄不可判' }); continue }
    const entry = { name: n, path: p, days: Math.round(days * 100) / 100, ageSource: source, bytes: dirBytes(p) }
    if (days > retentionDays) out.expired.push(entry)
    else out.kept.push(entry)
  }
  out.expired.sort((a, b) => b.days - a.days)
  return out
}

/** 目录体积（只统计，不跟随链接）。 */
export function dirBytes(dir, { followLinks = false } = {}) {
  let total = 0
  const walk = (d, depth) => {
    if (depth < 0) return
    let items = []
    try { items = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const p = path.join(d, it.name)
      try {
        const st = fs.lstatSync(p)
        if (st.isSymbolicLink()) { if (followLinks) continue; continue }
        if (it.isDirectory()) walk(p, depth - 1)
        else total += st.size
      } catch { /* 单项失败忽略 */ }
    }
  }
  walk(dir, 14)
  return total
}

/**
 * 执行清理。
 * @param {object} o parse() 的产出（已合并配置）
 * @returns {object} {ok, mode, plan, removed[], failed[], notes[]}
 */
export function runRetention(o, deps = {}) {
  const cfg = deps.config ?? readConfig()
  const g = guardOptions(o, cfg)
  if (!g.ok) return { ok: false, stage: 'guard', code: g.code, reason: g.reason, removed: [], failed: [] }
  const retentionDays = o.retentionDays ?? cfg.retentionDays
  const plan = planRetention({ safeRoot: o.safeRoot, retentionDays, now: deps.now ?? Date.now() })
  const removed = []
  const failed = []
  const notes = [...plan.notes]
  if (!g.apply) {
    for (const e of plan.expired) removed.push({ ...e, action: 'plan', applied: false })
    return { ok: true, mode: 'dry-run', plan, removed, failed, notes, retentionDays, configFile: cfg.file, configApply: cfg.apply === true }
  }
  for (const e of plan.expired) {
    try {
      // ④ 删前再核一次"不是链接"（plan 与 apply 之间的 TOCTOU 兜底）
      const st = fs.lstatSync(e.path)
      if (st.isSymbolicLink()) { failed.push({ ...e, error: 'apply 前复查发现是链接 ⇒ 拒删（不跟链接）' }); continue }
      fs.rmSync(e.path, { recursive: true, force: true })
      removed.push({ ...e, action: 'removed', applied: true })
    } catch (err) {
      failed.push({ name: e.name, path: e.path, error: String(err && err.message ? err.message : err) })
    }
  }
  return { ok: true, mode: 'apply', plan, removed, failed, notes, retentionDays, configFile: cfg.file, configApply: cfg.apply === true }
}

/** 写留痕：审计（butler-audit）+ 摘要报告（logs\nurse-retention-<date>.md）。两者失败都不抛。 */
async function leaveTrace(o, res, deps = {}) {
  const traces = { audit: null, report: null }
  const stamp = new Date().toISOString()
  if (o.audit !== false) {
    try {
      const mod = deps.auditMod ?? await import(pathToFileURL(path.join(DSH_BUTLER_LIB, 'audit.mjs')).href)
      traces.audit = mod.appendAudit({
        kind: 'nurse', event: 'nurse-retention', mode: res.mode, retentionDays: res.retentionDays,
        expired: res.plan?.expired?.length ?? 0, removed: res.removed.filter((r) => r.applied).length,
        failed: res.failed.length, dryRun: res.mode !== 'apply', safeRoot: res.plan?.safeRoot ?? o.safeRoot,
        items: res.removed.slice(0, 20).map((r) => `${r.name}(${r.days}天,${Math.round(r.bytes / 1024)}KB)${r.applied ? '' : '[plan]'}`),
        at: stamp,
      })
    } catch (e) { traces.audit = { ok: false, error: String(e && e.message ? e.message : e) } }
  }
  if (o.report !== false) {
    try {
      fs.mkdirSync(REPORT_DIR, { recursive: true })
      const day = stamp.slice(0, 10)
      const file = path.join(REPORT_DIR, `nurse-retention-${day}.md`)
      const L = []
      L.push(`## ${stamp} · 小护士 case retention（${res.mode}）`)
      L.push('')
      L.push(`- 安全根：\`${res.plan?.safeRoot ?? o.safeRoot}\` · 保留期：${res.retentionDays} 天 · 配置：\`${res.configFile ?? '-'}\`（apply=${res.configApply === true}）`)
      L.push(`- 过期 ${res.plan?.expired?.length ?? 0} · ${res.mode === 'apply' ? `已删 ${res.removed.filter((r) => r.applied).length}` : '**dry-run 未删**'} · 失败 ${res.failed.length} · 保留 ${res.plan?.kept?.length ?? 0} · 跳过 ${res.plan?.skipped?.length ?? 0}`)
      for (const r of res.removed) L.push(`  - ${r.applied ? '🗑 已删' : '📋 计划'} \`${r.name}\`（${r.days} 天 · ${r.ageSource} · ${Math.round(r.bytes / 1024)}KB）`)
      for (const f of res.failed) L.push(`  - ✗ 失败 \`${f.name ?? f.path}\`：${f.error}`)
      for (const s of res.plan?.skipped ?? []) L.push(`  - ⚠ 跳过 \`${s.name}\`：${s.why}`)
      if (!fs.existsSync(file)) fs.writeFileSync(file, `# 小护士 case retention 流水（按日追加）\n\n`, 'utf8')
      fs.appendFileSync(file, L.join('\n') + '\n\n', 'utf8')
      traces.report = { ok: true, file }
    } catch (e) { traces.report = { ok: false, error: String(e && e.message ? e.message : e) } }
  }
  return traces
}

async function main() {
  const o = parse(process.argv.slice(2))
  if (o.help) {
    console.log('用法：node retention.mjs [--dry-run|--apply] [--allow-production] [--safe-root <dir>] [--retention-days N] [--json] [--no-audit] [--no-report]')
    process.exitCode = EXIT_OK
    return
  }
  const cfg = readConfig()
  const res = runRetention(o, { config: cfg })
  if (res.stage === 'guard') {
    console.error(`✗ ${res.reason}`)
    if (o.json) console.log(JSON.stringify(res, null, 2))
    process.exitCode = EXIT_USAGE
    return
  }
  const traces = await leaveTrace(o, res)
  const out = { ...res, traces }
  if (o.json) console.log(JSON.stringify(out, null, 2))
  else {
    console.log(`小护士 case retention（${res.mode}）· 安全根 ${res.plan.safeRoot}`)
    console.log(`  保留期 ${res.retentionDays} 天 · 配置 ${res.configFile}（apply=${res.configApply === true}）`)
    console.log(`  过期 ${res.plan.expired.length} · ${res.mode === 'apply' ? `已删 ${res.removed.filter((r) => r.applied).length}` : 'dry-run 未删'} · 失败 ${res.failed.length} · 保留 ${res.plan.kept.length} · 跳过 ${res.plan.skipped.length}`)
    for (const r of res.removed) console.log(`   ${r.applied ? '🗑' : '📋'} ${r.name}（${r.days} 天 · ${r.ageSource} · ${Math.round(r.bytes / 1024)}KB）`)
    for (const f of res.failed) console.log(`   ✗ ${f.name ?? f.path}：${f.error}`)
    for (const s of res.plan.skipped) console.log(`   ⚠ 跳过 ${s.name}：${s.why}`)
    for (const n of res.notes) console.log(`   ℹ ${n}`)
    console.log(`  留痕：审计 ${traces.audit?.ok ? 'ok' : (traces.audit?.error ?? 'off')} · 报告 ${traces.report?.ok ? traces.report.file : (traces.report?.error ?? 'off')}`)
  }
  // 失败容忍：只有当"安全根不存在"才算环境不可用（tickd 会记一次 failure 但不至于刷红）
  process.exitCode = res.plan?.missing ? EXIT_ENV : EXIT_OK
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] || '').toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase() } catch { return false }
})()
if (isMain) {
  try {
    await main()
  } catch (e) {
    console.error(`✗ retention 异常：${e && e.stack || e}`)
    process.exitCode = EXIT_OK // 失败容忍：不把异常变成 job failure
  }
}
