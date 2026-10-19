#!/usr/bin/env node
// ============================================================
//  nurse-verify.mjs — 小护士安全实例验收（P1 · V1/V2 实测）
//  ------------------------------------------------------------
//  三个模式：
//    --baseline     采集隔离基线（写 evidence\baseline-before.json）
//    （默认）       对**运行中的**实例取证：
//                     V1-a HTTP 200
//                     V1-b boot 载荷（window["__DSH_BOOT__"]）可解析、无 bootError
//                     V1-c 插件集：**全部 entries 必须是 @deepseek-ai/ 官方包**（自研零加载）
//                     V1-d API 探针：session.list（0.1.5 路径段形态；经 tools\lib\dsh-host-rpc.mjs 适配层 → 新线 /api/session/list + 自签 cookie，旧主包自动回落旧点号 POST /api/session.list）
//                     V2   严格面零变化（settings/credentials/profile 声明）——
//                          【2026-10-13】变化项按**护士实例在场窗口**归因：早于实例启动 ⇒ 归因生产/历史（不判 FAIL）
//    --safe-root <dir>  安全 home（默认 %USERPROFILE%\.dsh-safe）—— 同时决定 ① 证据目录 ② **cookie 的 home 口径**
//    --attribution  对照归因实验（证明"活跃面"的变化来自生产自身，不是 nurse）：
//                     W1 nurse 不在场 30s → 变化集合 P
//                     W2 nurse 在场 30s   → 变化集合 N
//                     判据：N ⊆ P（nurse 在场没带来新的变化项）+ 严格面零变化
//
//  ⚠ 为什么隔离判据要分层（2026-09-13 实测教训）：
//    生产实例**一直在跑**，它自己每分钟都在写 session_projcache / ledger / memory.db。
//    把这些文件单纯跟基线比 hash 必然"变化"→ 那是**生产的写入，不是 nurse 的**。
//    所以判据拆两层：① 生产不会写的面（严格面）必须零变化；
//    ② 生产会写的面（活跃面）用对照实验归因（W1 已证明生产自己就写）。
//
//  退出码：0 全绿 / 1 FAIL / 2 用法 / 3 环境不可用
//
//  【卡 S13 · 2026-10-08 · 判活回归修复】
//    `waitReady()` 曾手搓 `if (r.status === 200) return true` —— 0.1.5 起 dsh web 带 cookie
//    token 门：无 token 访问 `/` 返回 **401**（本卡实测 2026-10-08 `curl localhost:3080/` → 401）
//    ⇒ 判据**恒假**：安全实例明明起来了，也要白等满 90s 再报"未就绪"。
//    修法：判活一律走单一真源 `guard-http.mjs#judgeHttp`（绝对 `file:///` 导入）。
//    ⚠️ 卡 S13 当时只修判活，**同文件另有两类 token 门遗留**（① `[V1-a]` 的 `home.status === 200`；
//      ② `[V1-b]/[V1-c]` 的 boot 载荷要靠页面 HTML —— 裸 `GET /` 的 401 响应体是 68 字节纯文本
//      `dsh web authentication required…`，**没有 `__DSH_BOOT__`**）。**这两类已由卡 S14（2026-10-08）一并修掉**：
//      【卡 S14 · token 门判活遗留同批修】本文件两处取页面（`[V1-a]` 的 `home` + `[V1-c]` 生产对照的
//      `prodResp`）改为**带 cookie 再 GET**（`hostCookie()` 自签，密钥取本机 `.credentials.yaml`）
//      ⇒ 拿到真页面（本机实测 3080：200 / 54930 字节 / `hasBoot=true`），V1-b/V1-c 才有输入。
//      ⚠️ 判据**刻意不放松**：`[V1-a]` 仍要求真页面 **200**（不引入"401 也算起来了"这类降级判据）；
//      401 时只在 FAIL 文案里附一句判活口径的解释。
//      ⚠️ 已登记局限（**2026-10-13 卡「愿景核查 #20」已修，此段为历史记录**）：若目标实例
//      （如 `--port 3091` 的安全实例）用的是**它自己 home 的**签名密钥
//      （`~/.dsh-safe/.credentials.yaml` 与生产不同），这把 cookie 对它无效 ⇒ 仍 401。
//      ⇒ 修法 = 取页面 / 发 RPC 期间把 home 口径改道到 `--safe-root`，实现**抽去公用一份**
//        （`tools\lib\dsh-host-rpc.mjs#withDshHome`，与编排器 `injectViaAgent` 共用；
//        两份各写必然再分叉 —— 本文件就是因为没有它才对 3091 恒 401 的）。
//        判据**依旧不放松**：`[V1-a]` 仍要求真页面 **200**。
//
//  【入口守卫（卡 S13 新增，非卡面要求）】被 `import` 时**只导出判活入口**：不跑验收、
//    不建 `~/.dsh-safe/evidence`、不写证据、不改 `exitCode`。
//    为什么必须有：本文件是"脚本"形态（顶层直接开跑）——没有守卫，单测一 `import` 就会真去
//    探 3091/3080 并往安全 home 写证据（卡 S9 的 `dsh-maintenance.mjs` 踩过同一个坑）。
//    ⚠️ 判定必须 **realpath 双边比对**：junction/软链下 `process.argv[1]` 是逻辑路径、
//    `import.meta.url` 是物理路径，直接比字符串会**静默**不成立（＝最危险的失败模式）。
//
//  【风格说明】下面的主流程**刻意不重排缩进** —— 守卫只包一层 `if`，使"本段 179 行与加守卫前
//    逐字节相同"可被逐字节校验（见交付报告 §3.3 的字节比对），也让回滚只需摘 2 行。
// ============================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { hostRpc, hostRpcJson, hostCookie, withDshHome } from './lib/dsh-host-rpc.mjs';
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 【卡 S13 · 2026-10-08】HTTP 存活判据**单一真源**（H1 · 2026-09-22）：2xx/3xx/401/403 = 活。
//   接法 = 绝对 `file:///`（与卡 S9 的 dsh-maintenance.mjs 同款）：本文件本来就靠相对 specifier
//   引 `../lib/dsh-host-rpc.mjs` ⇒ **不可能**被自举成单文件复制到 %TEMP% 跑，相对路径没有额外好处；
//   全仓只此一份码表才是要守的事。代价：真源被移走/改名时本文件 import 阶段硬失败（不静默降级）。
import { judgeHttp, RULE_VERSION } from './lib/guard-http.mjs'
// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】PowerShell 一律走统一工具（pwsh 7 优先）：360 企业版
//   EDR 只对 5.1（powershell.exe）弹「PowerShell 命令执行攻击」；工具缺失 ⇒ 兜底 powershell。
const PS_EXE = await import('./lib/powershell-exe.mjs').then((m) => m.powerShellExe()).catch(() => 'powershell')

