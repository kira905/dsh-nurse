/**
 * case-state.mjs —— 小护士 P2 · case 状态机与预算闸（《小护士》§5 G5/G9/G12/G13 · §6 T7）
 *
 * 职责：
 *   ① `state.json`（原子写：tmp + rename）—— caseId 贯穿报告 / 审计 / 通知（G13）
 *   ② **半完成态兜底（T7/G9）**：上一轮小护士崩在半路（phase 不是 done/failed）→ 下次开机必须能发现，
 *      并给出"用哪份备份回滚到修复前"的指引，再决定是否重试（绝不在半完成态上叠新动作）
 *   ③ 预算闸（G5）：轮次 ≤ maxRounds、总时长 ≤ budgetMs —— 超限即冻结转 L2（fail-closed）
 *   ④ **写盘前脱敏（2026-09-21 · P2-A 补 · 方案 §5.1 I6 待补项）**：state.json 里 `takeover.file` 等字段
 *      此前**原样落绝对用户路径**（实测 4 行 `<home>\.dsh-safe\case-…\takeover.json`）⇒
 *      写盘前统一走 `lib\redact.mjs` 同一套正则（本机用户目录 → `<home>`）。
 *      ⚠️ 脱敏只作用于**落盘副本**（`writeStateAtomic` 内 deepRedact 出的新对象），**内存里的 state 不变**
 *      —— 编排器仍需用真实路径做 IO（如 ⑤.5 删 takeover.json）。
 *   ⑤ SLI（G13）：成功率 / 端到端耗时 / **误修率**（判据真源 = `lib\misfix.mjs`）。
 *
 * 状态文件位置：`<safeRoot>/case-<ts>/state.json`（隔离 home 内，跨机同步=否，G12）
 *   · schemaVersion = 1（本次新增的 `misFix` 判定结构是**可选字段**，向后兼容 ⇒ 不升 schema，
 *     避免老读取方按版本号拒启）
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRedactor } from './redact.mjs'
import { summarizeMisFix } from './misfix.mjs'

export const CASE_STATE_VERSION = 1
/**
 * token 预算缺省上限（G5 · 2026-10-10 补）。
 * 为什么是 20 万：方案 §6.1 把「agent 诊断 + 出提案」整段压进 **≤5min**、
 *   端到端 **≤15min**；按单次诊断回灌现场包（≤9000 字符 ≈ 6k token）+ 一轮决策
 *   实测量级在 1 万级 ⇒ 20 万 = **20 倍余量**，只拦「失控刷轮次」，不拦正常一轮。
 * 与轮次/时长闸同款语义：**超限即冻结转 L2**（fail-closed），不是告警了事。
 */
export const MAX_TOKENS_DEFAULT = 200_000
export const PHASES = [
  'planning', 'collecting', 'taking-over', 'silencing', 'starting',
  'injecting', 'validating', 'executing', 'verifying', 'closing', 'done', 'failed',
]
/** 终态（不在其中 = 半完成态） */
export const TERMINAL_PHASES = ['done', 'failed']
/**
 * 「非本编排器产生、但语义上已结束」的 phase —— 不参与半完成判定。
 *   实例（2026-09-15 真机实测踩中）：P1 的 `collect-case.mjs` 采完现场包会写 `phase: 'collected'`；
 *   若把它当半完成，编排器的 ⓪ bootstrap 会**永久拒启**（等于自锁）——判据必须区分"谁写的 case"。
 */
export const EXTERNAL_TERMINAL_PHASES = ['collected', 'closed', 'archived', 'pruned']

/** 半完成判定（T7/G9）：本编排器的 phase 且未到终态；未知/外部 phase 一律不算（不阻断，只在 status 里标注） */
export function isIncomplete(state) {
  if (!state || typeof state !== 'object') return false
  const p = state.phase
  if (!p) return false
  if (TERMINAL_PHASES.includes(p)) return false
  if (EXTERNAL_TERMINAL_PHASES.includes(p)) return false
  return PHASES.includes(p)
}

