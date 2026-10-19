// ============================================================
//  lib/nurse-profile-report.mjs — 解析 make-nurse-profile.mjs 的输出报告
//  ------------------------------------------------------------
//  为什么存在（卡 L-15 · N-10）：护士单测 `profile:构建成功` 曾**恒红** ——
//  dsh 启动时的 heal 会给 profiles/node_modules 补若干链接（指向全局主包实体、
//  或主包树里的嵌套依赖），这些**合法 heal 链接**在 make-nurse-profile 眼里是
//  `conflict` ⇒ 退出码 1 ⇒ 每次跑单测都要人工解释"这红是正常的"。
//
//  本模块把「哪些 conflict 属于合法 heal 链接」写死成**可自证判据**，供单测豁免；
//  同时保证**真 conflict 仍然报红**（目标不在主包树内 / 目标包的 name 与链接名不符 /
//  出现 error 项 / 明细与统计数量对不上）。
//
//  合法 heal 链接 ⇔ 以下三条**同时**成立（写死，不随调用方放宽）：
//    ① 实际目标是**已存在的目录**，且落在主包实体根之内
//       （`<APPDATA>\npm\node_modules\@deepseek-ai\dsh`）—— 即"全局主包本体"或
//       "主包 node_modules 里任意位置的嵌套依赖"；
//    ② 该目录的 package.json 里 `name` **逐字等于**链接名（scoped 名如
//       `@deepseek-ai/dsh` 亦然）；
//    ③ 该条 action 是 `conflict`（`error` 永不豁免）。
//
//  反例（一律判不合法 ⇒ 不豁免）：
//    · 指向主包树之外的任何路径（自研包 / 临时夹具 / 别的盘 / 不存在）；
//    · 目标不是包（无 package.json）或包名与链接名不符；
//    · error 类明细（建链接失败 / 找不到主包依赖目录）。
// ============================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME_DIR = os.homedir()
export const NPM_ROOT = path.join(process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming'), 'npm', 'node_modules')
/** 全局主包实体根（= 合法 heal 链接允许落点的上界） */
export const MAIN_PKG_ROOT = path.join(NPM_ROOT, '@deepseek-ai', 'dsh')
/** 主包自带的依赖目录 = make-nurse-profile 的期望链接源 */
export const MAIN_DEPS_DIR = path.join(MAIN_PKG_ROOT, 'node_modules')

const norm = (p) => path.resolve(String(p)).replace(/\//g, '\\').toLowerCase()
const isUnder = (child, parent) => {
  const c = norm(child); const p = norm(parent)
  return c === p || c.startsWith(p.endsWith('\\') ? p : p + '\\')
}

/**
 * 判定一个 conflict 是不是 dsh 启动 heal 补的合法链接。
 * @param {string} label  包名，如 'debug' / '@deepseek-ai/dsh'
 * @param {string} target 链接的实际指向（绝对路径）
 * @param {{mainPkgRoot?:string}} [opts]
 * @returns {{legit:boolean, why:string}}
 */
export function isLegitHealLink(label, target, opts = {}) {
  const root = opts.mainPkgRoot || MAIN_PKG_ROOT
  const name = String(label || '').trim()
  if (!name) return { legit: false, why: '链接名为空' }
  if (!target) return { legit: false, why: '没有实际链接目标（报告未记录 ⇒ 不可判 ⇒ 不放行）' }
  const t = path.resolve(String(target))
  // ① 落在主包实体根之内
  if (!isUnder(t, root)) return { legit: false, why: `目标不在主包树内：${t}` }
  // ② 目标是目录且 package.json 的 name 逐字等于链接名
  let st = null
  try { st = fs.statSync(t) } catch { return { legit: false, why: `目标不存在：${t}` } }
  if (!st.isDirectory()) return { legit: false, why: `目标不是目录：${t}` }
  let pkg = null
  try { pkg = JSON.parse(fs.readFileSync(path.join(t, 'package.json'), 'utf8')) } catch {
    return { legit: false, why: `目标没有可解析的 package.json：${t}` }
  }
  if (String(pkg.name || '') !== name) return { legit: false, why: `目标包名「${pkg.name}」≠ 链接名「${name}」` }
  // ③ 通过
  return { legit: true, why: '目标 = 主包树内同名包（dsh 启动 heal 的合法链接）' }
}

/**
 * 解析 make-nurse-profile.mjs 的 stdout。
 * @returns {{
 *   errors: Array<{label:string,target:string|null}>,
 *   conflicts: Array<{label:string,target:string|null,legit:boolean,why:string}>,
 *   statConflict: number|null, statError: number|null, hasStat: boolean,
 *   exemptEligible: boolean, detail: string
 * }}
 */
export function parseProfileReport(stdout, opts = {}) {
  const lines = String(stdout || '').split(/\r?\n/)
  const errors = []
  const conflicts = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\[(error|conflict)\]\s+(.*)$/.exec(lines[i])
    if (!m) continue
    const kind = m[1]
    let rest = m[2]
    const noteIdx = rest.indexOf(' — ')
    if (noteIdx >= 0) rest = rest.slice(0, noteIdx)
    const label = rest.replace(/^deps\s+/, '').trim()
    // 明细第二行：`<file> →（实际）<target>`（conflict，本卡 N-9 起）或 `<file> → <target>`（junction）
    const next = lines[i + 1] || ''
    let target = null
    const ma = /→（实际）(.+)$/.exec(next)
    const me = /\s→\s+(.+)$/.exec(next)
    if (ma) target = ma[1].trim()
    else if (me) target = me[1].trim()
    if (kind === 'error') errors.push({ label, target })
    else {
      const v = isLegitHealLink(label, target, opts)
      conflicts.push({ label, target, legit: v.legit, why: v.why })
    }
  }
  // 统计行：`  统计：skip=497 conflict=3 summary=1`
  const stat = {}
  let hasStat = false
  for (const l of lines) {
    const m = /统计：\s*(.*)$/.exec(l)
    if (!m) continue
    hasStat = true
    for (const kv of m[1].trim().split(/\s+/)) {
      const idx = kv.indexOf('=')
      if (idx <= 0) continue
      const k = kv.slice(0, idx); const v = Number(kv.slice(idx + 1))
      if (k) stat[k] = Number.isFinite(v) ? v : null
    }
  }
  const statConflict = hasStat && Number.isFinite(stat.conflict) ? stat.conflict : null
  const statError = hasStat && Number.isFinite(stat.error) ? stat.error : null

  // 豁免判据（五条全真才放行 —— 任一条不满足 ⇒ 不豁免，仍按 FAIL 处理）
  const illegit = conflicts.filter((c) => !c.legit)
  const reasons = []
  if (!hasStat) reasons.push('输出里没有「统计：」行')
  if (errors.length) reasons.push(`有 ${errors.length} 条 error 明细`)
  if (!conflicts.length) reasons.push('没有 conflict 明细（无法证明"失败全是合法 heal 链接"）')
  if (illegit.length) reasons.push(`${illegit.length} 条 conflict 不是合法 heal 链接`)
  if (statConflict !== null && statConflict !== conflicts.length) reasons.push(`明细数 ${conflicts.length} ≠ 统计 conflict=${statConflict}`)
  if (statError !== null && statError !== errors.length) reasons.push(`error 明细数 ${errors.length} ≠ 统计 error=${statError}`)
  const exemptEligible = reasons.length === 0

  const detail = exemptEligible
    ? `全部 ${conflicts.length} 条 conflict 均为合法 heal 链接（主包树内同名包）`
    : `不豁免：${reasons.join('；')}`
  return { errors, conflicts, statConflict, statError, hasStat, exemptEligible, detail, reasons }
}