const HOME = os.homedir()
const PROD_HOME = path.join(HOME, '.dsh')
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const CTL = path.join(HERE, 'nurse-ctl.mjs')

const argv = process.argv.slice(2)
const hasFlag = (n) => argv.includes('--' + n)
const optVal = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const PORT = Number(optVal('port', 3091))
// 【2026-10-13 · 卡「愿景核查 #20」】安全 home 可改道（默认 `~\.dsh-safe`，与 `nurse-ctl --home` 口径一致）。
//   它同时钉两件事：① 证据目录（EVID）；② **cookie / RPC 的 home 口径** —— 取页面与发 RPC 期间
//   把 `BUTLER_DSH_HOME` 临时指向它（`withDshHome()`，与编排器同一份实现）。
//   不这么做：`hostCookie()` 用**生产 home** 的密钥签 cookie ⇒ 对 `.dsh-safe` 实例恒 401
//   （V2 报告 §7 缺口 1；本文件头那段"已修"注说的是同一件事）。
const SAFE_ROOT = path.resolve(optVal('safe-root', path.join(HOME, '.dsh-safe')))
const EVID = path.join(SAFE_ROOT, 'evidence')
const INSTANCE_FILE = path.join(SAFE_ROOT, 'nurse-instance.json')
// 设计上就指生产，不随环境改道（2026-09-14 环境边界判定）：PROD_PORT 是**安全闸基准**——
// 下面用它判定「取证目标是不是生产端口，是就 SAFETY ABORT」；改成可改道等于拆掉这道闸。
const PROD_PORT = 3080
const JSON_ONLY = hasFlag('json')
const MODE = hasFlag('baseline') ? 'baseline' : hasFlag('attribution') ? 'attribution' : 'verify'
const WINDOW_MS = Number(optVal('window', '30')) * 1000

const infos = [], warns = [], fails = []
const say = (s) => { if (!JSON_ONLY) process.stdout.write(s + '\n') }

// ---------- 基础工具 ----------
/**
 * 取页面（GET）。
 * 【卡 S14 · 2026-10-08】新增 `opts.cookie` —— token 门下**带 cookie 才拿得到真页面**：
 *   裸 `GET /` ⇒ 401 + 68 字节纯文本（**无 `__DSH_BOOT__`**）；带 cookie（`hostCookie()` 自签，
 *   密钥取本机 `.credentials.yaml`）⇒ 200 + 完整 HTML（含 boot 载荷）。判活语义不受影响（401 本就判活）。
 * @param {string} url
 * @param {number} [timeoutMs]
 * @param {{cookie?: {header?: string}|null}} [opts]
 */
async function fetchText(url, timeoutMs = 10000, opts = {}) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  const headers = {}
  if (opts.cookie && opts.cookie.header) headers.cookie = opts.cookie.header
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow', headers })
    return { status: r.status, text: await r.text() }
  } catch (e) {
    return { status: null, text: null, error: e.name === 'AbortError' ? 'timeout' : e.message }
  } finally { clearTimeout(t) }
}

/** 解析 window["__DSH_BOOT__"] 注入载荷（client 插件清单）。 */
function parseBoot(html) {
  if (!html) return null
  const i = html.indexOf('__DSH_BOOT__')
  if (i < 0) return null
  const eq = html.indexOf('=', i)
  if (eq < 0) return null
  let s = html.slice(eq + 1).trimStart()
  const end = s.indexOf('</script>')
  if (end >= 0) s = s.slice(0, end)
  s = s.trim().replace(/;\s*$/, '')
  try { return JSON.parse(s) } catch { return null }
}

