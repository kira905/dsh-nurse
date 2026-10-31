/**
 * butler-bridge.mjs —— 小护士 ↔ 大管家通道桥（方案 §5 G8 审计与告警落点）
 *
 * 为什么要有这一层：
 *   G8 修订（2026-09-21 · I7）实测 —— `nurse-orchestrate.mjs` 与 `lib\proposal-guard.mjs` 对
 *   `butler-audit` / `logs` / `appendAudit` / `alert` / `notify` **全 0 命中** ⇒ 当前实现
 *   **不写报告、不落审计、成功与失败都不会主动叫人**。本模块补的就是这一层。
 *
 * 三条纪律：
 *   ① **复用既有通道，不另造一套**：审计走 `dsh-butler/lib/audit.mjs` 的 `appendAudit`
 *      （append-only + 哈希链）；告警走 `lib/alert.mjs`（写 `~/.dsh/butler-alert.log` + stderr）；
 *      通知走 `lib/watch-notify.mjs`（桌宠 `/whale/say` + DSH 会话 queue，宁可不发也不发错）。
 *   ② **失败绝不拖垮修复主流程**：任何通道抛错都被吞成 `{ok:false,error}` 回给调用方（写进 case 留痕）。
 *   ③ **报告同样脱敏**（§5.1）：报告正文过 `lib/redact.mjs` 同一套正则才落盘。
 *
 *   ④ **知识库写入侧**（2026-10-10 · C-V8）：`appendKnowledge()` —— 本桥此前只有
 *      报告 / 审计 / 告警 / 通知四条出口，`~/.dsh/repair-knowledge` 在本线**只有采集侧**
 *      （`collect-case.mjs` 读进去当现场证据）⇒ 护士修完一场什么都不沉淀。现补写入侧，
 *      复用分身那套 `<DSH_ROOT>/knowledge.mjs#append`（不另造去重 / 命名逻辑）。
 *
 * 全部依赖**动态 import + 可注入**（单测零生产副作用；护士链不因大管家组件缺失而崩）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRedactor } from './redact.mjs'

export const BRIDGE_VERSION = '0.2.0'
export const DSH_ROOT = process.env.DSH_ROOT || path.join(os.homedir(), 'DSH')
export const BUTLER_LIB = path.join(DSH_ROOT, 'tools', 'dsh-butler', 'lib')
export const DEFAULT_LOGS_ROOT = path.join(DSH_ROOT, 'logs')
/** 报告文件名前缀（G8：`logs\repair-report-*.md`） */
export const REPORT_PREFIX = 'repair-report-'
/** 修复知识库落点（**与修复分身 `repair.mjs` 同一份**：`~\.dsh\repair-knowledge`） */
export const KNOWLEDGE_DIR = path.join(os.homedir(), '.dsh', 'repair-knowledge')
/** 知识库模块（复用分身那套：write + repeatKey 去重闭环；不另造一份） */
export const KNOWLEDGE_MODULE = path.join(DSH_ROOT, 'knowledge.mjs')

let _mods = null
/** 加载大管家三个通道模块（懒加载 + 缓存；缺失 → 抛，由调用方吞成 ok:false）。 */
async function loadMods() {
  if (_mods) return _mods
  const [audit, alertMod, notifyMod] = await Promise.all([
    import(pathToFileURL(path.join(BUTLER_LIB, 'audit.mjs')).href),
    import(pathToFileURL(path.join(BUTLER_LIB, 'alert.mjs')).href),
    import(pathToFileURL(path.join(BUTLER_LIB, 'watch-notify.mjs')).href),
  ])
  _mods = {
    appendAudit: audit.appendAudit,
    alert: alertMod.alert,
    sayWhale: notifyMod.sayWhale,
    notifySession: notifyMod.notifySession,
    resolveNotifySession: notifyMod.resolveNotifySession,
  }
  return _mods
}

const safeName = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)

/**
 * 写一条护士审计（G8）：`kind:'nurse'` + `caseId` 贯穿（G13）。
 * @returns {Promise<{ok:boolean, file?:string, hash?:string, error?:string}>}
 */
