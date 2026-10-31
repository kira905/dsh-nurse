/**
 * proposal-guard.mjs —— 小护士 P2 · 提案校验与执行器（《小护士-安全模式修复层方案》§5 G1 · D1=A）
 *
 * 分工（D1=A「判断与动手分离」）：
 *   agent 在**只读**安全实例里诊断 → 只产出**结构化修复提案**（JSON）→ 由本模块按白名单校验 → 执行。
 *   agent 永远不直接写生产文件。
 *
 * 三条硬约束（缺一条就不算护栏）：
 *   ① **fail-closed**：任何解析不了 / 判不准的情况一律拒（不许"看起来没问题就放行"）。
 *   ② **白名单面 = 极小**：profile 四件套 + 自研插件声明 + `_archive` 备份；其余一律拒。
 *   ③ **禁写面优先于允许面**：主包 / 全局 npm / node_modules（junction 区）/ 凭证 / settings /
 *      账本 / 记忆库 / sessions —— 即使同时命中允许面也一律拒。
 *
 * 只读边界：本模块自身不删任何文件（没有 delete 语义）；执行前对每个目标做**写前备份**（G4）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const PROPOSAL_VERSION = 1
/** 单次提案的动作数上限（预算闸的一部分，G5） */
export const MAX_ACTIONS = 20
/** 单文件内容上限（8MB：profile 清单不会有这么大，超了就是异常） */
export const MAX_CONTENT_BYTES = 8 * 1024 * 1024

/** 允许写入面（G1；精确到文件名，不做目录级放行） */
export const ALLOWED_WRITE_PATTERNS = [
  /[\\/]profiles[\\/][^\\/]+[\\/](package\.json|package-lock\.json|pnpm-lock\.yaml|cordis\.patch\.yml|\.package-map\.json|\.modules\.yaml)$/i,
  /[\\/]_archive[\\/]/i,
]

/** 禁写面（G1 黑名单；优先于允许面） */
export const FORBIDDEN_PATTERNS = [
  { re: /[\\/]profiles[\\/]node_modules([\\/]|$)/i, why: 'junction 区（profiles\\node_modules 实体化会让 dsh 崩）' },
  { re: /[\\/]node_modules([\\/]|$)/i, why: 'node_modules（依赖闭包，禁止实体化/改写）' },
  { re: /@deepseek-ai/i, why: '主包（全局 npm 面，禁改）' },
  { re: /[\\/]npm[\\/]node_modules/i, why: '全局 npm 安装面（禁改）' },
  { re: /credentials/i, why: '凭证文件（禁改）' },
  { re: /settings\.yaml$/i, why: 'settings.yaml（密钥/模型配置，禁改）' },
  { re: /memory\.db/i, why: '记忆库（用户数据，禁改）' },
  { re: /ledger-v2\.json/i, why: '看板账本（Host 权威持有，禁改）' },
  { re: /[\\/]sessions([\\/]|$)/i, why: '会话数据（用户数据，禁改）' },
  { re: /\.system32|[\\/]windows[\\/]/i, why: '系统层（禁碰）' },
]

/** 提案动作 op 白名单（**没有 delete/rm**） */
export const ALLOWED_OPS = ['write', 'mkdir', 'copy']

export function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}

/** 允许根：DSH 数据面（物理 realpath，防 junction 绕过） */
export function allowedRoots(home = os.homedir()) {
  const cands = [path.join(home, '.dsh'), (process.env.DSH_ROOT || path.join(home, 'DSH')), path.join(home, '.dsh-safe')]
  const out = []
  for (const c of cands) {
    try { out.push(fs.realpathSync(c)) } catch { out.push(path.resolve(c)) }
  }
  return out
}

/** 尽量解析物理路径（已存在 → realpath；新文件 → 父目录 realpath + 名字）；防 junction 绕过 */
function realish(p) {
  const abs = path.resolve(p)
  try { return fs.realpathSync(abs) } catch {
    try { return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)) } catch { return abs }
  }
}

/** 把根列表转成物理路径（realpath 失败则原样） */
function realRoots(roots) {
  return roots.map((r) => { try { return fs.realpathSync(r) } catch { return path.resolve(r) } })
}

