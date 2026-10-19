/**
 * restart-advisory.mjs —— 小护士 P2 · 「建议重启」通道（D-§4 · 方案 §7-5 **第一步**）
 *
 * 缺口原话（主档 §1 P 域 · S2-03 补行 · 靶单 idx 275）：`D-§4 重启通道（护士只写建议待办）`
 *   = 🔴 未生效（**零实现 · 零痕迹**）；期望看到 = 护士采证/提案后**写一条「建议重启」待办**。
 * 方案原文（`docs\小护士-可修增补-权限边界与执行档-方案-20260924.md` §7-5 L517-523）：
 *   选项 ① **只写待办**（= 本模块实现的那一条）／② 直接开 `--as-auto` 自动请求重启
 *   （**归第二步**，且必须先跑完观测期 §7-6）。
 *
 * 🔴 本模块**绝不**触发重启、**绝不** import `request-restart.mjs`（连 `--go` 路径都不碰）：
 *   · 副作用只有两件，都是**只写痕迹**：
 *       ① `writeAdvisoryCard()` 往看板写一张卡（走 Host API `/api/task-board/action`，不手改账本）
 *       ② 由调用方（编排器）走既有 `raiseAlert()` 出一条 warn 告警
 *   · 何时重启**始终由主人决定** —— 代价（护士看不到"现在合不合适"）是方案 §7-5 选项① 已接受的代价。
 *
 * 判据（保守 · 可单测 · 零猜）：「已执行的动作里，有没有落在**必须重启 dsh 才生效**的面」——
 *   护士可写面只有两类（真源 = `proposal-guard.mjs#ALLOWED_WRITE_PATTERNS`）：
 *     · `profiles\<name>\<声明文件>` = 插件闭包 / 声明 ⇒ **boot 时加载 ⇒ 改了必须重启才生效** ✅
 *     · `_archive\**`               = 备份区          ⇒ 与运行态无关 ⇒ **不需要重启** ❌
 *   ⇒ 判据 = 「命中 profile 声明面 **且** 不在 `_archive` 下」；位置**精确到 basename**（不做目录级放行）。
 *
 * 开关（一键关回，两个口；缺省开）：
 *   · CLI：编排器 `--no-restart-advisory`
 *   · env：`NURSE_RESTART_ADVISORY=0`（`0|false|off|no` 任一）
 * 另有两道天然闸：**只有 `--apply` 真跑档**、**且修复成功**、**且真命中需重启面**时才写
 *   （护士 `--apply` 历史真跑≈0 ⇒ 零噪声）。
 *
 * 纪律：本模块是**库**（无 CLI 入口）；收尾一律 `process.exitCode` 语义由调用方负责。
 * 守门单测：`tools\dsh-nurse\_test\test-restart-advisory.mjs`
 */
import { randomUUID } from 'node:crypto'

export const ADVISORY_VERSION = '0.1.0'

/** 需重启才生效的 basename 白名单（逐字同源 = `proposal-guard.mjs#ALLOWED_WRITE_PATTERNS[0]` 的 profile 声明面） */
export const RESTART_RELEVANT_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'cordis.patch.yml',
  '.package-map.json',
  '.modules.yaml',
])

/** 需重启面正则 —— **与 `proposal-guard.mjs#ALLOWED_WRITE_PATTERNS[0]` 逐字同源**（锚定 `<name>\<文件>` 结尾）：
 *  故意锚定结尾 ⇒ `profiles\<n>\node_modules\…\package.json` **不算**（那类路径本来就被 proposal-guard 的禁写面拒掉）。 */
export const RESTART_RELEVANT_RE = /\/profiles\/[^/]+\/(package\.json|package-lock\.json|pnpm-lock\.yaml|cordis\.patch\.yml|\.package-map\.json|\.modules\.yaml)$/i

/** 单条路径是否属「需重启面」（纯函数） */
export function needsRestart(p) {
  if (typeof p !== 'string' || p === '') return false
  const s = p.replace(/\\/g, '/').toLowerCase()
  if (s.includes('/_archive/')) return false   // 备份区：与运行态无关（双保险；正则本身已不匹配 _archive 下的非 profile 路径）
  return RESTART_RELEVANT_RE.test(s)
}

/**
 * 判「本次修复是否需要重启」（纯函数）
 * @param {Array<{op?:string,path?:string}>} applied 已执行动作（真源 = `state.artifacts.applied`）
 */