export async function auditNurse(entry = {}, deps = {}) {
  const rec = { kind: 'nurse', ...entry }
  try {
    const mod = deps.auditMod ?? (await loadMods())
    return mod.appendAudit(rec, deps.home ? { home: deps.home } : {})
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}

/** 发一条护士告警（写 ~/.dsh/butler-alert.log + stderr）。永不抛。 */
export async function alertNurse(entry = {}, deps = {}) {
  try {
    const mod = deps.alertMod ?? (await loadMods())
    return mod.alert({ source: 'dsh-nurse', ...entry }, deps.home ? { home: deps.home } : {})
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}

/**
 * 叫人（G8：**成功与失败都要叫**）：桌宠 + DSH 会话 queue。
 * @returns {Promise<{whale:object, session:object, text:string}>} 永不抛
 */
export async function notifyOwner(text, deps = {}) {
  const out = { whale: { ok: false, skipped: true }, session: { ok: false, skipped: true }, text: String(text ?? '') }
  if (!out.text.trim()) return out
  if (deps.noNotify === true) { out.skipped = true; return out }
  try {
    const mod = deps.notifyMod ?? (await loadMods())
    out.whale = await mod.sayWhale(out.text, { baseUrl: deps.baseUrl, state: deps.state })
    const target = deps.target ?? mod.resolveNotifySession(deps.home ? { home: deps.home } : {})
    if (target && target.sessionId) out.session = { target: target.source, ...(await mod.notifySession(target.sessionId, out.text, { baseUrl: deps.baseUrl })) }
    else out.session = { ok: false, error: 'no-target-session' }
  } catch (e) {
    out.error = String(e && e.message ? e.message : e)
  }
  return out
}

/** 报告路径：`<logsRoot>\repair-report-<caseId>.md`（默认 `<DSH_ROOT>/logs`）。 */
export function reportPath(caseId, logsRoot = DEFAULT_LOGS_ROOT) {
  return path.join(logsRoot, `${REPORT_PREFIX}${safeName(caseId)}.md`)
}

/**
 * 渲染报告正文（纯函数，单测友好；**不脱敏** —— 落盘前统一过 redactor）。
 * @param {object} p { caseId, host, startedAt, endedAt, ok, stage, mode, steps[], state, instance,
 *                     applied[], backups[], rejected[], errors[], severity, notes[] }
 */
export function formatRepairReport(p = {}) {
  const L = []
  const ts = (v) => (v ? String(v) : '—')
  L.push(`# 小护士修复报告 ${p.caseId ?? '(无 caseId)'}`)
  L.push('')
  L.push(`> 由 \`tools\\dsh-nurse\\nurse-orchestrate.mjs\` 自动生成（方案 §5 G8 / §7 V8）。`)
  L.push('')
  L.push('| 项 | 值 |')
  L.push('|---|---|')
  L.push(`| 结论 | ${p.ok ? '✅ 成功' : `❌ 未完成（stage=${p.stage ?? '?'}）`} |`)
  L.push(`| 模式 | ${p.mode ?? '—'} |`)
  L.push(`| 设备 | ${p.host ?? '—'} |`)
  L.push(`| 开始 / 结束 | ${ts(p.startedAt)} → ${ts(p.endedAt)} |`)
  L.push(`| 端到端耗时 | ${Number.isFinite(p.durationMs) ? `${(p.durationMs / 1000).toFixed(1)}s` : '—'} |`)
  L.push(`| 安全实例 | ${p.instance ? `端口 ${p.instance.port} · HTTP ${p.instance.status}${p.instance.reused ? '（复用）' : ''}` : '未起/未记录'} |`)
  L.push('')
  if (Array.isArray(p.steps) && p.steps.length) {
    L.push('## 步骤')
    L.push('')
    for (const s of p.steps) L.push(`- ${s.ok ? '✓' : '✗'} **${s.name}**${s.detail ? ` — ${s.detail}` : ''}`)
    L.push('')
  }
  if (p.applied || p.backups || p.rejected) {
    L.push('## 动作与备份（G1/G4）')
    L.push('')
    L.push(`- 应用 ${(p.applied || []).length} 条${(p.backups || []).length ? ` · 写前备份 ${(p.backups || []).length} 份` : ''}`)
    for (const a of p.applied || []) L.push(`  - applied: \`${a.path ?? a}\``)
    for (const b of p.backups || []) L.push(`  - backup: \`${b.backup ?? b}\``)
    for (const r of p.rejected || []) L.push(`  - ⛔ rejected: ${r}`)
    L.push('')
  }
  if (Array.isArray(p.errors) && p.errors.length) {
    L.push('## 错误')
    L.push('')
    for (const e of p.errors) L.push(`- ${e}`)
    L.push('')
  }
  L.push('## 遗留风险与待主人项')
  L.push('')
  const notes = Array.isArray(p.notes) && p.notes.length ? p.notes : ['（无）']
  for (const n of notes) L.push(`- ${n}`)
  L.push('')
  if (p.audit) L.push(`> 审计：\`${p.audit.file ?? '—'}\`${p.audit.hash ? ` · hash ${String(p.audit.hash).slice(0, 12)}…` : ''}`)
  L.push('')
  return L.join('\n')
}

/**
 * 落报告（**正文过脱敏**；失败不抛，回 {ok:false}）。
 * @param {object} payload formatRepairReport 的入参
 * @param {{logsRoot?:string, redactor?:object, dryRun?:boolean}} [deps]
 */
export function writeRepairReport(payload = {}, deps = {}) {
  const file = reportPath(payload.caseId, deps.logsRoot ?? DEFAULT_LOGS_ROOT)
  try {
    const redactor = deps.redactor ?? createRedactor()
    const body = redactor.deepRedact(formatRepairReport(payload))
    if (deps.dryRun === true) return { ok: true, file, dryRun: true, bytes: Buffer.byteLength(body, 'utf8') }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body, 'utf8')
    return { ok: true, file, bytes: Buffer.byteLength(body, 'utf8') }
  } catch (e) {
    return { ok: false, file, error: String(e && e.message ? e.message : e) }
  }
}

/** 一行摘要（通知/审计里用；不脱敏，调用方自己过 redactor）。 */
export function summarize(p = {}) {
  const dur = Number.isFinite(p.durationMs) ? `${(p.durationMs / 1000).toFixed(0)}s` : '—'
  return `🩺 小护士 ${p.caseId ?? ''} ${p.ok ? '修复成功' : `未完成（${p.stage ?? '?'}）`} · 耗时 ${dur}`
}

/**
 * 知识库**写入侧**（C-V8 · 2026-10-10）。
 *
 * 缺口原话：报告在（`logs\repair-report-case-*.md`）、知识库**只有采集侧**（`collect-case.mjs`
 *   只把 `~\.dsh\repair-knowledge` 读进现场包，2 处命中全在采集侧）⇒ 小护士修完一场，
 *   **不沉淀任何条目**，"知识库复用"（方案 §8 P3）实际是单向只读。
 *
 * 口径：
 *   · 落点 = `~\.dsh\repair-knowledge`（**与修复分身同一份**，不另开一库）；
 *   · 模块 = `<DSH_ROOT>/knowledge.mjs#append`（**复用**，不去复制它的去重/命名逻辑）；
 *   · **fail-open**：写失败只回 `{ok:false,error}`，绝不拖垮修复主流程（与 G8 其余通道同款）；
 *   · `deps.dir` / `deps.knowledgeMod` 可注入 ⇒ 单测零生产留痕。
 *
 * @param {object} entry 条目（建议用 `nurseKnowledgeEntry()` 生成）
 * @param {{dir?:string, knowledgeMod?:object}} [deps]
 * @returns {Promise<{ok:boolean, file?:string, merged?:boolean, dir?:string, error?:string}>}
 */
export async function appendKnowledge(entry = {}, deps = {}) {
  const dir = deps.dir ?? KNOWLEDGE_DIR
  try {
    const mod = deps.knowledgeMod ?? await import(pathToFileURL(KNOWLEDGE_MODULE).href)
    const r = mod.append(dir, entry)
    return { ok: true, file: r.file, merged: r.merged === true, dir }
  } catch (e) {
    return { ok: false, dir, error: String(e && e.message ? e.message : e) }
  }
}

/**
 * 小护士 case 收尾 → 知识库条目（纯函数，便于单测）。
 *
 * 字段与修复分身写的那份**同形**（`ts`/`device`/`verdict`/`executed`/`outcome`/`notes`），
 * 这样 `knowledge.mjs#loadRecent` 与分身的报告/检索都能直接读（"知识库复用"才成立）。
 *
 * ⚠️ **刻意不写 `repeatKey`**：分身的 repeatKey 是"崩溃关键字签名"，护士的 case 没有同源签名；
 *   随便填一个会让 `append()` 按签名去**合并进分身的条目**（把两件事的账混在一起）。
 *   留空 ⇒ `append()` 走"新写一条"分支 ⇒ 每个 case 一条独立条目（可接受：case 本就低频）。
 */
export function nurseKnowledgeEntry(p = {}) {
  const failedSteps = (p.steps || []).filter((s) => s.ok !== true).map((s) => s.name)
  return {
    ts: p.endedAt ?? null,
    device: p.host ?? null,
    source: 'dsh-nurse',
    kind: 'nurse-case',
    caseId: p.caseId ?? null,
    mode: p.mode ?? null,
    startedAt: p.startedAt ?? null,
    endedAt: p.endedAt ?? null,
    durationMs: Number.isFinite(p.durationMs) ? p.durationMs : null,
    instance: p.instance ? { port: p.instance.port, status: p.instance.status, reused: p.instance.reused === true } : null,
    applied: (p.applied || []).map((a) => (typeof a === 'string' ? a : a.path)).filter(Boolean),
    backups: (p.backups || []).map((b) => (typeof b === 'string' ? b : (b.backupRel ?? b.backup))).filter(Boolean),
    rejected: (p.rejected || []).slice(0, 20),
    failedSteps,
    errors: (p.errors || []).slice(0, 10),
    outcome: p.ok === true ? 'done' : 'failed',
    verdict: p.ok === true ? `nurse-done(stage=${p.stage ?? 'done'})` : `nurse-failed(stage=${p.stage ?? '?'})`,
    repeatKey: null,
    notes: (p.notes || []).join(' | ') || null,
    executed: [`nurse-${p.mode ?? '?'}(${p.ok === true ? 'ok' : (p.stage ?? 'failed')})`],
  }
}