/**
 * 允许根判定（真机实测口径，2026-09-15 两次踩坑后定稿）：
 *   ① **逻辑面必须在根内**（用户意图面：`<DSH_ROOT>\_archive\...` 就在 `<DSH_ROOT>` 内 ✅）
 *   ② **物理落点只跑禁止面**：`<DSH_ROOT>\_archive` 常是 junction → 物理落在树外，
 *      **本来就在 <DSH_ROOT> 之外**（合法！）。所以"物理面也要在根内"（AND）会把整片 junction 区误杀
 *      —— 实测：新建文件通过、已存在文件被拒（realpath 后跳到根外），同一路径两套结论。
 *      改为：物理面只用来挡"junction 指向系统敏感区"（命中 FORBIDDEN_PATTERNS 即拒）。
 *   ③ 建链接不是本执行器的能力（op 只有 write/mkdir/copy）→ 无法借本闸自造 junction 逃逸。
 */
export function isUnderRoot(p, roots = allowedRoots()) {
  const abs = path.resolve(p)
  const inList = (target, list) => list.some((root) => {
    const rel = path.relative(root, target)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
  if (!inList(abs, roots)) return false
  const phys = realish(abs)
  for (const { re } of FORBIDDEN_PATTERNS) if (re.test(phys)) return false
  return true
}

/**
 * 校验单条动作 → {ok:true, action} | {ok:false, reason}
 * fail-closed：路径不是绝对路径、命中禁写面、不在允许根、op 不合法 —— 任一条即拒。
 */
export function validateAction(act, { roots = allowedRoots() } = {}) {
  if (!act || typeof act !== 'object') return { ok: false, reason: 'action 不是对象' }
  const op = String(act.op || '').toLowerCase()
  if (!ALLOWED_OPS.includes(op)) return { ok: false, reason: `op 不在白名单（${ALLOWED_OPS.join('|')}）：${act.op}` }
  const p = act.path
  if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, reason: `path 必须是绝对路径：${p}` }
  for (const { re, why } of FORBIDDEN_PATTERNS) {
    if (re.test(p)) return { ok: false, reason: `命中禁写面（${why}）：${p}` }
  }
  if (!isUnderRoot(p, roots)) return { ok: false, reason: `路径不在允许根内（被拒）：${p}` }
  // mkdir 额外放行「profile 目录本身」（创建 profiles\<name> 是修 profile 声明的正常前置；
  // 只放行目录、不放行任意目录：必须是 profiles 下的一级目录）
  const mkdirProfileDir = op === 'mkdir' && /[\\/]profiles[\\/][^\\/]+$/i.test(p)
  if (!mkdirProfileDir && !ALLOWED_WRITE_PATTERNS.some((re) => re.test(p))) {
    return { ok: false, reason: `路径不在允许写入面（G1 只放行 profile 四件套 / 自研插件声明 / _archive）：${p}` }
  }
  if (op === 'write') {
    const c = act.content
    if (typeof c !== 'string') return { ok: false, reason: 'write 需要 string content' }
    if (Buffer.byteLength(c, 'utf8') > MAX_CONTENT_BYTES) return { ok: false, reason: `content 超过 ${MAX_CONTENT_BYTES} 字节上限` }
  }
  if (op === 'copy') {
    if (typeof act.from !== 'string' || !path.isAbsolute(act.from)) return { ok: false, reason: 'copy 需要绝对路径 from' }
    if (!isUnderRoot(act.from, roots)) return { ok: false, reason: `copy 来源不在允许根内：${act.from}` }
  }
  return { ok: true, action: { op, path: p, content: act.content, from: act.from, reason: act.reason || '' } }
}

/** 校验整份提案 → {ok, actions, rejected: [{action, reason}], diagnosis} */
export function validateProposal(raw, opts = {}) {
  let doc = raw
  if (typeof raw === 'string') {
    try { doc = JSON.parse(raw) } catch (e) { return { ok: false, reason: `提案不是合法 JSON：${e.message}`, actions: [], rejected: [] } }
  }
  if (!doc || typeof doc !== 'object') return { ok: false, reason: '提案不是对象', actions: [], rejected: [] }
  const actions = Array.isArray(doc.actions) ? doc.actions : (doc.proposal && Array.isArray(doc.proposal.actions) ? doc.proposal.actions : null)
  if (!actions) return { ok: false, reason: '提案缺少 actions 数组（结构化提案是唯一入口）', actions: [], rejected: [] }
  if (!actions.length) return { ok: false, reason: '提案 actions 为空（无事可做 ≠ 修复）', actions: [], rejected: [] }
  if (actions.length > MAX_ACTIONS) return { ok: false, reason: `提案动作数 ${actions.length} 超过上限 ${MAX_ACTIONS}`, actions: [], rejected: [] }

  const good = []
  const rejected = []
  for (const a of actions) {
    const v = validateAction(a, opts)
    if (v.ok) good.push(v.action)
    else rejected.push({ action: a, reason: v.reason })
  }
  const verdict = rejected.length === 0 ? 'pass' : (good.length === 0 ? 'reject' : 'partial')
  return {
    ok: rejected.length === 0,
    verdict,
    actions: good,
    rejected,
    diagnosis: doc.diagnosis || null,
    caseId: doc.caseId || null,
    reason: rejected.length ? `${rejected.length} 条动作被拒（白名单外 → fail-closed）` : null,
  }
}

/**
 * 备份落盘相对路径（**D-R-1 修复 · 2026-10-10**）。
 *
 * 旧实现 = `path.basename(a.path)`（本文件 :196）⇒ 两个**同名不同路径**的文件
 *   （例 `profiles\a\package.json` 与 `profiles\b\package.json`，或 `_archive\x\a.json` 与 `_archive\y\a.json`）
 *   在 `case-<ts>\before\` 里**互相覆盖** ⇒ 回滚时只能还原其中一个（D-R-1 🔴）。
 *
 * 现口径：**按「命中哪个允许根」保留相对路径结构** ——
 *   `<DSH_ROOT>\_archive\x.json`                     → `_archive\x.json`
 *   `<home>\.dsh\profiles\web\package.json`          → `profiles\web\package.json`
 *   `<home>\.dsh-safe\case-…\state.json`             → `case-…\state.json`
 *
 * 为什么按根取相对、而不是照搬盘符或全路径：
 *   ① 三个允许根是**互不相交的树** ⇒ 结构唯一性够用；
 *   ② 不把用户名/绝对用户路径写进目录名与审计行（与 `writeStateAtomic` 脱敏口径一致）；
 *   ③ 与 `tools\dsh-firstaid\drill.mjs#relKey` 同源（<DSH_ROOT> 下用相对路径）。
 * 兜底：不在任何允许根内（`validateAction` 已拒 ⇒ 理论不可达）→ 退回 `basename`；
 *   `used` 里已占用同一 rel（极端同名）→ 加 `__dupN` 后缀，**绝不静默覆盖已有备份**。
 *
 * @param {string} absPath 目标文件的绝对路径
 * @param {string[]} roots 允许根（逻辑面；默认 allowedRoots()）
 * @param {Set<string>} used 本次执行已占用的 rel（小写）集合
 */
export function backupRelPath(absPath, roots = allowedRoots(), used = new Set()) {
  const abs = path.resolve(absPath)
  let rel = null
  for (const r of roots) {
    const rr = path.relative(path.resolve(r), abs)
    if (rr && !rr.startsWith('..') && !path.isAbsolute(rr)) { rel = rr; break }
  }
  if (!rel) rel = path.basename(abs)
  if (!used.has(rel.toLowerCase())) { used.add(rel.toLowerCase()); return rel }
  for (let i = 2; i < 1000; i++) {
    const cand = `${rel}__dup${i}`
    if (!used.has(cand.toLowerCase())) { used.add(cand.toLowerCase()); return cand }
  }
  const last = `${rel}__dup${Date.now()}`
  used.add(last.toLowerCase())
  return last
}

/**
 * 执行提案（写前逐个备份，G4）。**只做 write/mkdir/copy，永不删除。**
 *
 * 【P2-A · G8 接审计】本函数**产出审计条目** `auditEntries`（纯数据，不自己做 IO）：
 *   每条动作一条 `{ event:'nurse-l2-action', op, path, ok, backup?, bytes?, error? }`，
 *   由**编排器**统一写入 `butler-audit`（`lib\audit.mjs#appendAudit`，append-only + 哈希链）。
 *   为什么不当场写：本模块保持**纯执行器**（dry-run 可跑、单测零副作用、无 async 耦合），
 *   审计出口留在编排器一处（G8 的四个出口全部可注入 ⇒ 测试零生产留痕）。
 *
 * @param {object} validated validateProposal 的产出
 * @param {object} deps { archiveRoot, dryRun, now, roots }
 *   `roots` = 备份落盘相对结构的基准根（D-R-1；缺省 `allowedRoots()`；单测可注入沙箱根）
 * @returns {object} { ok, applied, backups, failed, auditEntries, caseDir }
 */
export function executeProposal(validated, { archiveRoot, dryRun = true, now = new Date(), roots = null } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, '').slice(0, 15)
  const caseDir = path.join(archiveRoot || path.join(process.env.DSH_ROOT || path.join(os.homedir(), 'DSH'), '_archive'), `nurse-case-${stamp}`)
  const rootList = Array.isArray(roots) && roots.length ? roots : allowedRoots()
  const usedBackups = new Set()
  const applied = []
  const backups = []
  const failed = []
  const auditEntries = []
  if (!dryRun) fs.mkdirSync(caseDir, { recursive: true })

  for (const a of validated.actions || []) {
    try {
      if (a.op === 'mkdir') {
        if (!dryRun) fs.mkdirSync(a.path, { recursive: true })
        applied.push({ op: a.op, path: a.path })
        auditEntries.push({ event: 'nurse-l2-action', op: a.op, path: a.path, ok: true, dryRun })
        continue
      }
      if (a.op === 'write' || a.op === 'copy') {
        // 写前备份（存在才备份：新增文件无需备份）
        let backup = null
        let backupSha = null
        let backupRel = null
        if (fs.existsSync(a.path)) {
          // 【D-R-1 修复】原 `path.basename(a.path)` ⇒ 同名文件互相覆盖；现保留相对路径结构
          const rel = backupRelPath(a.path, rootList, usedBackups)
          const dest = path.join(caseDir, 'before', rel)
          if (!dryRun) {
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.copyFileSync(a.path, dest)
          }
          backup = dest
          backupRel = path.posix.join('before', rel.split(path.sep).join('/'))
          backupSha = sha256File(a.path)
          // ⚠️ 兼容字段不动：`backup` 仍是绝对落点（既有读取方按它找文件）；
          //    新增 `backupRel`（caseDir 相对·posix 分隔）供 restore-case.mjs 与报告使用。
          backups.push({ path: a.path, backup: dest, backupRel, sha256: backupSha })
        }
        if (!dryRun) {
          fs.mkdirSync(path.dirname(a.path), { recursive: true })
          if (a.op === 'copy') fs.copyFileSync(a.from, a.path)
          else fs.writeFileSync(a.path, a.content, 'utf8')
        }
        const bytes = a.op === 'write' ? Buffer.byteLength(a.content, 'utf8') : null
        applied.push({ op: a.op, path: a.path, bytes })
        auditEntries.push({
          event: 'nurse-l2-action', op: a.op, path: a.path, ok: true, dryRun, bytes,
          backup: backupRel, // 备份落点（**caseDir 相对路径**，如 `before/_archive/x.json`）· 不写绝对路径
          beforeSha256: backupSha,
        })
      }
    } catch (e) {
      failed.push({ path: a.path, error: String(e && e.message) })
      auditEntries.push({ event: 'nurse-l2-action', op: a.op, path: a.path, ok: false, dryRun, error: String(e && e.message) })
    }
  }
  if (!dryRun && (backups.length || applied.length)) {
    try {
      fs.writeFileSync(path.join(caseDir, 'manifest.json'), JSON.stringify({
        kind: 'nurse-case', createdAt: now.toISOString(), dryRun, backups, applied, failed,
        backupLayout: 'root-relative-v2',
        rollback: '把 before\\ 下的副本按本 manifest 的 backups[].path 拷回原路径即回到修复前（推荐用 tools\\dsh-nurse\\restore-case.mjs；本执行器不含删除语义）',
      }, null, 2), 'utf8')
    } catch { /* manifest 写失败不影响已应用的动作，但会体现在返回里 */ }
  }
  return { ok: failed.length === 0, applied, backups, failed, auditEntries, caseDir: dryRun ? null : caseDir }
}