/** client 插件 id：支持 @scope/name 形态（0.1.1-rc.2 实测如此）。 */
function pluginIds(html) {
  if (!html) return []
  const out = new Set()
  const re = /\/plugins\/((?:@[A-Za-z0-9_.\-]+\/)?[A-Za-z0-9_.\-]+)\/client\.js/g
  let m
  while ((m = re.exec(html))) out.add(m[1])
  return [...out].sort()
}

function hashOf(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase() } catch { return null }
}

function statOf(p) {
  try {
    const st = fs.statSync(p)
    return { exists: true, len: st.size, mtimeUtc: st.mtime.toISOString(), sha256: hashOf(p) }
  } catch { return { exists: false, len: null, mtimeUtc: null, sha256: null } }
}

// 严格面：生产**不会主动写**的文件（配置/凭证/插件声明）——nurse 一碰就露馅
const STRICT_FILES = [
  path.join(PROD_HOME, 'settings.yaml'),
  path.join(PROD_HOME, '.credentials.yaml'),
  path.join(PROD_HOME, 'profiles', 'web', 'package.json'),
  path.join(PROD_HOME, 'profiles', 'web', 'cordis.patch.yml'),
  path.join(PROD_HOME, 'profiles', 'web', '.modules.yaml'),
]
// 活跃面：生产运行期自己就会写（对照归因）
// 【B4 · 2026-10-10 · projcache 读写口径统一】projcache 在 0.1.5 已是 **per-record 分片目录**
//   （`storages\session_projcache\sessions\<key>.json`）；旧单文件是被 legacy-bootstrap 读的
//   前代形态，主机现网那份是 **126 B 历史空壳且永不被写**。
//   ⇒ 只盯单文件会**误报"projcache 零改动"**（真判据 = 分片目录 mtime/条数变化）。
//   这里按形态自动选：**分片目录在 ⇒ 盯分片目录**（目录 mtime/size 变化即露馅），否则盯单文件。
const PROJCACHE_SHARD_DIR = path.join(PROD_HOME, 'storages', 'session_projcache', 'sessions')
const projcacheActivePath = (() => {
  try { if (fs.statSync(PROJCACHE_SHARD_DIR).isDirectory()) return PROJCACHE_SHARD_DIR } catch { /* 落单文件 */ }
  return path.join(PROD_HOME, 'storages', 'session_projcache.json')
})()
const ACTIVE_FILES = [
  projcacheActivePath,
  path.join(PROD_HOME, 'storages', 'workspace.json'),
  path.join(PROD_HOME, 'task-board', 'ledger-v2.json'),
  path.join(PROD_HOME, 'memory', 'memory.db'),
]
const TREE_ROOTS = ['sessions', 'storages', 'task-board', 'memory', 'butler-audit']

/** ~/.dsh 关键子树的文件指纹（不跟随 junction；G3 关注账本/记忆/sessions）。 */
function treeFingerprint() {
  const acc = {}
  const walk = (dir, depth) => {
    let items
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const p = path.join(dir, it.name)
      let st
      try { st = fs.lstatSync(p) } catch { continue }
      if (st.isSymbolicLink()) continue // 不跟随链接（junction 铁律）
      if (it.isDirectory()) { if (depth > 0) walk(p, depth - 1); continue }
      acc[path.relative(PROD_HOME, p)] = `${st.size}:${Math.round(st.mtimeMs)}`
    }
  }
  for (const r of TREE_ROOTS) walk(path.join(PROD_HOME, r), 3)
  return acc
}

function diffTree(a, b) {
  const added = [], removed = [], changed = []
  for (const k of Object.keys(b)) {
    if (!(k in a)) added.push(k)
    else if (a[k] !== b[k]) changed.push(k)
  }
  for (const k of Object.keys(a)) if (!(k in b)) removed.push(k)
  return { added, removed, changed }
}

function snapshot() {
  return {
    at: new Date().toISOString(),
    strict: STRICT_FILES.map((p) => ({ path: p, ...statOf(p) })),
    active: ACTIVE_FILES.map((p) => ({ path: p, ...statOf(p) })),
    tree: treeFingerprint(),
  }
}

function diffSnapshots(a, b) {
  const ch = []
  for (const key of ['strict', 'active']) {
    const am = new Map(a[key].map((f) => [f.path, f]))
    for (const f of b[key]) {
      const bf = am.get(f.path)
      if (!bf) { ch.push({ group: key, path: f.path, why: '基线缺该项' }); continue }
      if (bf.sha256 && f.sha256) {
        if (bf.sha256 !== f.sha256) ch.push({ group: key, path: f.path, why: 'hash 变化' })
      } else if (bf.mtimeUtc !== f.mtimeUtc || bf.len !== f.len) {
        ch.push({ group: key, path: f.path, why: `mtime/len 变化（${bf.len}B/${bf.mtimeUtc} → ${f.len}B/${f.mtimeUtc}）` })
      }
    }
  }
  const tree = diffTree(a.tree, b.tree)
  return { files: ch, tree }
}

