/**
 * misfix.mjs —— 小护士「误修」判据（方案 §5 G13 待办项）
 *
 * 背景（2026-09-21 修订 · I7 附带）：G13 的三个 SLI 里「误修率」**此前没有任何度量口径**
 *   —— `case-state.mjs` 只落了 `sli{startedAt,endedAt,outcome,durationMs}`（端到端耗时 + 成败），
 *   `sliOf()` 的 `misFix` 只是"人手工把 `state.misFix=true` 计数"。本模块把判据写死为**可复算的规则**。
 *
 * ── 判据（写死；改口径必须改这里 + 报告 + 单测三处）────────────────────────────
 *   `manual`     人工标记（`state.misFix === true`，或 `--mark-misfix`）。**最高优先**：人说了算。
 *   `recurrence` 自动软判：修复「成功」（phase=done）之后 **24h 内同签名崩溃复发**
 *                —— 判据 = 探针给出的 `after.crashCount > before.crashCount`
 *                且 `after.at - sli.endedAt ≤ MISFIX_WINDOW_MS`，且（签名可比时）`after.signature === before.signature`。
 *   `unknown`    探针不可用 / 无 crashCount / 无 endedAt ⇒ **不计入分母**（绝不把"不知道"当"干净"，
 *                否则误修率会被系统性拉低）。
 *   `clean`      以上都不成立。
 *   ⚠️ **未落地判据（如实标注）**：G13 例举的第三条「被下一 case 回滚」**未实现** ——
 *      需要跨 case 的"谁回滚了谁"关联（现无 `rollbackOf` 字段），成本高、收益低，列为本模块 Non-goal。
 *
 * 探针（可注入，单测零副作用）：
 *   probe = { before: {crashCount, at, signature}, after: {crashCount, at, signature} }
 *   生产取数口径由调用方提供（如 `%TEMP%\dsh-guard\guard-state.json` 的 crashCount + 现场包守护鱼日志尾）。
 */
export const MISFIX_VERSION = '0.1.0'
/** 复发观察窗（写死 24h；改它 = 改口径） */
export const MISFIX_WINDOW_MS = 24 * 60 * 60 * 1000

export const VERDICT = {
  MANUAL: 'manual',
  RECURRENCE: 'recurrence',
  UNKNOWN: 'unknown',
  CLEAN: 'clean',
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
const ms = (v) => {
  const t = Date.parse(String(v ?? ''))
  return Number.isFinite(t) ? t : null
}

/**
 * 判定单个 case 的"误修"。
 * @param {object} state case 状态（读 `phase` / `sli` / `misFix`）
 * @param {{before?:object, after?:object}} [probe] 崩溃探针（可缺；缺 → unknown）
 * @param {{now?:number, windowMs?:number}} [opts]
 * @returns {{verdict:string, counted:boolean, reasons:string[], windowEndsAt:string|null}}
 */
export function judgeMisFix(state, probe = {}, opts = {}) {
  const windowMs = num(opts.windowMs) ?? MISFIX_WINDOW_MS
  const reasons = []
  // ① 人工标记优先（boolean 兼容旧口径 / 对象口径）
  const flag = state?.misFix
  if (flag === true || (flag && typeof flag === 'object' && flag.manual === true)) {
    return { verdict: VERDICT.MANUAL, counted: true, reasons: ['人工标记 misFix（最高优先）'], windowEndsAt: null }
  }
  // ② 自动软判：只在"修复成功"的 case 上有意义
  if (state?.phase !== 'done') {
    return { verdict: VERDICT.UNKNOWN, counted: false, reasons: ['非成功 case（phase≠done）⇒ 不计入误修率分母'], windowEndsAt: null }
  }
  const endedAt = ms(state?.sli?.endedAt)
  if (endedAt === null) return { verdict: VERDICT.UNKNOWN, counted: false, reasons: ['缺 sli.endedAt ⇒ 无法定观察窗'], windowEndsAt: null }
  const before = probe?.before ?? null
  const after = probe?.after ?? null
  if (!before || !after) return { verdict: VERDICT.UNKNOWN, counted: false, reasons: ['崩溃探针缺失（before/after 不全）'], windowEndsAt: null }
  const cBefore = num(before.crashCount)
  const cAfter = num(after.crashCount)
  const atAfter = ms(after.at)
  if (cBefore === null || cAfter === null || atAfter === null) {
    return { verdict: VERDICT.UNKNOWN, counted: false, reasons: ['探针字段不完整（crashCount/at）'], windowEndsAt: null }
  }
  const windowEndsAt = new Date(endedAt + windowMs).toISOString()
  if (atAfter > endedAt + windowMs) {
    return { verdict: VERDICT.CLEAN, counted: true, reasons: [`观察窗已过（${windowEndsAt}）且无复发`], windowEndsAt }
  }
  const grew = cAfter > cBefore
  const sigSame = !before.signature || !after.signature ? null : String(before.signature) === String(after.signature)
  if (grew && sigSame !== false) {
    reasons.push(`修复成功后 ${Math.round((atAfter - endedAt) / 60000)} 分钟内崩溃计数增长（${cBefore} → ${cAfter}）`)
    if (sigSame === true) reasons.push('崩溃签名与修复前一致（同签名复发）')
    return { verdict: VERDICT.RECURRENCE, counted: true, reasons, windowEndsAt }
  }
  return { verdict: VERDICT.CLEAN, counted: true, reasons: ['观察窗内无同签名复发'], windowEndsAt }
}

/**
 * 汇总一批 case（供 `case-state.sliOf` 的 misFixRate 用）。
 * @param {Array<object>} states
 * @param {{probes?:Object<string,object>, now?:number, windowMs?:number}} [opts]
 * @returns {{total:number, counted:number, unknown:number, misFix:number, rate:number|null,
 *            byCase:Object<string,{verdict:string,reasons:string[]}>}}
 */
export function summarizeMisFix(states = [], opts = {}) {
  const probes = opts.probes ?? {}
  const byCase = {}
  let counted = 0
  let unknown = 0
  let misFix = 0
  for (const s of states) {
    const id = s?.caseId ?? '(no-id)'
    const r = judgeMisFix(s, probes[id] ?? {}, opts)
    byCase[id] = { verdict: r.verdict, reasons: r.reasons }
    if (!r.counted) { unknown++; continue }
    counted++
    if (r.verdict === VERDICT.MANUAL || r.verdict === VERDICT.RECURRENCE) misFix++
  }
  return { total: states.length, counted, unknown, misFix, rate: counted ? misFix / counted : null, byCase }
}