export function newCaseId(now = new Date(), rand = Math.random) {
  const p2 = (n) => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`
  return `case-${ts}-${Math.floor(rand() * 0xffff).toString(16).padStart(4, '0')}`
}

export function caseDir(safeRoot, caseId) { return path.join(safeRoot, caseId) }
export function statePath(safeRoot, caseId) { return path.join(caseDir(safeRoot, caseId), 'state.json') }

/**
 * 原子写（tmp + rename）。
 * ⚠️ Windows 实测（2026-09-15 演练中复现）：`rename` 会被杀软/EDR 或残留句柄拦成
 *   `EPERM: operation not permitted`（Host 侧 ledger 也踩过同款）→ 有限次重试后退回**直写**，
 *   保证状态机能推进；直写窗口极短（state.json 仅几十 KB），可接受。
 *
 * 【P2-A · §5.1 I6】写盘前过脱敏（`lib\redact.mjs` 同一套正则；与现场包同一套口径）：
 *   `takeover.file` / `artifacts.*` 这类字段里的 `<home>\…` 形态保持统一；
 *   只影响落盘副本，**内存 state 原样**（调用方仍可用真实路径做 IO）。
 *   `opts.redactor` 可注入（单测用固定 username）；`opts.redact === false` 可关（仅内部排障用）。
 */
export function writeStateAtomic(file, state, opts = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const safe = opts.redact === false ? state : (opts.redactor ?? defaultRedactor()).deepRedact(state)
  const json = JSON.stringify(safe, null, 2)
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, json, 'utf8')
  const busyWait = (ms) => { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } }
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file)
      return state
    } catch (e) {
      if (i < 4) { busyWait(30); continue }
      fs.writeFileSync(file, json, 'utf8')            // 退路：直写（仍保证内容完整）
      try { fs.rmSync(tmp, { force: true }) } catch { /* 残留 tmp 无害 */ }
      return state
    }
  }
  return state
}

/** 默认脱敏器（缓存的单例；username 取当前用户，规则与现场包一致）。 */
let _redactor = null
export function defaultRedactor() {
  if (!_redactor) _redactor = createRedactor()
  return _redactor
}

export function newState(caseId, { maxRounds = 8, budgetMs = 15 * 60 * 1000, maxTokens = MAX_TOKENS_DEFAULT, now = new Date(), host = process.env.COMPUTERNAME } = {}) {
  return {
    schemaVersion: CASE_STATE_VERSION,
    caseId,
    host,
    phase: 'planning',
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    budget: {
      rounds: 0, maxRounds,
      budgetMs, deadlineAt: new Date(now.getTime() + budgetMs).toISOString(),
      // 【G5 补齐 · 2026-10-10】token 上限 —— 旧版只有轮次/时长两维
      tokens: 0, maxTokens,
    },
    takeover: null,
    silence: null,
    instance: null,
    artifacts: {},
    sli: { startedAt: now.toISOString(), endedAt: null, outcome: null, durationMs: null },
    history: [],
    errors: [],
  }
}

export function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** 阶段推进（记录 history；非法阶段名直接抛） */
export function setPhase(file, state, phase, extra = {}) {
  if (!PHASES.includes(phase)) throw new Error(`非法 phase：${phase}`)
  state.history = state.history || []
  state.history.push({ at: new Date().toISOString(), from: state.phase, to: phase })
  state.phase = phase
  state.updatedAt = new Date().toISOString()
  Object.assign(state, extra)
  if (TERMINAL_PHASES.includes(phase)) {
    state.sli.endedAt = state.updatedAt
    state.sli.outcome = phase === 'done' ? 'success' : 'failed'
    state.sli.durationMs = new Date(state.updatedAt) - new Date(state.startedAt)
  }
  return writeStateAtomic(file, state)
}

/**
 * 预算闸（fail-closed）：未超限 → {ok:true}；超限 → {ok:false, reason}
 * 三维（G5）：**轮次** / **总时长** / **token**。
 *   · 总时长 = `budgetMs` → `deadlineAt`（`--budget-min`，缺省 15min；早在 P2 就在位）；
 *   · token = `budget.tokens` vs `budget.maxTokens`（**2026-10-10 补齐**；旧版没有这一维）。
 *   `maxTokens` 缺省（老 case-state 无此字段）**不判** —— 向后兼容，不把历史 case 误判成超限。
 */
export function checkBudget(state, now = new Date()) {
  const b = state && state.budget
  if (!b) return { ok: false, reason: '缺 budget 定义（fail-closed 拒动）' }
  if (Number(b.rounds) >= Number(b.maxRounds)) return { ok: false, reason: `轮次超限（${b.rounds}/${b.maxRounds}）→ 冻结转 L2` }
  if (b.deadlineAt && now.getTime() >= new Date(b.deadlineAt).getTime()) return { ok: false, reason: `总时长超限（deadline ${b.deadlineAt}）→ 冻结转 L2` }
  const maxTok = Number(b.maxTokens)
  if (Number.isFinite(maxTok) && maxTok > 0 && Number(b.tokens || 0) >= maxTok) {
    return { ok: false, reason: `token 超限（${b.tokens}/${maxTok}）→ 冻结转 L2` }
  }
  return { ok: true, remainingRounds: Number(b.maxRounds) - Number(b.rounds), deadlineAt: b.deadlineAt, remainingTokens: Number.isFinite(maxTok) && maxTok > 0 ? maxTok - Number(b.tokens || 0) : null }
}

/**
 * 记 token 消耗（G5 记账口）。**只累加 + 落盘**，不自己判超限（判定唯一源 = `checkBudget`）。
 * 谁该调：将来接线 `--inject llm`（安全实例内 agent 出提案）时，把每轮流量的 usage 累进来。
 * ⚠️ 现值诚实登记：`--inject llm` **尚未接线** ⇒ 生产这条链目前**没有 token 消费者**，
 *    `tokens` 恒 0、token 闸恒不触发（闸在位、零误报；接线那天自动生效）。
 * @param {string} file state.json 路径
 * @param {object} state
 * @param {number} n 本次增量（正数）
 */
export function addTokens(file, state, n) {
  const add = Number(n)
  if (!Number.isFinite(add) || add <= 0) return state
  state.budget = state.budget || {}
  state.budget.tokens = Number(state.budget.tokens || 0) + add
  state.updatedAt = new Date().toISOString()
  return writeStateAtomic(file, state)
}

export function bumpRound(file, state) {
  state.budget.rounds = Number(state.budget.rounds || 0) + 1
  state.updatedAt = new Date().toISOString()
  return writeStateAtomic(file, state)
}

/**
 * 扫安全 home 找**半完成 case**（T7/G9）：phase 不是 done/failed 的 case。
 * 返回 [{caseId, dir, phase, startedAt, updatedAt, hasBackup, backupDir}]，按 updatedAt 倒序。
 */
export function findIncompleteCases(safeRoot) {
  const out = []
  let names = []
  try { names = fs.readdirSync(safeRoot) } catch { return out }
  for (const n of names) {
    if (!/^case-/.test(n)) continue
    const dir = path.join(safeRoot, n)
    const st = readState(path.join(dir, 'state.json'))
    if (!st) continue
    if (!isIncomplete(st)) continue
    const manifest = readState(path.join(dir, 'manifest.json'))
    out.push({
      caseId: st.caseId || n,
      dir,
      phase: st.phase,
      startedAt: st.startedAt,
      updatedAt: st.updatedAt,
      hasBackup: !!(manifest && (manifest.backups || []).length),
      backupDir: manifest && manifest.backups && manifest.backups.length ? path.join(dir, 'before') : null,
      guidance: '半完成态：先用上面 before/ 里的备份回滚到修复前，再决定是否重跑；**不许在未收尾的 case 上叠新动作**',
    })
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/**
 * SLI 汇总（G13）：**修复成功率 / 误修率 / 端到端耗时**。
 *
 * 误修率（2026-09-21 · P2-A 补齐 G13 待办项）：判据真源 = `lib\misfix.mjs` 的 `judgeMisFix`
 *   —— `manual`（人工标记，最高优先）· `recurrence`（修复成功后 24h 内同签名崩溃复发）
 *   · `unknown`（探针缺失/非成功 case ⇒ **不计入分母**，绝不把"不知道"当"干净"）· `clean`。
 *   `opts.probes` = 逐 case 崩溃探针（可选；不传 = 除人工标记外一律 unknown）。
 *   兼容：`state.misFix === true` 是旧口径的人工标记，仍计入（见 misfix.judgeMisFix ①）。
 *
 * @param {Array<object>} states
 * @param {{probes?:object, now?:number, windowMs?:number}} [opts]
 */
export function sliOf(states = [], opts = {}) {
  const done = states.filter((s) => s.phase === 'done')
  const failed = states.filter((s) => s.phase === 'failed')
  const durations = done.map((s) => s.sli && s.sli.durationMs).filter((n) => Number.isFinite(n))
  const mf = summarizeMisFix(states, opts)
  return {
    total: states.length,
    success: done.length,
    failed: failed.length,
    successRate: states.length ? done.length / states.length : null,
    avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    // 旧字段（兼容）：误修**计数**；口径已升级为 misfix.mjs 的三判据
    misFix: mf.misFix,
    // 新字段（G13）：误修率 = 误修数 / 可评估数（unknown 不计入分母）
    misFixRate: mf.rate,
    misFixEvaluated: mf.counted,
    misFixUnknown: mf.unknown,
    misFixByCase: mf.byCase,
  }
}

/** 误修人工标记（最高优先判据；写进 `state.misFix`）。 */
export function markMisFix(file, state, { by = 'manual', reason = '', at = new Date() } = {}) {
  state.misFix = { manual: true, by, reason, at: at.toISOString() }
  state.updatedAt = at.toISOString()
  return writeStateAtomic(file, state)
}