/** 读安全实例记录（`<safeRoot>\nurse-instance.json`，nurse-ctl 写；无/坏 ⇒ null）。 */
function readInstanceRecord() {
  try {
    const j = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8'))
    return j && typeof j === 'object' ? j : null
  } catch { return null }
}

/**
 * 严格面变化项的**归因**（纯函数，可单测）。
 *
 * 【2026-10-13 · 卡「愿景核查 #20」】为什么需要归因：文件头把"严格面"定义成"生产**不会主动写**"，
 *   但实测该前提不成立 —— `settings.yaml` / `profiles\web\package.json` / `cordis.patch.yml`
 *   都会被生产自己（GUI 改设置 / 插件部署 / 配置写入）改。旧实现只做「与基线比 sha」，
 *   基线一陈旧就把**生产的写入**报成「nurse 碰了生产配置面」⇒ 假红（V2 报告 §7 缺口 2，
 *   实测三件 before/after 逐字节一致、却报 3 项变化）。
 *
 *   归因窗口 = **本次护士实例的在场区间**（`nurse-instance.json.startedAt` → 现在）：
 *     · 变化项的 mtime **早于**实例启动 ⇒ 那时本次护士还不存在 ⇒ **归因生产/历史**（不判 FAIL）；
 *     · 变化项 mtime 落在窗口内、或**没有可用实例记录（无窗口可归因）** ⇒ 计入 FAIL（fail-closed，不放松）。
 *   ⚠️ 归因 ≠ 忽略：落 FAIL 的那一侧一条不少，只是把"不可能由本次护士造成"的变化如实摘出去。
 *
 * @param {Array<{path:string, why:string, mtime?:string|null}>} changed 严格面变化项
 *        （`mtime` 可直接由调用方带上；没带就用 `ctx.mtimeOf` 现读）
 * @param {{instance?:object|null, mtimeOf?:(p:string)=>string|null}} [ctx]
 *        `instance` = 实例记录（**调用方须先核对 port 一致**）；`mtimeOf` 返回 ISO 字符串或 null
 * @returns {{attributed:Array, unaccounted:Array, since:string|null}}
 */
export function attributeStrictChanges(changed = [], ctx = {}) {
  const { instance = null, mtimeOf = () => null } = ctx
  const since = instance && typeof instance.startedAt === 'string' ? instance.startedAt : null
  const sinceMs = since ? Date.parse(since) : NaN
  const attributed = []
  const unaccounted = []
  for (const c of changed) {
    const mtime = (c && c.mtime !== undefined && c.mtime !== null) ? c.mtime : mtimeOf(c.path)
    const item = { path: c.path, why: c.why, mtime }
    const t = mtime ? Date.parse(mtime) : NaN
    if (!since || !Number.isFinite(sinceMs)) {
      item.reason = '无可用实例在场窗口（实例记录缺失/端口不匹配）⇒ 无从归因，按 fail-closed 计'
      unaccounted.push(item)
    } else if (!Number.isFinite(t)) {
      item.reason = '读不到该文件 mtime（不存在/不可读）⇒ 无从归因，按 fail-closed 计'
      unaccounted.push(item)
    } else if (t < sinceMs) {
      item.reason = `变更早于本次护士实例启动（${since}）⇒ 归因生产自身/历史（基线过期即此形态）`
      item.since = since
      attributed.push(item)
    } else {
      item.reason = `变更落在护士实例在场窗口内（≥ ${since}）⇒ 不能排除本次护士，计 FAIL`
      item.since = since
      unaccounted.push(item)
    }
  }
  return { attributed, unaccounted, since }
}