export function assessRestartNeed(applied = []) {
  const list = Array.isArray(applied) ? applied : []
  const hits = []
  for (const a of list) {
    const p = a && typeof a === 'object' ? a.path : null
    if (typeof p === 'string' && needsRestart(p)) hits.push({ op: a.op ?? null, path: p })
  }
  return { needed: hits.length > 0, hits, checked: list.length }
}

/** 开关判定（纯函数；缺省开，`0|false|off|no` 关） */
export function advisoryEnabled({ env = process.env, opts = {} } = {}) {
  if (opts.restartAdvisory === false) return { enabled: false, why: 'CLI --no-restart-advisory' }
  const v = String((env && env.NURSE_RESTART_ADVISORY) ?? '').trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') {
    return { enabled: false, why: 'env NURSE_RESTART_ADVISORY=0' }
  }
  return { enabled: true, why: '缺省开（仅 --apply 真跑档 + 命中需重启面才写）' }
}

/** 生成待办卡文案（纯函数）—— 标题固定前缀便于主人/日报一眼识别与检索 */
export function buildAdvisoryCard({ caseId, hits = [], stage = 'done', endedAt = null } = {}) {
  const list = hits.map((h) => `- \`${h.path}\`（op=${h.op ?? '?'}）`).join('\n')
  const title = `【小护士·建议重启】${caseId}`
  const description = [
    `**小护士** 于 ${endedAt ?? new Date().toISOString()} 修完一场，判定**需要重启 DSH 才能让修复真正生效**（阶段=${stage}）。`,
    '',
    '改了这些「boot 才加载」的面：',
    list || '（无）',
    '',
    '⚠️ **本卡只是「建议」，护士不会自动重启**（方案 §7-5 第一步口径）。',
    '重启与否、何时重启，由主人决定（重启会打断所有在跑会话）。',
    '重启走统一闸门：`node <DSH_ROOT>/tools/dsh-butler/request-restart.mjs`（**P0 闸门**，禁裸 taskkill）。',
    '',
    `来源 case：\`${caseId}\` · 回滚来源：写前备份在 \`_archive\\nurse-case-*\\before\\\`（同路径拷回即回到修复前）。`,
  ].join('\n')
  const prompt = [
    `（本卡由小护士 ⑥b「建议重启」通道自动生成 · case ${caseId}）`,
    '',
    '主人确认要重启时：',
    '1. 先确认没有正在跑的关键会话（重启会打断全部在跑会话）；',
    '2. 走 P0 闸门 `node <DSH_ROOT>/tools/dsh-butler/request-restart.mjs`；',
    '3. 重启回来后核一遍护士修的那几处是否真生效；',
    '4. 确认无误后把本卡移 `done` 并写明结论。',
  ].join('\n')
  return { title, description, prompt }
}

/**
 * 往看板写一张建议卡（走 Host API，**不手改账本**）。
 * fail-open：任何失败都只返回 `{ok:false, error}`，绝不抛、绝不回滚修复。
 * @param {{baseUrl?:string, cookie?:string, header?:string, card:object, fetchImpl?:Function, timeoutMs?:number}} o
 */
export async function writeAdvisoryCard(o = {}) {
  const baseUrl = o.baseUrl || 'http://127.0.0.1:3080'
  const card = o.card || {}
  if (!card.title) return { ok: false, error: '卡片标题为空' }
  const action = { kind: 'create', id: randomUUID(), input: { title: card.title, description: card.description || '', prompt: card.prompt || '' } }
  const headers = { 'content-type': 'application/json', origin: baseUrl, 'sec-fetch-site': 'same-origin' }
  const cookieHeader = o.header || o.cookie
  if (cookieHeader) headers.cookie = cookieHeader
  const fetchImpl = o.fetchImpl || fetch
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8000)
  try {
    const res = await fetchImpl(`${baseUrl}/api/task-board/action`, {
      method: 'POST',
      headers,
      signal: ctl.signal,
      body: JSON.stringify({ requestId: randomUUID(), action }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.ok === false) {
      return { ok: false, error: `HTTP ${res.status}${body && body.error ? ' ' + JSON.stringify(body.error).slice(0, 200) : ''}`, httpStatus: res.status }
    }
    return { ok: true, taskId: action.id, revision: body.revision ?? body.value?.revision ?? null }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

export default { ADVISORY_VERSION, RESTART_RELEVANT_BASENAMES, needsRestart, assessRestartNeed, advisoryEnabled, buildAdvisoryCard, writeAdvisoryCard }