function pidOnPort(port) {
  try {
    const s = execFileSync(PS_EXE, ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim()
    const pid = parseInt(s, 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch { return null }
}

function ctl(action) {
  try {
    return execFileSync(process.execPath, [CTL, action], { encoding: 'utf8', timeout: 60000, windowsHide: true })
  } catch (e) {
    return `[ctl ${action} 失败] ${e.message}`
  }
}

/**
 * 等安全实例「就绪」——【卡 S13 · 2026-10-08】判活口径改走**单一真源** `guard-http.mjs#judgeHttp`。
 *
 * 旧实现手搓 `if (r.status === 200) return true`：0.1.5 起 dsh web 带 cookie token 门，
 * 无 token 访问 `/` 返回 **401** ⇒ 判据**恒假**（白等满 90s 后把活着的实例报成"未就绪"）。
 * 真源口径：2xx / 3xx / 401 / 403 = 活；404 等其它 4xx / 5xx / 无应答 = 不活。
 *
 * @param {number} [timeoutMs] 等待上限（缺省 90s，轮询间隔 2s）
 * @returns {Promise<{ok:boolean, status:number|null, reason:string, rule:string, waitedMs:number, polls:number}>}
 *          最后一次探针的判定（ok=true 即就绪）；`status=null` = 连不上/超时（fail-closed 判不活）
 */
async function waitReady(timeoutMs = 90000) {
  const t0 = Date.now()
  const deadline = t0 + timeoutMs
  let polls = 0
  let last = { ok: false, status: null, reason: 'unparsable', rule: RULE_VERSION, waitedMs: 0, polls: 0 }
  while (Date.now() < deadline) {
    const r = await fetchText(`http://127.0.0.1:${PORT}/`, 4000)
    const j = judgeHttp(r.status)   // 连不上/超时 ⇒ status=null ⇒ unparsable ⇒ 不活（fail-closed，与旧口径等价）
    polls++
    last = { ok: j.alive, status: r.status, reason: j.reason, rule: j.rule, waitedMs: Date.now() - t0, polls }
    if (j.alive) return last
    await new Promise((r2) => setTimeout(r2, 2000))
  }
  return last
}

// ---------- boot 判据 ----------
function judgeBoot(html) {
  const boot = parseBoot(html)
  const out = { parsed: !!boot, entries: [], bootError: undefined, note: '' }
  if (!boot) {
    out.note = 'HTML 里找不到/解析不了 __DSH_BOOT__ 载荷'
    return out
  }
  out.entries = (boot.entries || []).map((e) => e.id).filter(Boolean)
  out.bootError = boot.bootError ?? boot.error
  out.hasBootErrorField = 'bootError' in boot || 'error' in boot
  if (!out.hasBootErrorField) out.note = '本版本载荷无 bootError 字段（0.1.1-rc.2 实测）→ 以「载荷可解析 + entries 非空 + 无 error 字段」等价判定'
  return out
}

// ============================================================
// 【卡 S13】入口守卫 —— 详见文件头"入口守卫"段。
//   ⚠️ 下面这一整段**刻意保持原缩进**（不重排）：守卫只是外面多包一层 if，
//      好处是"本段与本卡改动前逐字节相同"可以逐字节校验，回滚也只需摘掉这 2 行。
// ============================================================
const IS_ENTRY = (() => {
  try {
    const a = fs.realpathSync(process.argv[1] || '')
    const b = fs.realpathSync(fileURLToPath(import.meta.url))
    return a.toLowerCase() === b.toLowerCase()
  } catch { return false }
})()

if (IS_ENTRY) {
say('============================================================')
say(` 小护士安全实例验收（P1 · V1/V2）  模式=${MODE}`)
say('============================================================')
if (PORT === PROD_PORT) { say('SAFETY ABORT: 拒绝对生产端口 3080 取证'); process.exit(2) }
fs.mkdirSync(EVID, { recursive: true })
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)

if (MODE === 'baseline') {
  const snap = snapshot()
  fs.writeFileSync(path.join(EVID, 'baseline-before.json'), JSON.stringify(snap, null, 2) + '\n', 'utf8')
  say(`\n基线已写：${path.join(EVID, 'baseline-before.json')}`)
  say(`  严格面 ${snap.strict.length} 项 / 活跃面 ${snap.active.length} 项 / 树指纹 ${Object.keys(snap.tree).length} 个文件`)
  process.exitCode = 0
} else if (MODE === 'attribution') {
  // ---------- 对照归因实验 ----------
  const running = pidOnPort(PORT)
  say(`\n[W1] nurse 不在场窗口（${WINDOW_MS / 1000}s）`)
  if (running) { say(`     先停 nurse（pid ${running}）`); say(ctl('stop').trim()) }
  const s1 = snapshot()
  await new Promise((r) => setTimeout(r, WINDOW_MS))
  const s2 = snapshot()
  const d1 = diffSnapshots(s1, s2)
  const prodWrites = new Set([...d1.files.map((f) => f.path), ...d1.tree.changed.map((p) => path.join(PROD_HOME, p))])
  say(`     生产自身在静默窗口内改动了 ${d1.files.length} 个受监视文件、树指纹 ${d1.tree.changed.length} 项变化 / 新增 ${d1.tree.added.length} / 删除 ${d1.tree.removed.length}`)
  for (const f of d1.files) say(`       · ${path.basename(f.path)}（${f.why}）`)

  say(`\n[W2] nurse 在场窗口（${WINDOW_MS / 1000}s）`)
  say(ctl('start').split('\n').filter((l) => l.includes('pid ')).join('\n') || '     (已启动)')
  const ready = await waitReady()
  say(`     实例就绪：${ready.ok
    ? `HTTP 判活（status=${ready.status} · ${ready.reason} · ${ready.polls} 次探活 · 口径 ${ready.rule}）`
    : `⚠ 未就绪（最后：status=${ready.status ?? '无应答'} · ${ready.reason}）`}`)
  if (!ready.ok) fails.push(`W2：nurse 未在 90s 内就绪（最后 status=${ready.status ?? '无应答'} · ${ready.reason}）`)
  const s3 = snapshot()
  await new Promise((r) => setTimeout(r, WINDOW_MS))
  const s4 = snapshot()
  const d2 = diffSnapshots(s3, s4)
  say(`     nurse 在场期间改动了 ${d2.files.length} 个受监视文件、树指纹 ${d2.tree.changed.length} 项 / 新增 ${d2.tree.added.length} / 删除 ${d2.tree.removed.length}`)

  // 判据：严格面零变化 + 在场窗口没有 W1 未出现过的新变化项
  const strictChanged = d2.files.filter((f) => f.group === 'strict')
  if (strictChanged.length) fails.push(`严格面被改动：${strictChanged.map((f) => f.path).join(', ')}`)
  else infos.push('W2 严格面零变化（settings/credentials/profile 声明未被触碰）')

  const newActive = d2.files.filter((f) => f.group === 'active' && !prodWrites.has(f.path))
  if (newActive.length) warns.push(`nurse 在场期间活跃面新变化项：${newActive.map((f) => path.basename(f.path)).join(', ')}`)
  else infos.push('活跃面变化项与生产自身写入集合一致（归因生产，非 nurse）')

  const newTreeFiles = d2.tree.added.map((p) => path.join(PROD_HOME, p)).filter((p) => !prodWrites.has(p) && !p.includes('\\sessions\\'))
  if (newTreeFiles.length) warns.push(`nurse 在场期间新增受监视文件 ${newTreeFiles.length} 个：${newTreeFiles.slice(0, 5).join(', ')}`)

  const evidence = { mode: 'attribution', at: new Date().toISOString(), ready: ready.ok, readyProbe: ready, w1: { files: d1.files, tree: d1.tree }, w2: { files: d2.files, tree: d2.tree }, result: fails.length ? 'FAIL' : 'PASS', infos, warns, fails }
  fs.writeFileSync(path.join(EVID, `nurse-attribution-${stamp}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf8')
  say('\n============================================================')
  say(fails.length ? ' 归因结果：FAIL' : ' 归因结果：PASS')
  say('============================================================')
  for (const i of infos) say(`  [i] ${i}`)
  for (const w of warns) say(`  [warn] ${w}`)
  for (const f of fails) say(`  [FAIL] ${f}`)
  say('')
  process.exitCode = fails.length ? 1 : 0
} else {
  // ---------- verify ----------
  // 【卡 S14 · 2026-10-08】取页面**带 cookie**：token 门下裸 GET 只有 401 + 68 字节纯文本
  //   （无 `__DSH_BOOT__` ⇒ [V1-b]/[V1-c] 拿不到插件清单）；带 cookie 才是真页面（200 / 完整 HTML）。
  //   ⚠️ 判据**刻意不放松**：V1-a 仍要求真页面 **200** —— 不引入"401 也算起来了"这类降级判据。
  // 【2026-10-13 · 卡「愿景核查 #20」】cookie 的 home 口径**跟随 `--safe-root`**：
  //   签名密钥取自 home（`resolveDshHome()`）⇒ 对安全实例必须先改道到 `SAFE_ROOT`，否则恒 401。
  //   改道实现 = 共用的 `withDshHome()`（与编排器 `injectViaAgent` 同一份，见本文件头"已修"注）。
  const cookieFor = (baseUrl) => withDshHome(SAFE_ROOT, () => hostCookie(baseUrl))
  const home = await fetchText(`http://127.0.0.1:${PORT}/`, 10000, { cookie: await cookieFor(`http://127.0.0.1:${PORT}`) })
  const httpOk = home.status === 200
  const homeAlive = judgeHttp(home.status)
  say(`\n[V1-a] HTTP ${PORT}/ → ${home.status ?? '无响应（' + (home.error || '?') + '）'}`)
  if (!httpOk) fails.push(`实例未返回 HTTP 200（${home.status ?? home.error}${homeAlive.alive ? `；判活口径认为"有应答即活"=${homeAlive.reason}，但 V1 面要求的是**真页面**` : ''}）`)
  else infos.push('HTTP 200（带 cookie 取到的真页面）')

  const boot = judgeBoot(home.text)
  say(`[V1-b] boot 载荷：${boot.parsed ? '解析成功' : '解析失败'}；bootError=${boot.hasBootErrorField ? JSON.stringify(boot.bootError) : '（无该字段）'}`)
  if (boot.note) say(`       ${boot.note}`)
  if (!boot.parsed) fails.push('boot 载荷解析失败（页面可能没正常渲染）')
  else if (boot.hasBootErrorField && boot.bootError) fails.push(`bootError 非空：${JSON.stringify(boot.bootError)}`)
  else if (!boot.entries.length) fails.push('boot 载荷 entries 为空（无 client 插件加载）')
  else infos.push('boot 载荷正常（entries 非空、无 bootError）')

  const nursePlugins = boot.entries.length ? boot.entries : pluginIds(home.text)
  // 生产对照**故意不改道**（这里要的正是**生产 home** 签的 cookie；改道会让 3080 也 401）：
  const prodResp = await fetchText(`http://127.0.0.1:${PROD_PORT}/`, 10000, { cookie: hostCookie(`http://127.0.0.1:${PROD_PORT}`) })
  const prodBoot = judgeBoot(prodResp.text)
  const prodPlugins = prodBoot.entries.length ? prodBoot.entries : pluginIds(prodResp.text)

  say(`\n[V1-c] nurse 加载 client 插件 ${nursePlugins.length} 个；生产 ${prodPlugins.length} 个`)
  const nonOfficial = nursePlugins.filter((id) => !id.startsWith('@deepseek-ai/'))
  for (const id of nursePlugins) say(`        · ${id}${id.startsWith('@deepseek-ai/') ? '' : '   ← 非官方!'}`)
  if (nonOfficial.length) fails.push(`加载了非官方（自研/第三方）插件：${nonOfficial.join(', ')}`)
  else infos.push(`自研插件零加载（${nursePlugins.length} 个全是 @deepseek-ai/ 官方包）`)
  const selfIds = prodPlugins.filter((id) => !id.startsWith('@deepseek-ai/'))
  const leaked = nursePlugins.filter((id) => selfIds.includes(id))
  if (leaked.length) fails.push(`生产自研插件泄漏进 nurse：${leaked.join(', ')}`)
  say(`        生产侧非官方插件 ${selfIds.length} 个：${selfIds.join(', ') || '(无)'}`)

  // V1-d API 探针（同时是 B 形态「HTTP 注入」可行性的证据）
  let apiOk = null, apiNote = ''
  try {
    // 0.1.5 换线（2026-09-22）：适配层（新端点 + cookie；旧主包自动回落）
    // 【2026-10-13 · 卡「愿景核查 #20」】RPC 也在**安全实例的 home 口径**下发（`hostRpc` 内部
    //   自取 cookie ⇒ 不包在 `withDshHome` 里就又是生产密钥 ⇒ 对 3091 恒 401）。
    const r = await withDshHome(SAFE_ROOT, () => hostRpc(`http://127.0.0.1:${PORT}`, 'session.list', {}, { timeoutMs: 15_000 }))
    apiOk = r.status === 200 && r.body?.result !== undefined
    apiNote = `HTTP ${r.status}${apiOk ? '' : '：' + JSON.stringify(r.body).slice(0, 120)}`
  } catch (e) { apiNote = `异常：${e.message}` }
  say(`\n[V1-d] API 探针 session.list（适配层：新线 /api/session/list）→ ${apiNote}`)
  if (apiOk) infos.push('API 可用（client-request 信封生效 → B 形态 HTTP 注入可行）')
  else fails.push(`API 探针失败：${apiNote}`)

  // V1-e host 侧插件树（client entries 只覆盖 client 半；dump-config 覆盖全组合树）
  const SELF_PKG = [
    'dshmarket', 'whale-on-desk', 'dsh-memory', '@dickpy/dsh-imagegen', 'dsh-fish-tts',
    'dsh-ecosystem-panel', 'dsh-butler-panel', 'dsh-task-board-local', 'dsh-meme',
    'dsh-archive-sessions', 'dsh-task-control', 'dsh-download-progress',
    '@liustack/modlens', '@liustack/modsearch', '@vlln/dsh-task-status', '@wxg-prc-cpg/browser-skill-dsh-plugin',
  ]
  const bin = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  let dumpHit = null, dumpNote = ''
  try {
    const r = spawnSync(process.execPath, [bin, '--profile', 'nurse', '--dump-config'], {
      encoding: 'utf8', timeout: 120000, windowsHide: true,
      env: { ...process.env, DSH_HOME: SAFE_ROOT },
    })
    const text = `${r.stdout || ''}${r.stderr || ''}`
    dumpHit = SELF_PKG.filter((p) => text.includes(p))
    dumpNote = `组合树 ${text.length} 字符（退出码 ${r.status}）`
  } catch (e) { dumpNote = `dump-config 失败：${e.message}` }
  say(`\n[V1-e] host 插件树（--dump-config）→ ${dumpNote}`)
  if (dumpHit === null) warns.push('V1-e 未能采集 host 插件树')
  else if (dumpHit.length) fails.push(`host 组合树里出现自研包：${dumpHit.join(', ')}`)
  else { say('        自研包 0 命中（client 半 + host 半双面零自研）'); infos.push('host 组合树零自研（dump-config 实测）') }

  // V2 隔离：与基线比（分层判据 + 严格面按「护士实例在场窗口」归因）
  say('\n[V2] 隔离性（分层判据）')
  const now = snapshot()
  const baselineFile = path.join(EVID, 'baseline-before.json')
  let baseline = null
  try { baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) } catch { /* missing */ }
  let isoResult = 'unknown'
  let strictAttr = null
  if (!baseline) {
    warns.push('没有 baseline-before.json → 隔离性未比对')
  } else if (!baseline.strict || !baseline.tree) {
    warns.push('baseline-before.json 是旧格式（缺 strict/active/tree 分层）→ 请重跑 node nurse-verify.mjs --baseline')
  } else {
    const d = diffSnapshots(baseline, now)
    const strictChanged = d.files.filter((f) => f.group === 'strict')
    const activeChanged = d.files.filter((f) => f.group === 'active')
    // 归因窗口 = 本次护士实例的在场区间（实例记录**须与 --port 一致**才可用，否则视为无窗口）
    const instAll = readInstanceRecord()
    const inst = instAll && Number(instAll.port) === PORT ? instAll : null
    if (instAll && !inst) warns.push(`实例记录的 port=${instAll.port} 与本次 --port ${PORT} 不一致 ⇒ 不作为归因窗口（fail-closed）`)
    strictAttr = attributeStrictChanges(strictChanged, {
      instance: inst,
      mtimeOf: (p) => { try { return fs.statSync(p).mtime.toISOString() } catch { return null } },
    })
    strictAttr.baselineAt = baseline.at ?? null
    strictAttr.instanceFile = INSTANCE_FILE
    say(`        严格面（生产不写）：${strictChanged.length} 项变化 · 归因窗口起点 = ${strictAttr.since ?? '不可用（无实例记录）'}`)
    for (const a of strictAttr.attributed) say(`          ↳ 归因非本次：${a.path}｜${a.why}｜${a.reason}`)
    for (const u of strictAttr.unaccounted) say(`          ⚠ ${u.path}：${u.why}｜${u.reason}`)
    say(`        活跃面（生产自身会写）：${activeChanged.length} 项变化 —— ${activeChanged.map((f) => path.basename(f.path)).join(', ') || '无'}`)
    say(`        树指纹（账本/记忆/sessions/storages）：变化 ${d.tree.changed.length} / 新增 ${d.tree.added.length} / 删除 ${d.tree.removed.length}`)
    for (const p of d.tree.added.slice(0, 8)) say(`          + ${p}`)
    if (strictAttr.unaccounted.length) {
      fails.push(`严格面变化 ${strictAttr.unaccounted.length} 项落在护士在场窗口内（nurse 可能碰了生产配置面）：${strictAttr.unaccounted.map((f) => f.path).join(', ')}`)
    } else if (strictChanged.length) {
      // 归因成立 ⇒ **不是** FAIL：这些写入早于本次护士实例启动（生产自身/历史所致，陈旧基线即此形态）
      infos.push(`严格面有 ${strictChanged.length} 项历史变化，但全部早于本次护士实例启动（${strictAttr.since}）⇒ 归因生产/历史，非本次护士行为`
        + `（基线采于 ${strictAttr.baselineAt ?? '?'}；要清掉这行提示就重采基线：node nurse-verify.mjs --baseline）`)
    } else {
      infos.push('严格面零变化（settings/credentials/profile 声明未被触碰）')
    }
    if (activeChanged.length || d.tree.added.length) {
      warns.push('活跃面有变化 —— 生产自身也在写；需用 --attribution 对照归因（不作为 FAIL）')
      isoResult = 'needs-attribution'
    } else {
      infos.push('活跃面同样零变化')
      isoResult = 'clean'
    }
  }

  const evidence = {
    mode: 'verify', capturedAt: new Date().toISOString(), port: PORT,
    httpStatus: home.status, boot: { parsed: boot.parsed, entries: boot.entries, bootError: boot.bootError },
    nursePlugins, prodPlugins, nonOfficial, selfIds, leaked,
    api: { ok: apiOk, note: apiNote },
    hostTree: { selfPkgHit: dumpHit, note: dumpNote },
    isolation: isoResult,
    // 【2026-10-13】严格面变化项的归因读数（谁改的 / 窗口起点 / 为什么不算护士）—— 事后可对账
    strictAttribution: strictAttr ? {
      windowStart: strictAttr.since, instanceFile: strictAttr.instanceFile, baselineAt: strictAttr.baselineAt,
      attributed: strictAttr.attributed, unaccounted: strictAttr.unaccounted,
    } : null,
    result: fails.length ? 'FAIL' : 'PASS', infos, warns, fails,
  }
  if (home.text) fs.writeFileSync(path.join(EVID, `nurse-home-${stamp}.html`), home.text, 'utf8')
  fs.writeFileSync(path.join(EVID, `nurse-verify-${stamp}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf8')

  say('\n============================================================')
  say(fails.length ? ' 验收结果：FAIL' : ' 验收结果：PASS')
  say('============================================================')
  for (const i of infos) say(`  [i] ${i}`)
  for (const w of warns) say(`  [warn] ${w}`)
  for (const f of fails) say(`  [FAIL] ${f}`)
  say(`  证据：${path.join(EVID, `nurse-verify-${stamp}.json`)}`)
  say('')
  if (JSON_ONLY) process.stdout.write(JSON.stringify(evidence) + '\n')
  process.exitCode = fails.length ? 1 : 0
}
}   // ← 入口守卫闭合（卡 S13）：上面这个 `}` 收的是 verify 分支的 else，这一个收 `if (IS_ENTRY)`
// ============ 以下为 import 时也可见的导出面 ============

// 供单测复用（`tools\dsh-nurse\_test\test-nurse-http-alive.mjs`）：
//   · waitReady —— 就绪判据（401 必须判活 · 500/连不上必须判死）
//   · fetchText  —— 它在 waitReady 里被用来发请求（测试借桩端口验证真实行为）
//   · IS_ENTRY   —— 单测据此断言"被 import 时不跑主流程"
//   · attributeStrictChanges —— 严格面变化归因（纯函数；2026-10-13 卡「愿景核查 #20」）
export { waitReady, fetchText, IS_ENTRY }
