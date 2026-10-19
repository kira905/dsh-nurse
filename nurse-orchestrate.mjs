#!/usr/bin/env node
/**
 * nurse-orchestrate.mjs —— 小护士 P2 · 编排器（《小护士-安全模式修复层方案》§4.4 全流程）
 *
 * 定位（方案 §4.4）：**不新建一套进程**，把「起 / 注入 / 提案校验 / 执行 / 验收 / 关」这些
 *   **确定性动作**串起来；**判断交给安全实例里的 agent**（D1=A：判断与动手分离）。
 *
 * 流程（每步都写 case state，可断点续看）：
 *   ⓪.4 **残留收敛（G15/B4 · 2026-09-21 P2-B）**：开工前先判**上一次**的超期残留
 *        （`takeover.json` 超 TTL / 静默窗 holder 超 4h）⇒ 真释放 + 告警（判据与执行全在 `lib\residue-reaper.mjs`）
 *   ⓪ bootstrap（T3）：`~/.dsh-safe/profiles/nurse` 必须已预建；**半完成 case 未收尾 → 拒绝启动**（T7/G9）
 *   ⓪.5 跨线判据（G14 闸 2）：与升级链互斥（lane-gate 唯一源）
 *   ⓪.7 **降档闸（G7 · 2026-09-21 P2-A 补齐）**：degraded ⇒ **不自动起**（fail-closed，exit 3）
 *   ① 采集现场包（只读 + 脱敏）
 *   ①.5 接管声明（T2）：写 takeover.json —— ✅ guard 侧读取**已接线**（卡 ③-5 · 2026-09-20）：
 *        修复窗口内 guard 读到在场声明即走「不接管」闸（只探活、不拉起）
 *   ①.6 修复窗口静默（D4=A）：tools\dsh-upgrade-silence.mjs --disable（失败不阻断，标 warn）
 *   ② 起安全实例（nurse profile / 独立 home / 3091）+ 探活
 *   ③ 注入修复任务：`--proposal`（离线提案，测试/人工）或 `--inject llm`（HTTP 注入到安全实例，收 agent 提案；
 *        2026-10-10 接线 —— `--dry-run` 档只预检（凭证/通道/prompt），`--apply` 档才真投递，读回后仍过 ④ 白名单）
 *   ④ 提案校验（白名单 · fail-closed）→ ④.5 预算闸 → **④.7 降档闸（G7：degraded ⇒ 拒动）** → ④ 执行（写前备份）
 *   ⑤ 验收：**生产能否起来**（HTTP 判活 + boot 载荷；判活口径见 guard-http.mjs）
 *   ⑤.5 收尾：恢复静默 + 解除接管声明 + 关实例（**失败路径同样执行**）
 *   ⑥ 写报告 + 终态 + SLI + **审计/告警/通知（G8：成功与失败都要叫人）**
 *
 * 用法：
 *   node nurse-orchestrate.mjs --status                    # 列 case（含半完成态告警，只读）
 *   node nurse-orchestrate.mjs --plan                      # 打印将执行的步骤（不做任何事）
 *   node nurse-orchestrate.mjs --dry-run --proposal <f>    # 全流程演练：校验提案但不落盘、不起实例
 *   node nurse-orchestrate.mjs --apply --proposal <f>      # 真跑（起实例 + 执行提案）
 *   node nurse-orchestrate.mjs --apply --proposal <f> --no-instance   # 不起实例（修完直接验收）
 *   [--safe-root <dir>] [--port 3091] [--budget-rounds 8] [--budget-min 15] [--json]
 *   [--allow-degraded]   # 显式声明"人工触发"：降档态下仍继续（默认 fail-closed 拒动；每次留审计+告警）
 *
 * 退出码：0 完成（含"修完仍起不来但已冻结现场"）· 1 执行失败/被拒 · 2 用法 · 3 环境不可用
 *
 * 【2026-10-08 · 卡 S12 · 判活回归修复】`realDeps.probe()` 曾手搓 `res.status === 200` ——
 *   0.1.5 起 dsh web 带 cookie token 门：**无 token 访问 `/` 返回 401**
 *   （本卡实测 2026-10-08：`curl localhost:3080/` → 401 / 68 字节纯文本
 *    `dsh web authentication required…`；带 cookie 再 GET → 200 / 54930 字节 / 含 `__DSH_BOOT__`）
 *   ⇒ 旧判据把"活着的 dsh"判成死的：②「起安全实例就绪」恒假（白等 24s 后误判"起不来"）、
 *     ⑤「生产验收」永远过不了。
 *   修法：判活一律走**单一真源** `./lib/guard-http.mjs#judgeHttp`（相对 specifier 导入）。
 *   为什么是绝对 `file:///` 而不是 `../../guard-http.mjs`：① 与卡 S9 的 `dsh-maintenance.mjs` 同一接法，
 *     全仓只此一份码表；② 本文件的 `DSH_ROOT` 可由环境变量覆盖（lane-gate / autonomy-state /
 *     residue-reaper 三处薄壳都按绝对路径动态 import）；③ 本文件靠相对 specifier 引 `./lib/*`，
 *     **不可能**被自举成单文件复制到 %TEMP% 运行 ⇒ 相对路径并没有"副本更稳"的好处。
 *   代价（刻意）：`lib/guard-http.mjs` 若被移走/改名，编排器会在 import 阶段硬失败（不是静默降级）——
 *     修复工具宁可"起不来并报错"，也不要"带错判据跑完修复窗口"。
 *   ⚠️ 卡 S12 当时只修判活：⑤ 的 **boot 载荷**那半边在 token 门下同样拿不到（401 响应体里没有 `__DSH_BOOT__`）
 *     ⇒ 真跑 `--apply` 时 ⑤ 仍会因 boot=false 冻结现场。**那半边已由卡 S14（2026-10-08）修掉**：
 *     `realDeps.probe()` 现在**默认带 cookie**（`hostCookie()` 自签，密钥取本机 `.credentials.yaml`；
 *     单测可用 `opts.cookie` 显式覆写或传 `null` 关掉）⇒ 取到真页面（本机实测 3080：200 / 54930 字节 / 含 `__DSH_BOOT__`）。
 *     ⚠️ 判据**刻意不放松**：⑤ 仍要求「判活 ∧ 真页面里真有 `__DSH_BOOT__`」两条都成立。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
// 【卡 S12】HTTP 存活判据单一真源（H1 · 2026-09-22）：2xx/3xx/401/403 = 活；其它 4xx/5xx/无应答 = 不活
import { judgeHttp, RULE_VERSION } from './lib/guard-http.mjs'
import { validateProposal, executeProposal, ALLOWED_OPS, MAX_ACTIONS } from './lib/proposal-guard.mjs'
// 【卡 S14 · 2026-10-08 · token 门判活遗留同批修】取页面要用的自签 cookie（密钥取本机 `.credentials.yaml`）：
//   token 门下裸 `GET /` ⇒ 401 + 68 字节纯文本（**无 `__DSH_BOOT__`**）⇒ ⑤ 的 boot 判据永远拿不到输入。
// 【2026-10-13 · 卡「愿景核查 #20」】`withDshHome` = 把「调用期间把 `BUTLER_DSH_HOME` 指向 `<safeRoot>`」
//   这段改道逻辑**抽成共用一份**（本文件原先是内联私有 `withHome()`；`nurse-verify.mjs` 缺失同款 ⇒ 对 3091 恒 401）。
import { hostCookie, hostRpc, withDshHome } from './lib/dsh-host-rpc.mjs'
import {
  newCaseId, caseDir, statePath, newState, readState, setPhase, writeStateAtomic,
  checkBudget, bumpRound, findIncompleteCases, sliOf, TERMINAL_PHASES, EXTERNAL_TERMINAL_PHASES,
  MAX_TOKENS_DEFAULT,
} from './lib/case-state.mjs'
import * as bridge from './lib/butler-bridge.mjs'
// 【D-§4 · 2026-10-12 · V2.9收口·真缺口②】「建议重启」通道 —— **只写建议待办，绝不自动重启**（方案 §7-5 第一步）。
//   判据/开关/写卡全在这个库里（`restart-advisory.mjs`）；本文件（编排器）只在 ⑥b 挂一处调用。
//   ⚠️ 本文件**不得** import `request-restart.mjs` —— 那等于把"自动重启"接进来（= 乙档断服务红线）。
import * as restartAdvisory from './lib/restart-advisory.mjs'
// 【C-G10 · 2026-10-14 · V2.9封口①类 · P域 L918】冒烟前置 —— 「上生产前过测试环境冒烟」。
//   判据/开关/命令组装/结果判定全在这个库里（`smoke-gate.mjs`）；本文件只在 ④ 执行前挂一处调用（④.8）。
//   ⚠️ 库是**纯判定**（fail-closed：不过就拦），本文件负责留痕（审计 + 告警）与拦阻（throw ⇒ 冻结现场）。
import * as smokeGate from './lib/smoke-gate.mjs'

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2
const EXIT_ENV = 3

const SAFE_ROOT_DEFAULT = path.join(os.homedir(), '.dsh-safe')
const NURSE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DSH_ROOT = process.env.DSH_ROOT || path.join(os.homedir(), 'DSH')
const PROD_URL = 'http://127.0.0.1:3080/'
// 【卡 ③-5 · 闸 2】跨线判据薄壳（与守护鱼闸门**同一份**：lane-gate.mjs → cross-lane.judgeLane）
const LANE_GATE_PATH = path.join(DSH_ROOT, 'tools', 'dsh-butler', 'lib', 'lane-gate.mjs')
// 【P2-A · G7】降档判定薄壳（与 repair L2 / butler runAction **同一份**：autonomy-state.mjs —— 禁写第二套判定）
const AUTONOMY_STATE_PATH = path.join(DSH_ROOT, 'tools', 'dsh-butler', 'lib', 'autonomy-state.mjs')
// 【P2-B · G15/B4】残留收敛（三层挂点共用**同一份**判据与执行：residue-reaper.mjs —— 禁写第二套 if）
const RESIDUE_REAPER_PATH = path.join(DSH_ROOT, 'tools', 'dsh-butler', 'lib', 'residue-reaper.mjs')

// ─────────────────────────── 真实依赖（可注入，便于单测） ───────────────────────────
export const realDeps = {
  /**
   * **生产标记**（2026-10-10 · C-V8 防污染）：只有真生产的 deps 带它。
   * 用途单一 —— 决定「知识库写入」这一步敢不敢落**生产 home**：
   *   注入式 deps（单测/沙箱）没有它 ⇒ 不写生产库（要么显式注入 `appendKnowledge`，要么走 dry-run 分支）。
   * 为什么不是"看 deps 有没有 appendKnowledge"：部分注入的老套件会漏 ⇒ 静默写生产（本卡实测 17→27 条）。
   */
  isReal: true,
  now: () => new Date(),
  node: process.execPath,
  /** 跑一条 CLI（返回 {code, out}） */
  cli(script, args = [], { timeoutMs = 120000 } = {}) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: timeoutMs })
    return { code: r.status === null ? -1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }
  },
  /**
   * 取页面（node fetch + AbortController：pwsh Invoke-WebRequest 抓 DSH 首页会挂死）。
   * 【卡 S12 · 2026-10-08】"算不算活"由**单一真源** `guard-http.mjs#judgeHttp` 回答 ——
   *   本函数只负责**发请求 + 交状态码**，不另写判断（旧实现手搓 `res.status === 200`，
   *   token 门下恒判死；本机实测 `curl localhost:3080/` → 401 = 活着）。
   * 【卡 S14 · 2026-10-08】请求**默认带 cookie**（`hostCookie()` 自签，密钥取本机 `.credentials.yaml`）：
   *   token 门下只有带 cookie 才拿得到**真页面**（否则 401 响应体只有 68 字节纯文本、没有 `__DSH_BOOT__`
   *   ⇒ ⑤ 的 boot 判据拿不到输入）。判活语义不受影响（401 本就判活）。
   *   `opts.cookie` 可显式覆写（传 `null` = 裸 GET，供单测/对照用）。
   * 返回：`{ ok, status, reason, rule, text }`（无应答时 status=0 / reason='no-answer'）。
   * @param {string} url
   * @param {number} [timeoutMs]
   * @param {{cookie?: {header?: string}|null}} [opts]
   * @returns {Promise<{ok:boolean,status:number,reason:string,rule:string,text:string,error?:string}>}
   */
  async probe(url, timeoutMs = 5000, opts = {}) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const headers = {}
      const ck = opts.cookie !== undefined ? opts.cookie : hostCookie(new URL(url).origin)
      if (ck && ck.header) headers.cookie = ck.header
      const res = await fetch(url, { signal: ac.signal, headers })
      const text = await res.text()
      const j = judgeHttp(res.status)
      return { ok: j.alive, status: res.status, reason: j.reason, rule: j.rule, text }
    } catch (e) {
      // fetch 抛错 = 连不上/超时（等价 curl 的 `000`）⇒ 仍交给真源判（'000' → no-answer → 不活）
      const j = judgeHttp('000')
      return { ok: j.alive, status: 0, reason: j.reason, rule: j.rule, text: '', error: String(e && e.message) }
    } finally { clearTimeout(t) }
  },
  /**
   * 【C-G10 · 2026-10-14】**跑冒烟脚本**（④.8 挂点用）。真跑 = 真起一次**隔离测试实例**（默认 3090、
   *   跑完脚本自带收尾停实例），与生产 3080 互不相干。
   *   返回形状与 `cli()` 同族（`{code, out}`）+ `timedOut`：判据不在这里 —— 一律交
   *   `lib\smoke-gate.mjs#interpretSmokeResult()`（**本文件不写第二套判定**）。
   */
  smoke(script, args = [], { timeoutMs = 300_000 } = {}) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    const errCode = r.error && r.error.code
    return {
      code: r.status === null ? -1 : r.status,
      out: `${r.stdout || ''}${r.stderr || ''}`.trim(),
      timedOut: errCode === 'ETIMEDOUT' || /timed? ?out/i.test(String((r.error && r.error.message) || '')),
      error: r.error ? `${errCode || ''} ${r.error.message}`.trim() : undefined,
    }
  },
  exists: (p) => { try { fs.statSync(p); return true } catch { return false } },
  listCases: (safeRoot) => findIncompleteCases(safeRoot),
}

function parseArgs(argv) {
  const o = {
    mode: null, proposal: null, inject: null, safeRoot: SAFE_ROOT_DEFAULT, port: 3091,
    budgetRounds: 8, budgetMin: 15, budgetTokens: MAX_TOKENS_DEFAULT, knowledge: true,
    json: false, instance: true, caseId: null, help: false, silence: true,
    allowDegraded: false, noNotify: false, auto: false,
    // 【D-§4 · 2026-10-12】建议重启通道开关（缺省**开**；仅 --apply 真跑档 + 命中需重启面才写）
    restartAdvisory: true,
    // 【C-G10 · 2026-10-14】冒烟前置开关与参数（缺省**开**；仅 --apply 真跑档、④ 执行前拦一道）
    smoke: true,
    smokeScript: null,        // null ⇒ 库里的 SMOKE_SCRIPT_DEFAULT（测试根侧真身）
    smokePort: 3090,          // 隔离测试实例端口（拒 3080）
    smokeTimeoutMs: null,     // null ⇒ 库里的 SMOKE_TIMEOUT_MS_DEFAULT（5 分钟）
    allowSmokeSkip: false,    // 人工显式放行（留痕 + 告警；方案「零依赖沙箱」路径用）
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) { console.error(`✗ ${a} 缺参数`); process.exit(EXIT_USAGE) }
      return v
    }
    if (a === '--status') o.mode = 'status'
    else if (a === '--plan') o.mode = 'plan'
    else if (a === '--dry-run') o.mode = 'dry-run'
    else if (a === '--apply') o.mode = 'apply'
    // 【P2-B】自动触发档（守护鱼崩溃链用）：真动手的**采证档** —— 收敛残留 + 采集现场包 + 报告/通知，
    //   零修复动作（不写接管声明 / 不动静默窗 / 不起实例 / 不读提案 / 不执行 / 不验收）。
    else if (a === '--auto') { o.mode = 'apply'; o.auto = true; o.instance = false }
    else if (a === '--proposal') o.proposal = next()
    else if (a === '--inject') o.inject = next()
    else if (a === '--inject-wait-ms') o.injectWaitMs = Number(next())
    else if (a === '--inject-poll-ms') o.injectPollMs = Number(next())
    else if (a === '--safe-root') o.safeRoot = next()
    else if (a === '--port') o.port = Number(next())
    else if (a === '--case') o.caseId = next()
    else if (a === '--budget-rounds') o.budgetRounds = Number(next())
    else if (a === '--budget-min') o.budgetMin = Number(next())
    else if (a === '--budget-tokens') o.budgetTokens = Number(next())
    else if (a === '--no-knowledge') o.knowledge = false
    else if (a === '--no-restart-advisory') o.restartAdvisory = false
    else if (a === '--no-smoke') o.smoke = false
    else if (a === '--smoke-script') o.smokeScript = next()
    else if (a === '--smoke-port') o.smokePort = Number(next())
    else if (a === '--smoke-timeout-ms') o.smokeTimeoutMs = Number(next())
    else if (a === '--allow-smoke-skip') o.allowSmokeSkip = true
    else if (a === '--no-instance') o.instance = false
    else if (a === '--no-silence') o.silence = false
    else if (a === '--allow-degraded') o.allowDegraded = true
    else if (a === '--no-notify') o.noNotify = true
    else if (a === '--json') o.json = true
    else if (a === '--help' || a === '-h') o.help = true
    else { console.error(`✗ 未知参数 ${a}`); process.exit(EXIT_USAGE) }
  }
  return o
}

function usage() {
  console.log([
    '用法：node nurse-orchestrate.mjs <--status|--plan|--dry-run|--apply> [选项]',
    '',
    '  --status                    列出 case（含未收尾的半完成态告警；只读）',
    '  --plan                      打印将执行的步骤（不做任何事）',
    '  --dry-run --proposal <file> 演练：校验提案、不落盘、不起实例',
    '  --apply  --proposal <file>  真跑：起安全实例 + 执行提案 + 验收 + 收尾',
    '  --auto                      **自动触发档**（守护鱼崩溃链用）：收敛残留 + 采集现场包 + 报告/通知，',
    '                              **零修复动作**（不写接管声明/不动静默窗/不起实例/不读提案/不执行/不验收）',
    '  --no-instance               不起安全实例（例如只想走执行/验收）',
    '  --no-silence                跳过修复窗口静默（不动 tickd；隔离实测时用）',
    '  --inject llm                从安全实例的 agent 收提案（HTTP 注入；需隔离 home 有**通道凭证**与 **LLM 凭证**）',
    '                              ⚠️ `--apply` 档才真投递（= 真跑 LLM、烧 token）；`--dry-run` 档只预检：',
    '                                 凭证检查 + 通道探活 + prompt 组装落盘，**不投递**。',
    '  --inject-wait-ms <n>        等 agent 提案的上限（默认 180000；仅 --apply --inject llm 用）',
    '  --inject-poll-ms <n>        读回轮询间隔（默认 5000）',
    '  --allow-degraded            显式声明「人工触发」：降档（degraded）态下仍继续（默认 fail-closed 拒动）',
    '  --no-notify                 不发桌宠/会话通知（**演练与排障用**；G8 的留痕与告警照旧）',
    '  --safe-root <dir>           安全 home（默认 %USERPROFILE%\\.dsh-safe）',
    '  --port <n>                  安全实例端口（默认 3091；拒绝 3080）',
    '  --budget-rounds <n> / --budget-min <n>   预算闸（默认 8 轮 / 15 分钟）',
    `  --budget-tokens <n>         token 预算闸（G5 · 默认 ${MAX_TOKENS_DEFAULT}；超限即冻结转 L2）`,
    '  --no-knowledge              收尾不写修复知识库（`~/.dsh/repair-knowledge`）',
  '  --no-restart-advisory       关回「建议重启」通道（⑥b：不写看板待办卡、不出该告警）；',
  '                              等价于 env `NURSE_RESTART_ADVISORY=0`。缺省开，且只在',
  '                              `--apply` 真跑档 + 命中「需重启才生效面」时才写（只建议，绝不自动重启）',
  '  --no-smoke                  关回「冒烟前置」（④.8 · C-G10）；等价于 env `NURSE_SMOKE=0`。缺省开，且只在',
  '                              `--apply` 真跑档时拦（上生产前过测试环境冒烟：' + smokeGate.SMOKE_SCRIPT_DEFAULT + '）',
  '  --smoke-script <file>       冒烟脚本（默认 = 测试根侧真身；隔离实测/沙箱可指向夹具）',
  '  --smoke-port <n>            冒烟跑的隔离实例端口（默认 3090；**拒 3080 = 生产**）',
  '  --smoke-timeout-ms <n>      冒烟超时（默认 300000 = 5 分钟；超时 = unavailable ⇒ 拦）',
  '  --allow-smoke-skip          **人工显式**放行「冒烟未过」（方案 §5 G10 零依赖沙箱路径）；会留痕 + 出告警',
    '',
    `  允许写入面（G1）：${ALLOWED_OPS.join('/')} · 最多 ${MAX_ACTIONS} 条动作 · 路径必须命中 profile 四件套 / 自研插件声明 / _archive`,
  ].join('\n'))
}

/** ⓪ bootstrap 检查（T3）：profile 必须预建；半完成 case 未收尾 → 拒启（T7/G9） */
export function bootstrapCheck(o, deps = realDeps) {
  const problems = []
  const nurseProfile = path.join(o.safeRoot, 'profiles', 'nurse')
  if (!deps.exists(nurseProfile)) {
    problems.push(`安全 profile 缺失：${nurseProfile}（先跑 node tools\\dsh-nurse\\make-nurse-profile.mjs —— **不能等到出事那天才建**）`)
  }
  const incomplete = deps.listCases(o.safeRoot)
  if (incomplete.length) {
    problems.push(`存在未收尾的半完成 case ${incomplete.length} 个（T7/G9）：${incomplete.map((c) => `${c.caseId}[${c.phase}]`).join(', ')} → 先用其 before/ 备份回滚到修复前，再决定是否重跑`)
  }
  return { ok: problems.length === 0, problems, incomplete, nurseProfile }
}

/**
 * 【卡 ③-5 · 闸 2】跨线判据（③ 包方案 §3.5(b)）—— **与守护鱼闸门同一份判据**。
 * 唯一源 = `tools\dsh-butler\lib\lane-gate.mjs`（它薄壳到 `cross-lane.judgeLane`）：
 *   · `apply` + `owner==='upgrade'`（held / uncertain / interrupted 三态任一）⇒ **拒启**（调用方 exit 3）；
 *   · 判据不可用 ⇒ **同一 fail-safe**（保守：拒启 apply）；
 *   · `dry-run` 档**仍可跑**（只报告不写）——判据只拦"真动手"。
 * 本函数**不写第二份 if**：判定与文案全在 lane-gate.mjs 的 gateDecision()（§3.5(d) 三闸同源）。
 * @param {object} deps 可注入 `judgeLane`（单测用：不碰真实 home）
 * @param {{home?:string|null}} [opts]
 */
export async function judgeNurseLane(deps = realDeps, opts = {}) {
  if (typeof deps.judgeLane === 'function') return deps.judgeLane(opts)
  try {
    const mod = await import(pathToFileURL(LANE_GATE_PATH).href)
    const lane = await mod.judgeLaneSafe({ self: 'nurse', home: opts.home ?? null })
    return mod.gateDecision(lane, { self: 'nurse' })
  } catch (e) {
    return {
      blocked: true, code: 'judge-unavailable', suppressed: 'judge-unavailable', owner: null,
      judgeUnavailable: true, upgradeState: null,
      reason: `跨线判据不可用（${e && e.message ? e.message : e}）→ 保守拒启（fail-closed）`,
    }
  }
}

function step(name, fn) {
  return async (...args) => {
    const r = await fn(...args)
    return { name, ...r }
  }
}

/**
 * 【P2-A · G7】降档闸 —— 「degraded 期间**不自动起**小护士 + 不执行任何 L2 动作」。
 *
 * 唯一源 = `tools\dsh-butler\lib\autonomy-state.mjs` 的 `checkAutonomyAllowed()`（**禁写第二套判定**）：
 *   · 该库的 fail-safe 已定死：**缺文件 / 损坏 / 读失败一律 degraded**（显式 `normal` 才放行）；
 *   · 本函数只是**薄壳**（动态 import + 判据不可用时同一 fail-safe：保守拒动），不复制任何 if。
 *
 * 语义边界（照 autonomy-state 原文）：
 *   · degraded = "暂停一切自主动作，仅允许诊断与报告"，**人工触发的入口不受影响**
 *     ⇒ 主人手动入口用 `--allow-degraded` 显式声明（默认不传 = fail-closed 拒动）；
 *     每次放行都写审计（`nurse-degrade-override`）+ 告警，绝不静默。
 *
 * @param {object} deps 可注入 `checkAutonomy(opts)`（单测用：不碰真实 home）
 * @param {{kind?:string}} [opts]
 */
export async function judgeNurseDegrade(deps = realDeps, opts = {}) {
  const kind = opts.kind ?? 'nurse'
  if (typeof deps.checkAutonomy === 'function') {
    const r = deps.checkAutonomy({ kind }) ?? {}
    return { allowed: r.allowed === true, level: r.level ?? 'unknown', reason: r.reason ?? '', hint: r.hint ?? '', file: r.file ?? null, kind, judgeUnavailable: r.judgeUnavailable === true }
  }
  try {
    const mod = await import(pathToFileURL(AUTONOMY_STATE_PATH).href)
    const r = mod.checkAutonomyAllowed({ kind })
    return { allowed: r.allowed === true, level: r.level, reason: r.reason, hint: r.hint, file: r.file, kind, judgeUnavailable: false }
  } catch (e) {
    return {
      allowed: false, level: 'degraded', kind, judgeUnavailable: true, file: null,
      reason: `checkAutonomyAllowed 不可用（${e && e.message ? e.message : e}）`,
      hint: '判据不可用 ⇒ 同一 fail-safe：保守拒动（fail-closed）',
    }
  }
}

// ─────────── ③ `--inject llm`：把修复任务注入安全实例、收回 agent 提案（2026-10-10 · 卡「补P域余」） ───────────
/**
 * 定位：编排器的**第二条提案入口**（第一条 = `--proposal` 离线提案）。
 *   通道 = **HTTP**（不另起 headless 子进程）：对 `<safeRoot>` 起的安全实例发 Host RPC ——
 *   `session.create` → `session.prompt` → 轮询 `session.page` 读回 agent 回复 → 抽提案 JSON。
 *   为什么是 HTTP：① 安全实例本来就由 ② 步起着（复用、不新建第二套进程）；
 *   ② headless 的一次性输出通道（stdin / `--json` 事件流）属 0.1.6 线
 *      （`docs\大管家全家桶-0.1.5能力升级准备-20260923.md`）⇒ 0.1.5 上拿不到结构化回执。
 *
 * 四条硬边界（照方案 §4.3「判断与动手分离 D1=A」，改之前先读）：
 *   ① **agent 只出提案、绝不直接动手**：读回的 JSON 仍要过 ④ 的 G1 白名单校验；
 *      被拒即 `phase=failed` + 冻结现场（那条路上**一条动作都不执行**）—— 本通道不放松任何闸门。
 *   ② **凭证是两个面，别混为一谈**：`client-connection/browser-session`（cookie 签名密钥）缺 ⇒ 通道连不上；
 *      **LLM 凭证**缺 ⇒ 通道通、但 agent 跑不出提案（P1 实测 `.dsh-safe` 报 `MISSING_CREDENTIAL: llm-deepseek`
 *      —— 那同时是「隔离性成立」的正面证据）。两者**都不许假装成功**，一律 fail-closed 并如实报哪一面缺。
 *   ③ **dry-run 档只预检、不真投递**：真投递会真跑 LLM（烧 token）⇒ dry-run 只做
 *      「凭证检查 + 通道探活（只读 `session.list`）+ prompt 组装落盘」三件事，并把**真实读数**回报。
 *   ④ **cookie 的 home 口径**：`hostCookie()` 的签名密钥取 `resolveDshHome()`（=`BUTLER_DSH_HOME` > `DSH_HOME` > `~/.dsh`），
 *      而本通道的目标是**安全实例的 home**（`<safeRoot>`）⇒ 调用期间用 `try/finally` 临时把 `BUTLER_DSH_HOME`
 *      指向 safeRoot，**用完必定还原**（跑完不残留 env，别的调用方不受影响）。
 */
export const INJECT_WAIT_MS_DEFAULT = 180_000

/** agent 提案的**读回兜底宽度**：抽不到就返回 null（**绝不编造提案**）。 */
function tryJsonDoc(raw) {
  try {
    const j = JSON.parse(raw)
    return j && typeof j === 'object' && !Array.isArray(j) ? raw : null
  } catch { return null }
}

/**
 * 从 agent 回复文本里抽提案 JSON（**纯函数**，可单测）。
 * 顺序：```json 围栏 → 任意 ``` 围栏 → 首个平衡 `{…}` 扫描。返回**原文 JSON 字符串**（可直接喂 validateProposal）。
 */
export function extractProposalFromText(text) {
  const s = String(text ?? '')
  if (!s.trim()) return null
  for (const m of s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const got = tryJsonDoc(m[1].trim())
    if (got) return got
  }
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue
    let depth = 0; let inStr = false; let esc = false
    for (let j = i; j < s.length; j++) {
      const ch = s[j]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') { inStr = true; continue }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) { const got = tryJsonDoc(s.slice(i, j + 1)); if (got) return got; break }
      }
    }
  }
  return null
}

/** 宽容地把 RPC 回执里所有字符串收集起来（`session.page` 的返回体形状随主包线演进，不写死 `messages[i].content.text`）。 */
function collectStrings(v, acc = [], depth = 0) {
  if (depth > 8 || acc.length > 4000) return acc
  if (typeof v === 'string') { acc.push(v); return acc }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, acc, depth + 1); return acc }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) collectStrings(v[k], acc, depth + 1); return acc }
  return acc
}

/** `session.page` 回执 → 可扫描文本（优先 assistant 文本，退化到全部字符串）。 */
export function textOfPageBody(body) {
  const value = body?.result?.value
  if (!value) return ''
  // 【2026-10-13 卡「愿景核查 V2 · 小护士 L1」】0.1.5 起 `session.page` 返回
  //   `{records:[{type:'event',event:{type,seq,time,data}}]}`（本卡实测 97 条），
  //   不再是 `{messages:[…]}` ⇒ 原实现恒抽不到文本（③ 注入即使投递成功也读不回提案）。
  //   assistant 正文位置 = `event.type==='assistant/message'` → `event.data.message.content[].text`。
  //   旧形状（messages）路径保留在下面：兼容旧主包与既有单测。
  const recs = Array.isArray(value.records) ? value.records : []
  if (recs.length) {
    const texts = []
    for (const r of recs) {
      const e = r?.event ?? r
      if (e?.type !== 'assistant/message') continue
      for (const c of (e.data?.message?.content ?? [])) {
        if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text)
      }
    }
    if (texts.length) return texts.join('\n')
  }
  const msgs = Array.isArray(value.messages) ? value.messages : []
  const assistant = msgs
    .filter((m) => m && (m.role === 'assistant' || m.author === 'assistant' || m.kind === 'assistant'))
    .flatMap((m) => collectStrings(m))
  if (assistant.length) return assistant.join('\n')
  return collectStrings(value).join('\n')
}

/** 组装给安全实例 agent 的修复任务 prompt（含提案 schema；纯函数，可单测）。 */
export function buildAgentTaskPrompt({ casePackDir, caseId, allowedOps = ALLOWED_OPS, maxActions = MAX_ACTIONS } = {}) {
  return [
    '你是小护士的**诊断 agent**（判断与动手分离：你只出提案，不执行）。',
    '',
    `现场包（只读）：${casePackDir || '(本 case 未采集现场包)'}`,
    `case：${caseId || '(未知)'}`,
    '',
    '任务：读现场包 → 给出**最小修复提案**。严格按下面 JSON 形状**只输出一个 ```json 代码块**，不要解释、不要调用任何写工具：',
    '```json',
    '{',
    '  "version": 1,',
    '  "diagnosis": "一句话说明你判断的故障点与依据（引用现场包里的文件名/行号）",',
    '  "actions": [',
    '    { "op": "write", "path": "\\\\absolute\\\\path", "content": "文件完整新内容", "reason": "为什么改这里" }',
    '  ]',
    '}',
    '```',
    '',
    `硬约束（越界即被白名单拒掉，整份提案作废）：`,
    `  · op 只能是 ${allowedOps.join(' / ')}（**没有 delete / rm**）；`,
    `  · path 必须是绝对路径，且只能落在「profile 四件套 / 自研插件声明 / _archive」这些允许写入面内；`,
    `  · 动作最多 ${maxActions} 条；无法给出可信提案时，输出 {"version":1,"diagnosis":"…","actions":[]} 并说明缺什么证据。`,
  ].join('\n')
}

/**
 * 读 `.credentials.yaml` 的 **refs 段键名**（DSH credentials service 存 API key 的地方）。
 * 【2026-10-12 V2.9收口·小护士接线】新增 —— 为什么单列一个读取器：
 *   refs 段的形状与 `records` **不同**（实测生产 `~/.dsh/.credentials.yaml`）：
 *     refs:
 *       {
 *         DEEPSEEK_API_KEY: sk-…        ← flow mapping、缩进 4、**带值**
 *       }
 *   而 `credentialKeysOf` 的正则是「缩进 2 + 行尾就是冒号（无值）」⇒ **匹配不到 refs 里的 key**
 *   ⇒ 若只看它，`llmCredential` 在"key 存在 refs 段"时**永远为假**（本卡实测踩到）。
 * 只读，**绝不返回值、绝不落日志**。
 */
export function refKeysOf(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const i = text.indexOf('\nrefs:')
    if (i < 0) return []
    const block = text.slice(i + 1)
    const end = block.indexOf('\nrecords:')
    const seg = end >= 0 ? block.slice(0, end) : block
    const keys = []
    for (const line of seg.split(/\r?\n/)) {
      const m = line.match(/^\s+([A-Za-z0-9_]+)\s*:\s*\S/)   // 有值 ⇒ 是 ref，不是子段名
      if (m && m[1] !== 'refs') keys.push(m[1])
    }
    return keys
  } catch { return [] }
}

/** 读 `.credentials.yaml` 的**顶层记录键名**（只读，绝不返回值、绝不落日志）。 */
export function credentialKeysOf(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    const names = []
    for (const line of lines) {
      const m = line.match(/^  ([A-Za-z0-9][\w\-/.]*):\s*$/)
      if (m) names.push(m[1])
    }
    return names
  } catch { return [] }
}

/**
 * 走 HTTP 注入修复任务并读回提案。
 * @returns {Promise<{ok:boolean, ...}>} 结构化读数（供 ③ 步记录、报告与单测断言）
 */
export async function injectViaAgent(o, deps, ctx = {}) {
  const baseUrl = ctx.baseUrl ?? `http://127.0.0.1:${o.port}`
  const rpc = deps.rpc ?? deps.hostRpc ?? hostRpc
  const credFile = path.join(o.safeRoot, '.credentials.yaml')
  const out = {
    baseUrl, credentialFile: credFile, credential: false, credentialKeys: [],
    llmCredential: false, refKeys: [], probe: null, promptBytes: 0, promptFile: null,
    injected: false, sessionId: null, waitedMs: 0, replyChars: 0, proposalRaw: null, error: null,
  }

  // 前置① 通道凭证（cookie 签名密钥）—— 缺 ⇒ 诚实失败（不伪造通道）
  out.credentialKeys = credentialKeysOf(credFile)
  out.credential = out.credentialKeys.includes('client-connection/browser-session')
  // 前置② LLM 凭证 —— 两个来源**任一命中**即算有（缺 ⇒ 通道通但 agent 跑不出提案）：
  //   ㈠ **refs 段有凭证**（当前 DSH 的真实形态：`dsh-llm-deepseek` 按 ref 从 credentials service 取 key）
  //   ㈡ records 段有**非 browser-session** 的顶层记录（历史判据，保留兼容旧形态）
  //   【2026-10-12】原判据只有 ㈡ ⇒ 在"key 存在 refs 段"时**永远判缺**（本卡实测：明明补好了 key 仍报缺）。
  out.refKeys = refKeysOf(credFile)
  out.llmCredential = out.refKeys.length > 0
    || out.credentialKeys.some((k) => k !== 'client-connection/browser-session')
  if (!deps.exists(credFile) || !out.credential) {
    out.error = `MISSING_CREDENTIAL：${credFile} ${deps.exists(credFile) ? '缺 client-connection/browser-session 记录' : '不存在'}`
      + '（隔离 home 没有通道凭证 ⇒ 注入必失败；见 docs\\小护士-P1-交付与验收-20260913.md）'
    return out
  }

  // 通道探活（只读；判据 = HTTP 达 + result.ok）
  // 【2026-10-13 · 卡「愿景核查 #20」】改道实现已抽去共用（`tools\lib\dsh-host-rpc.mjs#withDshHome`）：
  //   本处只留「单测注入了 rpc ⇒ 不碰 env」这条适配，**不再自带一份 try/finally**（两份必然分叉）。
  const withHome = async (fn) => ((deps.rpc || deps.hostRpc) ? fn() : withDshHome(o.safeRoot, fn))
  try {
    const r = await withHome(() => rpc(baseUrl, 'session.list', {}, { timeoutMs: 8000 }))
    out.probe = {
      status: r?.status ?? 0,
      ok: r?.body?.result?.ok === true,
      endpoint: r?.request ?? null,
      sessions: Array.isArray(r?.body?.result?.value?.sessions) ? r.body.result.value.sessions.length : null,
    }
  } catch (e) {
    out.probe = { status: 0, ok: false, endpoint: null, sessions: null, error: String(e && e.message ? e.message : e) }
  }

  // prompt 组装（落盘留证：跑没跑、投了什么，事后可对账）
  const prompt = buildAgentTaskPrompt({ casePackDir: ctx.casePackDir, caseId: ctx.caseId })
  out.promptBytes = Buffer.byteLength(prompt, 'utf8')
  if (ctx.dir) {
    try {
      const f = path.join(ctx.dir, 'inject-prompt.txt')
      fs.writeFileSync(f, prompt, 'utf8')
      out.promptFile = f
    } catch (e) { out.promptFile = `(落盘失败：${e && e.message})` }
  }

  // dry-run 档：预检到此为止（真投递 = 真跑 LLM = 烧 token）
  if (o.mode !== 'apply') {
    out.ok = out.probe.ok === true
    out.promptOnly = true
    return out
  }
  if (!out.probe?.ok) {
    out.error = `注入通道不可用：${baseUrl} 的 session.list 未返回 ok（status=${out.probe?.status}）—— 安全实例没起/端口不对/凭证不匹配`
    return out
  }
  if (!out.llmCredential) {
    out.error = `MISSING_LLM_CREDENTIAL：${credFile} 只有 client-connection/browser-session（通道密钥），没有 LLM 凭证`
      + ' ⇒ 通道通但 agent 跑不出提案（P1 实测同款）。补凭证 = 扩大凭证暴露面 ⇒ 须主人放行'
    return out
  }

  // ── 真投递（--apply）：create → prompt → 轮询 page 读回 ──
  const cwd = ctx.cwd ?? DSH_ROOT
  const sleep = deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)))
  try {
    const created = await withHome(() => rpc(baseUrl, 'session.create', { cwd }, { timeoutMs: 20_000 }))
    const sid = created?.body?.result?.value?.sessionId
    if (!sid) { out.error = `session.create 未返回 sessionId（status=${created?.status}）`; return out }
    out.sessionId = sid
    // 【2026-10-13 卡「愿景核查 V2 · 小护士 L1」】0.1.5 契约：SessionPromptRequest **必填 requestId**
    //   （客户端铸造的消息身份）。旧形状缺该字段会被 typert 边界校验拒成 `gateway/input-invalid`
    //   ⇒ ③ 注入 fail-closed 断链（本卡真跑首次复现）；对照 `tools\wake-smart.mjs:101-105`。
    const reqId = 'nurse-inject-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8)
    const sent = await withHome(() => rpc(baseUrl, 'session.prompt',
      { requestId: reqId, sessionId: sid, mode: 'queue', content: [{ type: 'text', text: prompt }] }, { timeoutMs: 30_000 }))
    if (sent?.body?.result?.ok !== true) {
      out.error = `session.prompt 未被接受（status=${sent?.status}）：${JSON.stringify(sent?.body?.result?.error ?? null).slice(0, 200)}`
      return out
    }
    out.injected = true
    const t0 = Date.now()
    const deadline = t0 + (Number.isFinite(o.injectWaitMs) ? o.injectWaitMs : INJECT_WAIT_MS_DEFAULT)
    while (Date.now() < deadline) {
      await sleep(Number.isFinite(o.injectPollMs) ? o.injectPollMs : 5000)
      // 【2026-10-13 卡「愿景核查 V2 · 小护士 L1」】`session.page` 入参 0.1.5 起为
      //   `{ address:{kind:'session',sessionId}, throughSeq, maxMessages }`；旧形状（`sessionId`+`beforeSeq`）
      //   被 typert 边界校验拒成 `gateway/input-invalid`（本卡实测）。`throughSeq` 必须 ≤ 当前 cursor
      //   ⇒ 先用必然越界的大数探一次，从错误 `past cursor N` 学回真 cursor 再取尾部
      //   （口径同 `tools\wecom-hub\lib\dispatch.mjs#pageTail`）。
      const page = await withHome(async () => {
        const call = (seq) => rpc(baseUrl, 'session.page',
          { address: { kind: 'session', sessionId: sid }, throughSeq: seq, maxMessages: 60 }, { timeoutMs: 15_000 })
        const first = await call(1_000_000_000)
        const m = String(first?.body?.result?.error?.message ?? '').match(/past cursor (\d+)/)
        return m ? await call(Number(m[1])) : first
      })
      const text = textOfPageBody(page?.body)
      out.waitedMs = Date.now() - t0
      out.replyChars = text.length
      const raw = extractProposalFromText(text)
      if (raw) { out.proposalRaw = raw; out.ok = true; return out }
    }
    out.error = `等待 agent 提案超时（${out.waitedMs}ms · 读回 ${out.replyChars} 字符、未抽到提案 JSON）⇒ fail-closed（不执行任何动作）`
    return out
  } catch (e) {
    out.error = `注入通道异常：${e && e.message ? e.message : e}`
    return out
  }
}

/** G8 留痕：审计一行（失败不阻断）。deps.audit 可注入（单测零副作用）。 */
async function leaveTrace(deps, entry) {
  const fn = deps.audit ?? ((e) => bridge.auditNurse(e))
  try { return await fn({ kind: 'nurse', ...entry }) } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
}

/** G8 告警：写 butler-alert.log + stderr（失败不阻断）。 */
async function raiseAlert(deps, entry) {
  const fn = deps.alert ?? ((e) => bridge.alertNurse(e))
  try { return await fn({ kind: 'nurse', ...entry }) } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
}

/**
 * ①.6「修复窗口静默」的**跳过文案三态**（纯函数，可单测）。
 *
 * 【2026-10-13 · 卡「愿景核查 #21」】旧实现把几种互不相干的情形挤进一个三元：
 *   `o.mode === 'apply' ? (o.auto ? '（--auto 采证档…）' : '（未找到 dsh-upgrade-silence.mjs，跳过）') : '（dry-run 跳过）'`
 *   ⇒ 传 `--no-silence`（**主动关**）时打的也是"未找到 …，跳过" ⇒ 排障会误判成"脚本丢了"
 *   （V2 报告 §7 缺口 3）。现在三态各说各话：**主动关 ≠ 脚本缺失 ≠ 正常**。
 *
 * @param {{mode?:string, auto?:boolean, silence?:boolean}} o 编排器选项
 * @param {boolean} scriptExists `tools\dsh-upgrade-silence.mjs` 是否存在
 * @returns {string} 该写进 ①.6 步骤明细的文案
 */
export function silenceSkipNote(o = {}, scriptExists = false) {
  if (o.mode !== 'apply') return '（dry-run 跳过）'
  if (o.auto) return '（--auto 采证档：不做修复动作，无需静默）'
  if (o.silence === false) return '（--no-silence：**主动跳过**静默窗 —— 非脚本缺失）'
  if (!scriptExists) return `（未找到 ${path.join(DSH_ROOT, 'tools', 'dsh-upgrade-silence.mjs')}，跳过）`
  // 兜底：apply ∧ silence!==false ∧ 脚本在 ∧ 非 --auto ⇒ 本就该走上面 if 分支，这里理论上不可达
  return '（静默窗未跳过 —— 与 ①.6 判据不一致，请核对）'
}

/** 主流程（deps 可注入；返回 {ok, caseId, steps, artifacts, state}） */
export async function runOrchestration(o, deps = realDeps) {
  const steps = []
  const record = (name, ok, detail = '') => { steps.push({ name, ok, detail }); return ok }

  // ⓪.4 【P2-B · G15/B4】**残留收敛** —— 「开工前先判**上一次**的残留」。
  //   为什么排在 ⓪ bootstrap **之前**：bootstrap 会因"未收尾的半完成 case"**拒启**，而"护士被强杀"
  //   恰恰最容易留下半完成 case ＋ 两件拦阻物（`takeover.json` 拦守护鱼 / 静默窗 holder 拦 tickd）
  //   —— 排在它后面 = **最需要收敛的那个场景轮不到收敛**。
  //   判据与执行**全在** `tools\dsh-butler\lib\residue-reaper.mjs`（三层挂点①②③共用同一份，
  //   **不在这里写第二套 if**）；本处只做三件事：注入告警通道 + 记 step + 落审计。
  //   dry-run 档 ⇒ `observeOnly`（只报告不写），与既有"判据只拦真动手"口径一致。
  //   失败**不阻断**本次修复（照 §6 fail 策略：采集/收敛失败 fail-open），但**必须可见**（step 红 + 告警）。
  let residue = null
  try {
    const RR = await import(pathToFileURL(RESIDUE_REAPER_PATH).href)
    residue = await RR.reapResidue({
      safeRoot: o.safeRoot,
      home: o.home ?? null,
      stateDir: deps.residueStateDir ?? null,
      observeOnly: o.mode !== 'apply',
      label: `nurse-orchestrate:${o.mode}`,
      deps: {
        alert: (e) => raiseAlert(deps, e),
        ...(deps.residueDeps ?? {}),
      },
    })
    const c = residue.plan.counts
    const bad = (residue.result?.failed ?? []).length
    record('⓪.4 残留收敛（G15/B4）', bad === 0, c.total === 0
      ? '无超期残留（上一次护士没留尾巴）'
      : `发现 ${c.total} 件超期残留 ⇒ ${o.mode === 'apply' ? '真释放' : '只报告（dry-run）'} ${residue.result?.released?.length ?? 0} 件`
        + `${c.skipLive ? ` · 保守跳过 ${c.skipLive} 件（pid 疑似存活）` : ''}`
        + `${bad ? ` · ${bad} 件失败` : ''}`)
    if (c.total > 0) {
      await leaveTrace(deps, {
        event: 'nurse-residue-reap', stage: 'residue', caseId: o.caseId ?? null, mode: o.mode,
        counts: c, released: residue.result?.released ?? [], failed: residue.result?.failed ?? [],
        observeOnly: o.mode !== 'apply', recordFile: residue.recordFile,
      })
    }
  } catch (e) {
    const why = e && e.message ? e.message : String(e)
    record('⓪.4 残留收敛（G15/B4）', false, `收敛不可用（**不阻断**本次修复，但须可见）：${why}`)
    await raiseAlert(deps, {
      level: 'warn', message: `残留收敛不可用（不阻断本次修复）：${why}`,
      detail: { mode: o.mode, safeRoot: o.safeRoot, hint: '超期 takeover.json / 静默窗 holder 可能仍在 ⇒ 查 tools\\dsh-butler\\lib\\residue-reaper.mjs' },
    })
  }

  // ⓪
  const boot = bootstrapCheck(o, deps)
  if (!record('⓪ bootstrap 检查', boot.ok, boot.ok ? `profile ok · 无半完成 case` : boot.problems.join(' | '))) {
    return { ok: false, stage: 'bootstrap', steps, problems: boot.problems }
  }

  // ⓪.5 【卡 ③-5 · 闸 2】跨线判据（R8 单写者让路）—— apply 模式 + owner==='upgrade' ⇒ 拒启（exit 3）
  //   判据=唯一源 lane-gate.mjs（与守护鱼闸门同一份）；判据不可用走同一 fail-safe（保守拒启）。
  //   ⚠️ dry-run 档**仍可跑**：判据只拦"真动手"，不拦"只报告"。
  const laneGate = await judgeNurseLane(deps, { home: o.home ?? null })
  record('⓪.5 跨线判据（R8 让路）', !laneGate.blocked,
    laneGate.blocked ? `${laneGate.code}：${laneGate.reason}` : laneGate.reason)
  if (laneGate.blocked) {
    if (o.mode === 'apply') {
      return {
        ok: false, stage: 'lane-gate', laneGate, steps,
        problems: [`升级锁持有中/判据不可用 —— 先处置升级：${laneGate.reason}`],
      }
    }
    record('⓪.5 dry-run 档仍可跑（判据只拦真动手）', true, laneGate.reason)
  }

  // ⓪.7 【P2-A · G7】降档闸（D3=A 落地：「degraded 期间**不自动起**小护士」）—— **起安全实例之前**判一次。
  //   判据唯一源 = `lib\autonomy-state.mjs` 的 checkAutonomyAllowed（与 repair L2 / butler runAction 同一份；
  //   **本文件不写第二套判定**，只做动态 import 薄壳 + 判据不可用时同一 fail-safe）。
  //   · degraded / 判据不可用 ⇒ 不自动起：apply 档 **拒启**（exit 3）；dry-run 档只报告（不拦"只报告"）。
  //   · `--allow-degraded` = 显式声明"人工触发"（autonomy-state 原文：人工入口不受降档影响）
  //     ⇒ 放行但**必须留痕**（审计 nurse-degrade-override + 告警），绝不静默。
  const degradeGate = await judgeNurseDegrade(deps, { kind: 'nurse-start' })
  const degradeAllowed = degradeGate.allowed === true || o.allowDegraded === true
  record('⓪.7 降档闸（G7 · 起实例前）', degradeAllowed,
    `level=${degradeGate.level}${degradeGate.allowed ? '：放行（自主动作按各自护栏）' : `：拒动 —— ${degradeGate.reason}`}`
    + `${!degradeGate.allowed && o.allowDegraded ? '｜--allow-degraded 人工放行' : ''}`)
  if (!degradeAllowed) {
    await leaveTrace(deps, {
      event: 'nurse-degrade-blocked', stage: 'degrade-gate', caseId: o.caseId ?? null, mode: o.mode,
      level: degradeGate.level, reason: degradeGate.reason, hint: degradeGate.hint, judgeUnavailable: degradeGate.judgeUnavailable === true,
    })
    await raiseAlert(deps, {
      level: 'warn', message: `降档态：小护士不自动起（G7）—— ${degradeGate.reason}`,
      detail: { level: degradeGate.level, hint: degradeGate.hint, mode: o.mode, file: degradeGate.file },
    })
    if (o.mode === 'apply') {
      return {
        ok: false, stage: 'degrade-gate', degrade: degradeGate, steps,
        problems: [`降档态（${degradeGate.level}）：不自动起小护士 —— ${degradeGate.reason}（人工触发请显式加 --allow-degraded）`],
      }
    }
    record('⓪.7 dry-run 档照跑（降档只拦真动手）', true, degradeGate.reason)
  } else if (!degradeGate.allowed && o.allowDegraded) {
    await leaveTrace(deps, {
      event: 'nurse-degrade-override', stage: 'degrade-gate', caseId: o.caseId ?? null, mode: o.mode,
      level: degradeGate.level, reason: degradeGate.reason, by: 'cli:--allow-degraded',
      note: '人工触发显式放行（autonomy-state 语义：人工入口不受降档影响）',
    })
    await raiseAlert(deps, {
      level: 'info', message: `降档态放行（人工触发 --allow-degraded）：${degradeGate.reason}`,
      detail: { level: degradeGate.level, mode: o.mode },
    })
  }

  const caseId = o.caseId || newCaseId(deps.now())
  const dir = caseDir(o.safeRoot, caseId)
  const sp = statePath(o.safeRoot, caseId)
  let state = newState(caseId, { maxRounds: o.budgetRounds, budgetMs: o.budgetMin * 60 * 1000, maxTokens: o.budgetTokens, now: deps.now() })
  // G7 留痕：降档判定结果贯穿 case（报告 / 审计 / 面板都能答"这轮是不是降档态"）
  state.autonomy = { startGate: degradeGate, l2Gate: null, allowDegraded: o.allowDegraded === true }
  if (!o.dryRun) fs.mkdirSync(dir, { recursive: true })
  writeStateAtomic(sp, state)
  record('⓪ 建 case', true, `${caseId} → ${dir}`)
  await leaveTrace(deps, { event: 'nurse-case-start', caseId, mode: o.mode, safeRoot: o.safeRoot, port: o.port, proposal: o.proposal ?? null, degradeLevel: degradeGate.level })

  const isDry = o.mode === 'dry-run'

  // ① 采集现场包
  let casePackDir = null
  if (o.mode === 'apply') {
    const r = deps.cli(path.join(NURSE_DIR, 'collect-case.mjs'), [])
    casePackDir = (r.out.match(/case-\d{8,}-\w+/) || [null])[0]
    record('① 采集现场包（只读+脱敏）', r.code === 0, r.code === 0 ? `case=${casePackDir}` : r.out.slice(-200))
    state.artifacts.casePack = casePackDir
    state = setPhase(sp, state, 'collecting', { artifacts: state.artifacts })
  } else record('① 采集现场包', true, '（dry-run 跳过）')

  // ①.5 接管声明（guard 侧读取已接线 —— 卡 ③-5）
  //   ⚠️ `--auto` 档**不写**：它不做任何修复动作，写了反而会白拦守护鱼接管 30 分钟（TTL）。
  const takeoverFile = path.join(dir, 'takeover.json')
  if (o.mode === 'apply' && !o.auto) {
    fs.writeFileSync(takeoverFile, JSON.stringify({
      caseId, pid: process.pid, at: deps.now().toISOString(),
      note: '编排器接管声明：修复窗口内 guard 不应再拉起生产。✅ guard 侧读取已接线（卡 ③-5 · 2026-09-20）：guard.mjs 每轮读 <safeRoot>\\case-*\\takeover.json（safeRoot 默认 ~/.dsh-safe，可用 DSH_NURSE_SAFE_ROOT 覆盖），在场即走「不接管」闸（不唤醒/不拉起/不改相位/不清零计数）；超 TTL 30 分钟视为残留不再拦截（G15/B4 收紧：原 2h ⇒ 30min；此处写的是**声明内容**，判据真源 = tools\\dsh-butler\\lib\\lane-gate.mjs 的 TAKEOVER_TTL_MS），被强杀留下的这份残留由 residue-reaper.mjs 三层挂点收敛。',
    }, null, 2), 'utf8')
    record('①.5 接管声明', true, `${takeoverFile}（guard 侧已接线：修复窗口内 guard 只探活）`)
    state = setPhase(sp, state, 'taking-over', { takeover: { file: takeoverFile, pid: process.pid } })
  } else record('①.5 接管声明', true, '（dry-run 跳过）')

  // ①.6 修复窗口静默（D4=A）
  const silenceScript = path.join(DSH_ROOT, 'tools', 'dsh-upgrade-silence.mjs')
  let silenceWarn = null
  if (o.mode === 'apply' && o.silence !== false && deps.exists(silenceScript) && !o.auto) {
    // holder 口径（卡 ③-4 · 方案 §3.5(c)）：护士 = `nurse-<caseId>` —— 升级链那边同时开窗时，
    // 谁先释放都不会误开对方的窗（v2 引用计数）。失败仍不阻断（护士不能因为静默失败就不修）。
    const r = deps.cli(silenceScript, ['--disable', '--holder', `nurse-${caseId}`, '--reason', 'nurse-repair'])
    if (r.code !== 0) silenceWarn = `静默窗关闭失败（不阻断，但后台调度可能在修复期动工作区）：${r.out.slice(-160)}`
    record('①.6 修复窗口静默（tickd）', r.code === 0, r.code === 0 ? '--disable 已生效' : silenceWarn)
    state = setPhase(sp, state, 'silencing', { silence: { wasDisabled: r.code === 0, warn: silenceWarn } })
  } else record('①.6 修复窗口静默', true, silenceSkipNote(o, deps.exists(silenceScript)))

  // ② 起安全实例
  let instance = null
  let outcome = { ok: true, stage: 'done' }
  try {
    if (o.mode === 'apply' && o.instance) {
      if (o.port === 3080) throw new Error('拒绝使用生产端口 3080')
      const sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)))
      // 就绪等待：DSH 首启要几秒才 HTTP 应答（有限次等待 ≠ 循环重试：到点即失败冻结）。
      // 【卡 S12】"就绪"= 判活（2xx/3xx/401/403），不再是"必须 200" —— 见 guard-http.mjs。
      const waitReady = async (tries = 12, gapMs = 2000) => {
        let last = { ok: false, status: 0 }
        for (let i = 0; i < tries; i++) {
          last = await deps.probe(`http://127.0.0.1:${o.port}/`)
          if (last.ok) return last
          await sleep(gapMs)
        }
        return last
      }
      const r = deps.cli(path.join(NURSE_DIR, 'nurse-ctl.mjs'), ['start', '--port', String(o.port)])
      let probe
      let how
      if (r.code === 0) {
        probe = await waitReady()
        how = `nurse-ctl start 成功 · 就绪探活 ${probe.status}`
      } else {
        // 起失败：先判别是不是「已有健康实例」（EADDRINUSE + 探活判活 = 复用，不算失败）
        probe = await waitReady(2, 1000)
        if (!probe.ok) {
          record('② 起安全实例', false, `nurse-ctl start 失败（exit ${r.code}）：${r.out.slice(-200)}`)
          throw new Error('安全实例起不来（三层兜底：报告 + 冻结现场，不循环重试）')
        }
        how = `复用已在运行的安全实例（start 报：${String(r.out.split('\n')[0]).slice(0, 70)}）`
      }
      instance = { port: o.port, ok: probe.ok, status: probe.status, reused: r.code !== 0 }
      record('② 起安全实例', probe.ok, `http://127.0.0.1:${o.port}/ → ${probe.status}${probe.reason ? ` (${probe.reason})` : ''} · ${how}`)
      state = setPhase(sp, state, 'starting', { instance })
    } else record('② 起安全实例', true, o.mode === 'apply' ? '（--no-instance，跳过）' : '（dry-run 跳过）')

    // ③ 注入 / 取提案
    // 【P2-B · 自动触发档 `--auto`】由守护鱼崩溃链触发的**采证档**：⓪.4 收敛 + 采集现场包 + 报告/通知，
    //   **零修复动作**（不写接管声明、不动静默窗、不起实例、不读提案、不执行、不验收）。
    //   为什么必须有这个档：编排器的修复入口是 `--proposal`（结构化提案，D1=A 判断与动手分离），
    //   而崩溃链自动触发时**没有提案**（`--inject llm` 未接线，P1 实测 headless 报 MISSING_CREDENTIAL）
    //   ⇒ 直接 `--apply` 必然在 ③ 抛错冻结（那不是"自动修"，是"自动失败"）。
    //   ⇒ 自动触发的正确形态 = **把护士叫醒去采证 + 叫人**；修不修由主人/主会话给提案后再跑 `--apply`。
    if (o.auto) {
      record('③④⑤ 自动触发档（--auto）', true,
        '只采证不修：跳过 接管声明 / 静默窗 / 起实例 / 提案 / 执行 / 验收（判断与动手分离 D1=A；要修请跑 --apply --proposal <file>）')
      outcome = { ok: true, stage: 'collect-only' }
    } else {
    let proposalRaw = null
    if (o.inject === 'llm') {
      // 【2026-10-10 · 卡「补P域余」接线】agent 提案通道（HTTP）：注入 → 读回 → 仍过 ④ 白名单。
      //   dry-run 档 = **预检档**（凭证 + 通道探活 + prompt 组装，**不真投递**）；apply 档 = 真投递（烧 token）。
      //   ⚠️ dry-run 档拿不到提案**不算失败**（本档只报告）；apply 档拿不到 ⇒ fail-closed 抛错（不执行任何动作）。
      const inj = await injectViaAgent(o, deps, { caseId, dir, casePackDir })
      record('③ 注入档位', true, o.mode === 'apply'
        ? 'HTTP 真投递（agent 出提案 → 过 ④ 白名单才执行）'
        : 'dry-run **预检档**：只做 凭证检查 + 通道探活 + prompt 组装；**不真投递**（真投递 = 真跑 LLM = 烧 token ⇒ 属乙档，须主人放行）')
      const detail = `home=${o.safeRoot} · 通道凭证=${inj.credential ? 'ok' : '缺'}（LLM 凭证=${inj.llmCredential ? 'ok' : '缺'}）`
        + ` · 通道 ${inj.baseUrl} status=${inj.probe?.status ?? 0}${inj.probe?.ok ? '（活）' : '（不可用）'}`
        + ` · prompt ${inj.promptBytes} 字节${inj.promptFile ? ` → ${inj.promptFile}` : ''}`
        + (inj.injected ? ` · 已投递 session=${inj.sessionId} 等 ${inj.waitedMs}ms 读回 ${inj.replyChars} 字符` : '')
      proposalRaw = inj.proposalRaw ?? null
      const injArtifact = { ...inj, proposalRaw: undefined }
      record('③ 注入修复任务（agent）', !!proposalRaw || o.mode !== 'apply', proposalRaw
        ? `${detail} · **已抽到提案**（${Buffer.byteLength(proposalRaw, 'utf8')} 字节）`
        : `${detail} · ${inj.error ?? '预检完成（dry-run 未真投递 ⇒ 无提案不是失败）'}`)
      state = setPhase(sp, state, 'injecting', { artifacts: { ...state.artifacts, inject: injArtifact } })
      await leaveTrace(deps, {
        event: 'nurse-inject-agent', caseId, mode: o.mode, port: o.port, credential: inj.credential,
        llmCredential: inj.llmCredential, probe: inj.probe, promptBytes: inj.promptBytes,
        injected: inj.injected, sessionId: inj.sessionId, gotProposal: !!proposalRaw, error: inj.error,
      })
      if (!proposalRaw && o.mode === 'apply') {
        throw new Error(inj.error ?? '--inject llm 未拿到提案（fail-closed：不执行任何动作）')
      }
    } else {
      if (!o.proposal) throw new Error('缺少 --proposal <提案 JSON>（结构化提案是唯一入口；agent 不直接写生产）')
      proposalRaw = fs.readFileSync(o.proposal, 'utf8')
      record('③ 取提案（离线）', true, `${o.proposal}（${Buffer.byteLength(proposalRaw, 'utf8')} 字节）`)
      state = setPhase(sp, state, 'injecting', { artifacts: { ...state.artifacts, proposalFile: o.proposal } })
    }

    if (!proposalRaw) {
      record('④⑤ 跳过（本次没拿到提案 ⇒ 无事可做）', true,
        o.mode === 'apply' ? '（apply 档不会走到这里：上游已 fail-closed）' : 'dry-run 预检档：不落盘、不执行、不验收')
      outcome = { ok: true, stage: 'inject-preflight' }
    }
    if (proposalRaw) {
    // ④ 校验提案（fail-closed）
    // ⚠️ 允许根可注入（deps.allowedRoots）：单测必须把"生产面"指到沙箱，否则会去校真实 <DSH_ROOT> 路径
    const v = validateProposal(proposalRaw, deps.allowedRoots ? { roots: deps.allowedRoots } : {})
    const detail = v.ok
      ? `${v.actions.length} 条动作全部过白名单`
      : `${(v.rejected || []).length} 条被拒：${(v.rejected || []).slice(0, 2).map((x) => x.reason).join(' ; ')}`
    record('④ 提案校验（G1 白名单 · fail-closed）', v.ok, detail)
    state = setPhase(sp, state, 'validating', { artifacts: { ...state.artifacts, rejected: (v.rejected || []).map((x) => x.reason) } })
    await leaveTrace(deps, {
      event: v.ok ? 'nurse-proposal-pass' : 'nurse-proposal-reject', caseId, verdict: v.verdict,
      actions: v.actions.length, rejected: (v.rejected || []).map((x) => x.reason).slice(0, 5),
    })
    if (!v.ok) throw new Error(`提案被拒（fail-closed，不执行任何动作）：${v.reason}`)

    // ④.5 预算闸
    const bud = checkBudget(state, deps.now())
    const bump = bumpRound(sp, state)
    state = bump
    record('④.5 预算闸', bud.ok, bud.ok ? `剩余轮次 ${bud.remainingRounds} · 截止 ${bud.deadlineAt} · 剩余 token ${bud.remainingTokens ?? '—'}` : bud.reason)
    if (!bud.ok) throw new Error(bud.reason)

    // ④.7 【P2-A · G7】降档闸（**执行 L2 动作之前**再判一次）：degraded ⇒ **拒动**
    //   为什么两处都判：⓪.7 到 ④ 之间要经过采集 / 接管 / 静默 / 起实例 / 提案校验（分钟级），
    //   期间降档态可能被人/别的组件切过去（"动手前最后一判"才是真闸）；两处共用同一判据源。
    const l2Gate = await judgeNurseDegrade(deps, { kind: 'nurse-l2-action' })
    const l2Allowed = l2Gate.allowed === true || o.allowDegraded === true
    record('④.7 降档闸（G7 · 执行 L2 前）', l2Allowed,
      `level=${l2Gate.level}${l2Gate.allowed ? '：放行' : `：拒动 —— ${l2Gate.reason}`}${!l2Gate.allowed && o.allowDegraded ? '｜--allow-degraded 人工放行' : ''}`)
    state.autonomy = { ...(state.autonomy || {}), l2Gate }
    writeStateAtomic(sp, state)
    if (!l2Allowed) {
      // ⚠️ dry-run 档**不拦**（降档只拦"真动手"；dry-run 的 executeProposal 本身就不落盘）
      if (!isDry) {
        await leaveTrace(deps, {
          event: 'nurse-l2-blocked', stage: 'degrade-gate-l2', caseId, mode: o.mode,
          level: l2Gate.level, reason: l2Gate.reason, planned: v.actions.length, allowDegraded: o.allowDegraded === true,
        })
        await raiseAlert(deps, {
          level: 'warn', message: `降档态：小护士拒绝执行 L2 动作（G7）—— ${l2Gate.reason}`,
          detail: { caseId, level: l2Gate.level, plannedActions: v.actions.length, hint: l2Gate.hint },
        })
        throw new Error(`降档态（${l2Gate.level}）：拒绝执行 L2 动作 —— ${l2Gate.reason}（fail-closed：一条动作都没执行）`)
      }
      record('④.7 降档拒动（dry-run 档只报告，不落盘即不拦）', true, l2Gate.reason)
    }

    // ④.8 【C-G10 · 2026-10-14 · V2.9封口①类 · P域 L918】**冒烟前置** —— 「上生产前过测试环境冒烟」。
    //   缺口原话（主档 §1 P 域 L918）：冒烟脚本在位（产物 √）＋ 护士线**零调用点**（✗）＋ 无痕迹（✗）
    //     ⇒ 三件缺二、装好零使用；本处补的就是那个「调用点」。
    //   方案 §5 G10 原文：「小护士上线前，其安全实例必须过 `dsh-test-smoke.mjs` 同款四项检查；
    //     测试环境不在线时走『零依赖沙箱演练』路径并**如实标注**，不许假装过」⇒ 本闸 **fail-closed**：
    //     `fail`（跑起来但没过）与 `unavailable`（脚本不在位 / 超时 / 起不来）**都拦**；人工要走沙箱路径
    //     必须显式 `--allow-smoke-skip`（照 ⓪.7 的 `--allow-degraded` 同款：放行但**必须留痕 + 出告警**）。
    //   位置理由：紧贴 ④ 执行之前 = 「上生产前」的最后一道闸；与 ④.7 同款——**只拦真动手**，
    //     dry-run 档只报告（它本来就不落盘）。
    //   判据/开关/命令组装全在 `lib\smoke-gate.mjs`（**本文件不写第二套 if**）；本处只做：调一次 + 记 step + 留痕。
    const smokeSw = smokeGate.smokeEnabled({ env: process.env, opts: o })
    if (isDry) {
      record('④.8 冒烟前置（C-G10）', true, '（dry-run 档不落盘即不拦：只报告，与 ④.7 同款口径）')
    } else if (smokeSw.enabled !== true) {
      record('④.8 冒烟前置（C-G10）', true, `（已关回：${smokeSw.why}）`)
      await leaveTrace(deps, { event: 'nurse-smoke-gate', caseId, mode: o.mode, verdict: 'disabled', pass: true, why: smokeSw.why })
    } else {
      const smokeScript = o.smokeScript || smokeGate.SMOKE_SCRIPT_DEFAULT
      const smokePort = o.smokePort ?? smokeGate.SMOKE_PORT_DEFAULT
      const smokeTimeoutMs = o.smokeTimeoutMs ?? smokeGate.SMOKE_TIMEOUT_MS_DEFAULT
      const smokeArgs = smokeGate.buildSmokeArgs({ port: smokePort })
      let smokeRaw
      if (!smokeArgs.ok) smokeRaw = { portInvalid: smokeArgs.reason }
      else if (!deps.exists(smokeScript)) smokeRaw = { notFound: true, code: null, out: `冒烟脚本不在位：${smokeScript}` }
      else {
        try { smokeRaw = await deps.smoke(smokeScript, smokeArgs.args, { timeoutMs: smokeTimeoutMs }) }
        catch (e) { smokeRaw = { code: null, out: '', error: String((e && e.message) || e) } }
      }
      const smokeVerdict = smokeGate.interpretSmokeResult(smokeRaw)
      const smokeTail = smokeGate.outputTail(smokeRaw && smokeRaw.out)
      record('④.8 冒烟前置（C-G10）', smokeVerdict.pass,
        smokeGate.smokeStepDetail({ verdict: smokeVerdict, script: smokeScript, port: smokePort, code: smokeVerdict.code })
        + (smokeTail ? `｜输出尾巴：${smokeTail.replace(/\s+/g, ' ').slice(-260)}` : ''))
      await leaveTrace(deps, {
        event: 'nurse-smoke-gate', caseId, mode: o.mode,
        verdict: smokeVerdict.verdict, pass: smokeVerdict.pass, reason: smokeVerdict.reason,
        script: smokeScript, port: smokePort, timeoutMs: smokeTimeoutMs, exitCode: smokeVerdict.code, outputTail: smokeTail,
      })
      if (!smokeVerdict.pass) {
        if (o.allowSmokeSkip === true) {
          record('④.8 冒烟未过 · 人工显式放行（--allow-smoke-skip · C-G10 零依赖沙箱路径）', true,
            `${smokeVerdict.reason}｜⚠️ 已按方案 §5 G10「如实标注」：本次结论**不含**冒烟通过证据`)
          await raiseAlert(deps, {
            level: 'warn', message: `小护士冒烟未过但被人工显式放行（--allow-smoke-skip）：${smokeVerdict.reason}`,
            detail: { caseId, script: smokeScript, port: smokePort, exitCode: smokeVerdict.code, hint: '方案 §5 G10「零依赖沙箱演练」路径 —— 报告里须如实标注' },
          })
        } else {
          await raiseAlert(deps, {
            level: 'error',
            message: `冒烟前置未过：小护士拒绝执行 L2 动作（C-G10）—— ${smokeVerdict.reason}`,
            detail: { caseId, script: smokeScript, port: smokePort, exitCode: smokeVerdict.code, plannedActions: v.actions.length, outputTail: smokeTail },
          })
          const smokeErr = new Error(`冒烟前置未过（C-G10）：${smokeVerdict.reason}（fail-closed：一条动作都没执行）`)
          smokeErr.stage = 'smoke-gate'
          throw smokeErr
        }
      }
    }

    // ④ 执行（写前备份；dry-run 不落盘）
    // ⚠️ archiveRoot 走 deps 注入：单测必须把归档根指到临时目录（**绝不允许测试写生产 _archive**）
    const archiveRoot = deps.archiveRoot || path.join(DSH_ROOT, '_archive')
    const ex = executeProposal(v, { archiveRoot, dryRun: isDry, now: deps.now() })
    record('④ 执行（写前备份 G4）', ex.ok, `${isDry ? '[dry-run] ' : ''}applied=${ex.applied.length} backups=${ex.backups.length}${ex.failed.length ? ` failed=${ex.failed.length}` : ''}`)
    state = setPhase(sp, state, 'executing', { artifacts: { ...state.artifacts, applied: ex.applied.map((a) => a.path), backups: ex.backups.map((b) => b.backup), archive: ex.caseDir } })
    await leaveTrace(deps, {
      event: 'nurse-l2-executed', caseId, dryRun: isDry, ok: ex.ok,
      applied: ex.applied.map((a) => a.path), backups: ex.backups.map((b) => b.backup),
      failed: ex.failed.map((f) => ({ path: f.path, error: f.error })),
    })
    // 【P2-A · G8】proposal-guard 产出的逐条动作审计（它保持纯执行器，写口统一在这里）
    for (const ae of ex.auditEntries || []) await leaveTrace(deps, { ...ae, caseId })

    // ⑤ 验收：生产能否起来
    // 【卡 S14】`deps.probe` 默认带 cookie ⇒ 拿到的是**真页面**（含 `__DSH_BOOT__`）。
    //   判据**不放松**：仍是「判活 ∧ 真页面里有 boot 载荷」两条都成立才算过（不看 `prod.ok` 就放过）。
    const prod = await deps.probe(PROD_URL)
    const bootOk = prod.ok && /__DSH_BOOT__/.test(prod.text || '')
    record('⑤ 验收（生产 HTTP 判活 + boot 载荷）', bootOk || isDry,
      isDry ? '[dry-run] 跳过真实验收（不计入结论）'
        : `status=${prod.status}${prod.reason ? ` (${prod.reason})` : ''} · 判活=${prod.ok}（口径 ${prod.rule ?? RULE_VERSION}）· boot=${bootOk}`)
    state = setPhase(sp, state, 'verifying', { artifacts: { ...state.artifacts, verify: { status: prod.status, boot: bootOk } } })

    if (!isDry && !bootOk) {
      const err = new Error('REPAIR_FAILED：生产验收未通过（HTTP 判活 + boot 载荷 未满足）→ 冻结现场 + 报告，禁循环重试（G6）')
      err.stage = 'verify'
      throw err
    }
    }
    }
  } catch (e) {
    const stage = (e && e.stage) || 'run'
    state = setPhase(sp, state, 'failed', { errors: [...(state.errors || []), String(e && e.message)] })
    record('流程中断', false, String(e && e.message))
    outcome = { ok: false, stage, error: String(e && e.message) }
  }

  // ⑤.5 收尾（**失败路径也必须执行**：不留"静默窗开着 + 实例挂着 + 接管标记还在"的现场）
  //   ⚠️ `--auto` 档跳过：它没写接管声明、没动静默窗、没起实例 ⇒ 无物可收。
  let closeOk = true
  if (o.mode === 'apply' && !o.auto) {
    if (o.silence !== false && deps.exists(silenceScript)) {
      const r = deps.cli(silenceScript, ['--enable', '--holder', `nurse-${caseId}`, '--reason', 'nurse-repair-done'])
      closeOk = closeOk && r.code === 0
      record('⑤.5 恢复静默窗', r.code === 0, r.code === 0 ? '--enable 已执行' : `失败：${r.out.slice(-120)}`)
    }
    try { if (fs.existsSync(takeoverFile)) fs.rmSync(takeoverFile, { force: true }); record('⑤.5 解除接管声明', true, takeoverFile) }
    catch (e) { closeOk = false; record('⑤.5 解除接管声明', false, String(e && e.message)) }
    if (o.instance) {
      const r = deps.cli(path.join(NURSE_DIR, 'nurse-ctl.mjs'), ['stop', '--port', String(o.port)])
      closeOk = closeOk && r.code === 0
      record('⑤.5 关安全实例', r.code === 0, `nurse-ctl stop → exit ${r.code}`)
    }
  } else record('⑤.5 收尾', true, o.auto ? '（--auto 采证档：无生产动作，无需收尾）' : '（dry-run 无需收尾）')
  if (state && !TERMINAL_PHASES.includes(state.phase)) state = setPhase(sp, state, 'done', {})

  // ⑥ 【P2-A · G8】写报告 + 审计 + 通知 —— **成功与失败都要叫人**（修订 I7 前这一路全 0 命中）
  const okFinal = outcome.ok && closeOk
  const endedAt = deps.now().toISOString()
  const durationMs = Number.isFinite(state?.sli?.durationMs)
    ? state.sli.durationMs
    : Math.max(0, new Date(endedAt).getTime() - new Date(state.startedAt).getTime())
  const notes = []
  if (!okFinal) notes.push(`未完成（stage=${outcome.stage ?? 'run'}）：${outcome.error ?? '收尾未通过'}`)
  if (state?.autonomy?.startGate && state.autonomy.startGate.allowed !== true) {
    notes.push(`降档态=${state.autonomy.startGate.level}${o.allowDegraded ? '（人工放行 --allow-degraded）' : ''}`)
  }
  if (silenceWarn) notes.push(`收尾告警：${silenceWarn}`)
  notes.push('回滚来源：写前备份在 `_archive\\nurse-case-*\\before\\`（G4；同路径拷回即回到修复前）')
  // ⑥a 【C-V8 · 2026-10-10 · 卡 cf217275】**知识库写入侧** —— 护士修完一场要沉淀。
  //   缺口原话：报告在（本函数下面那步），但 `~/.dsh/repair-knowledge` 在本线**只有采集侧**
  //     （`collect-case.mjs` 读进去当现场证据）⇒ 修完什么都不留，方案 §8 P3「知识库复用」单向只读。
  //   放这条位置的理由：必须在 `reportPayload` 之前 —— 这样"知识库写入"本身也是一条 step，
  //     会出现在同一份报告里（可对账：报告说有，库里就该有）。
  //   边界（刻意收窄，防噪声）：**只在 `--apply` 真跑档写**，`--dry-run` / `--auto`（纯采证）不写
  //     —— 本机现存 28 个 dry-run case，若一律写库会把分身的故障知识库刷成"演练流水"。
  //   fail-open：写失败只记 step + 不抛（与 G8 其余通道同款；报告已落盘，不因知识库失败回滚修复）。
  //   ⚠️ **必须"可注入 + 生产标记"双条件之一**（2026-10-10 当场踩坑后加的硬护栏）：
  //     知识库落在**生产 home**，而单测用的 deps 是"部分注入"（历史上只注了 audit/alert/report/notify）
  //     ⇒ 光靠 `deps.appendKnowledge` 可选，会让**老套件在跑 apply 档时把测试条目写进生产知识库**
  //     （本卡实测：跑既有回归 `test-nurse-p2/p2a` 后 `~/.dsh/repair-knowledge` 17 → 27 条）。
  //     现口径：**要么显式注入出口（测试/沙箱），要么 deps.isReal === true（只有 realDeps 带）**；
  //     两者都没有 ⇒ **不写**，并在步骤表里写明原因（宁可不沉淀，也不许测试写生产）。
  let kbRes = { ok: false, skipped: true, why: '未到写入条件' }
  const kbInjected = typeof deps.appendKnowledge === 'function'
  if (o.mode === 'apply' && !o.auto && o.knowledge !== false && (kbInjected || deps.isReal === true)) {
    try {
      const entry = bridge.nurseKnowledgeEntry({
        caseId, host: state.host, mode: o.mode, ok: okFinal, stage: outcome.stage ?? 'done',
        startedAt: state.startedAt, endedAt, durationMs, instance, steps,
        applied: (state.artifacts && state.artifacts.applied) || [],
        backups: (state.artifacts && state.artifacts.backups) || [],
        rejected: (state.artifacts && state.artifacts.rejected) || [],
        errors: state.errors || [], notes,
      })
      kbRes = deps.appendKnowledge
        ? await deps.appendKnowledge(entry)
        : await bridge.appendKnowledge(entry, deps.knowledgeDeps ?? {})
    } catch (e) {
      kbRes = { ok: false, error: String(e && e.message ? e.message : e) }
    }
    record('⑥a 知识库写入（C-V8）', kbRes.ok === true,
      kbRes.ok ? `${kbRes.merged ? '合并入' : '新条目'} ${kbRes.dir}\\${kbRes.file}` : `写失败（不阻断）：${kbRes.error}`)
  } else {
    record('⑥a 知识库写入（C-V8）', true,
      o.knowledge === false ? '（--no-knowledge 跳过）'
        : (o.auto ? '（--auto 采证档：零修复动作，不沉淀）'
          : (o.mode !== 'apply' ? '（dry-run 不写库：防把故障知识库刷成演练流水）'
            : '（未注入知识库出口且非生产 realDeps ⇒ 跳过；防测试写生产）')))
  }

  // ⑥b 【D-§4 · 2026-10-12 · V2.9收口·真缺口②】**建议重启** —— 只写建议待办，**绝不自动重启**（方案 §7-5 第一步）。
  //   位置刻意放在 `reportPayload` 之前（同 ⑥a 的理由）：本步本身也是一条 step ⇒ 会出现在同一份报告里（可对账）。
  //   三道闸（全过才写）：① 开关开（CLI `--no-restart-advisory` / env `NURSE_RESTART_ADVISORY=0` 任一即关回）
  //     ② `--apply` 真跑档且非 `--auto` 采证档 ③ `applied` 里真命中「boot 才加载」的 profile 声明面。
  //   fail-open：写卡失败只记 step + 出告警，**不影响 okFinal / 不回滚修复**（与 G8 其余通道同款）。
  //   ⚠️ 这里**只**写卡 + 告警；重启照旧走主人手里的 P0 闸门（编排器全文不得 import request-restart.mjs）。
  let advisoryRes = { needed: false, skipped: true, why: '未到条件' }
  const advSwitch = restartAdvisory.advisoryEnabled({ env: process.env, opts: o })
  if (advSwitch.enabled !== true) {
    advisoryRes = { needed: false, skipped: true, why: advSwitch.why }
    record('⑥b 建议重启待办（D-§4）', true, `（已关回：${advSwitch.why}）`)
  } else if (o.mode !== 'apply' || o.auto) {
    advisoryRes = { needed: false, skipped: true, why: '非 --apply 真跑档' }
    record('⑥b 建议重启待办（D-§4）', true,
      o.auto ? '（--auto 采证档：零修复动作，不提建议）' : '（dry-run 不写：只读档不产生待办）')
  } else {
    const need = restartAdvisory.assessRestartNeed((state.artifacts && state.artifacts.applied) || [])
    if (!need.needed) {
      advisoryRes = { ...need, skipped: true, why: '本次修复不涉及「需重启才生效」的面' }
      record('⑥b 建议重启待办（D-§4）', true, `（无需重启：已执行 ${need.checked} 条动作，均落在无需重启面）`)
    } else {
      const card = restartAdvisory.buildAdvisoryCard({ caseId, hits: need.hits, stage: outcome.stage ?? 'done', endedAt })
      let w
      try {
        if (typeof deps.writeAdvisoryCard === 'function') {
          w = await deps.writeAdvisoryCard(card)
        } else {
          const ck = hostCookie(new URL(PROD_URL).origin)
          w = await restartAdvisory.writeAdvisoryCard({ card, header: ck && ck.header })
        }
      } catch (e) {
        w = { ok: false, error: String((e && e.message) || e) }
      }
      advisoryRes = { ...need, card: { title: card.title }, write: w }
      record('⑥b 建议重启待办（D-§4）', w.ok === true,
        w.ok ? `已写建议待办卡 ${w.taskId}（**只建议 · 不自动重启**）` : `写卡失败（不阻断修复）：${w.error}`)
      await raiseAlert(deps, {
        level: 'warn',
        message: `小护士建议重启（只建议，未自动重启）：${caseId} —— 修了 ${need.hits.length} 处需重启才生效的声明`,
        detail: { caseId, stage: outcome.stage ?? null, cardId: w.taskId ?? null, hitPaths: need.hits.map((h) => h.path) },
      })
    }
  }

  const reportPayload = {
    caseId, host: state.host, mode: o.mode, ok: okFinal, stage: outcome.stage ?? 'done',
    startedAt: state.startedAt, endedAt, durationMs,
    instance, steps,
    applied: (state.artifacts && state.artifacts.applied) || [],
    backups: (state.artifacts && state.artifacts.backups) || [],
    rejected: (state.artifacts && state.artifacts.rejected) || [],
    errors: state.errors || [],
    notes,
  }
  const rep = deps.report
    ? deps.report(reportPayload)
    : bridge.writeRepairReport(reportPayload, { logsRoot: deps.logsRoot, dryRun: o.mode !== 'apply' })
  record('⑥ 报告（G8：logs\\repair-report-*.md）', rep.ok === true,
    rep.ok ? `${rep.file}${rep.dryRun ? '（dry-run 未落盘）' : ''}` : `失败：${rep.error}`)
  const auditRes = await leaveTrace(deps, {
    event: okFinal ? 'nurse-case-done' : 'nurse-case-failed',
    caseId, ok: okFinal, stage: outcome.stage ?? 'done', mode: o.mode, durationMs,
    report: rep.file ?? null,
    applied: ((state.artifacts && state.artifacts.applied) || []).length,
    rejected: ((state.artifacts && state.artifacts.rejected) || []).length,
    error: outcome.error ?? null,
  })
  let notified = null
  if (o.mode === 'apply' && o.noNotify !== true && deps.noNotify !== true) {
    const text = `${bridge.summarize({ caseId, ok: okFinal, stage: outcome.stage, durationMs })}${okFinal ? '' : ` —— ${outcome.error ?? '已冻结现场，等主人处置'}`}`
    notified = deps.notify ? await deps.notify(text) : await bridge.notifyOwner(text)
    record('⑥ 通知（G8：桌宠 + 会话 queue）', notified.whale?.ok === true || notified.session?.ok === true,
      `桌宠=${notified.whale?.ok === true ? 'ok' : (notified.whale?.error ?? 'no')} · 会话=${notified.session?.ok === true ? 'ok' : (notified.session?.error ?? 'no')}`)
  } else record('⑥ 通知', true, o.mode === 'apply' ? '（--no-notify：只留痕不叫人）' : '（dry-run 不打扰主人）')
  if (!okFinal) {
    await raiseAlert(deps, {
      level: 'error',
      message: `小护士未完成（已冻结现场，等主人处置）：${caseId} —— ${outcome.error ?? outcome.stage}`,
      detail: { caseId, stage: outcome.stage ?? null, report: rep.file ?? null, failedSteps: steps.filter((s) => !s.ok).map((s) => s.name) },
    })
  }
  return { ...outcome, ok: okFinal, caseId, steps, state, instance, report: rep, audit: auditRes, notify: notified, knowledge: kbRes, advisory: advisoryRes }
}

// ─────────────────────────── CLI ───────────────────────────
function renderStatus(safeRoot) {
  const states = []
  let names = []
  try { names = fs.readdirSync(safeRoot) } catch { names = [] }
  for (const n of names) {
    if (!/^case-/.test(n)) continue
    const st = readState(path.join(safeRoot, n, 'state.json'))
    if (st) states.push(st)
  }
  const incomplete = findIncompleteCases(safeRoot)
  console.log(`安全 home：${safeRoot}`)
  console.log(`case 总数 ${states.length} · 未收尾（半完成态）${incomplete.length}`)
  for (const st of states.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))) {
    const flag = (TERMINAL_PHASES.includes(st.phase) || EXTERNAL_TERMINAL_PHASES.includes(st.phase)) ? ' ' : '⚠'
    const ext = EXTERNAL_TERMINAL_PHASES.includes(st.phase) ? '（外部工具 case，已结束）' : ''
    console.log(` ${flag} ${st.caseId}  phase=${st.phase}${ext}  ${st.sli && st.sli.durationMs ? `耗时 ${(st.sli.durationMs / 1000).toFixed(1)}s` : ''}`)
  }
  for (const c of incomplete) {
    console.log(`\n⚠ 半完成 case：${c.caseId}（phase=${c.phase}）`)
    console.log(`   ${c.guidance}`)
    if (c.backupDir) console.log(`   备份：${c.backupDir}`)
  }
  const sli = sliOf(states)
  const rate = sli.misFixRate === null ? '—' : `${(sli.misFixRate * 100).toFixed(0)}%`
  console.log(`\nSLI：成功率 ${sli.successRate === null ? '—' : (sli.successRate * 100).toFixed(0) + '%'} · 平均耗时 ${sli.avgDurationMs === null ? '—' : (sli.avgDurationMs / 1000).toFixed(1) + 's'} · 误修率 ${rate}（误修 ${sli.misFix} / 可评估 ${sli.misFixEvaluated} / 未知 ${sli.misFixUnknown}）`)
  return { states, incomplete, sli }
}

function printPlan(o) {
  console.log('小护士 P2 编排器 · 计划（本命令不做任何事）')
  const rows = [
    ['⓪', 'bootstrap 检查（profile 预建 + 无半完成 case）', 'T3 / T7'],
    ['⓪.5', '跨线判据（升级链互斥 · lane-gate 唯一源）', 'G14 闸 2'],
    ['⓪.7', '降档闸（G7：degraded ⇒ 不自动起，fail-closed）', 'G7'],
    ['①', '采集现场包（只读 + 脱敏）', '§4.2'],
    ['①.5', '接管声明（✅ guard 侧已接线：修复窗口内 guard 只探活）', 'T2'],
    ['①.6', `修复窗口静默：dsh-upgrade-silence.mjs --disable`, 'D4=A'],
    ['②', `起安全实例：nurse-ctl start --port ${o.port}（home=${o.safeRoot}）`, '§4.1'],
    ['③', o.proposal ? `取离线提案：${o.proposal}`
      : (o.inject === 'llm'
        ? `agent 提案通道（HTTP ${o.mode === 'apply' ? '真投递' : 'dry-run 只预检'}）：注入 → 读回 → 抽提案 JSON`
        : '注入修复任务（--proposal / --inject llm）'), '§4.3'],
    ['④', '提案校验（G1 白名单 · fail-closed）→ 预算闸 → 降档闸（G7 执行前）→ 执行（写前备份）', 'G1/G4/G5/G7'],
    ['④.8', `冒烟前置（C-G10）：④ 执行前先过测试环境冒烟（${smokeGate.SMOKE_SCRIPT_DEFAULT} · 端口 ${o.smokePort}），不过即拦`, 'C-G10'],
    ['⑤', `验收：生产 HTTP 判活（2xx/3xx/401/403）+ boot 载荷（${PROD_URL}）`, '§7 V1'],
    ['⑤.5', '收尾：恢复静默 + 解除接管声明 + 关实例（失败路径同样执行）', '§4.4'],
    ['⑥', '报告 + 终态 + SLI + 审计/告警/通知（成功与失败都叫人）', 'G8/G13'],
    ['⑥a', '知识库写入：~/.dsh/repair-knowledge（仅 --apply 真跑档）', 'C-V8'],
  ['⑥b', '建议重启待办：只写（看板卡 + 告警），**绝不自动重启**（仅 --apply + 命中需重启面；--no-restart-advisory 关回）', 'D-§4'],
  ]
  for (const [n, what, ref] of rows) console.log(`  ${n.padEnd(5)} ${what.padEnd(58)} ${ref}`)
  console.log(`\n预算：${o.budgetRounds} 轮 / ${o.budgetMin} 分钟 / ${o.budgetTokens} token（超限即冻结转 L2）`)
  console.log(`模式：${o.mode}${o.mode === 'apply' ? '（真跑：会起实例、会写文件、会写 _archive 备份）' : '（不落盘、不起实例）'}`)
}

async function main() {
  const o = parseArgs(process.argv)
  if (o.help) { usage(); process.exitCode = EXIT_OK; return }
  if (!o.mode) { usage(); process.exitCode = EXIT_USAGE; return }
  if (!Number.isInteger(o.port) || o.port < 1024 || o.port === 3080) {
    console.error('✗ --port 非法（拒绝 3080；默认 3091）'); process.exitCode = EXIT_USAGE; return
  }
  if (o.mode === 'status') { renderStatus(o.safeRoot); process.exitCode = EXIT_OK; return }
  if (o.mode === 'plan') { printPlan(o); process.exitCode = EXIT_OK; return }

  // 【P2-B】`--auto`（自动触发档）**不需要提案**：它只采证不修（零修复动作）⇒ 提案入口的校验对它豁免。
  // 【2026-10-10】`--inject llm` 同样不需要 `--proposal`（提案由 agent 通道产出）—— 两条入口互斥，别同给。
  if (o.inject && o.inject !== 'llm') {
    console.error(`✗ --inject 只认 llm（收到 ${o.inject}）`); process.exitCode = EXIT_USAGE; return
  }
  if (o.inject === 'llm' && o.proposal) {
    console.error('✗ --inject llm 与 --proposal 互斥（两条提案入口只能选一条）'); process.exitCode = EXIT_USAGE; return
  }
  if (o.mode === 'apply' && !o.proposal && !o.auto && o.inject !== 'llm') {
    console.error('✗ --apply 需要 --proposal <提案 JSON>（或 --inject llm 走 agent 提案通道）'); process.exitCode = EXIT_USAGE; return
  }
  const res = await runOrchestration(o, realDeps)
  console.log('\n=== 小护士 P2 · 编排结果 ===')
  for (const s of res.steps) console.log(`${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`)
  console.log(`\ncase：${res.caseId} · 结论：${res.ok ? 'OK' : `未完成（stage=${res.stage}）`}`)
  if (!res.ok && res.stage === 'lane-gate') {
    // 【卡 ③-5 · 闸 2】拒启文案（退出码 3 = 环境不可用；与「执行失败」区分开）
    console.log('⛔ 升级锁持有中，先处置升级：node <DSH_ROOT>/tools/dsh-butler/upgrade-lock-cli.mjs status（或 clear 收尾）后重跑本编排器。')
    if (res.laneGate && res.laneGate.judgeUnavailable) console.log('   （判据不可用 ⇒ 同一 fail-safe：保守拒启，不是故障。）')
  }
  if (!res.ok && res.stage === 'degrade-gate') {
    // 【P2-A · G7】降档拒启文案
    console.log('⛔ 降档态（butler-autonomy-state.json level=degraded）：小护士**不自动起**（G7）。')
    console.log('   处置：node <DSH_ROOT>/tools/dsh-butler/butler-autonomy-state-cli.mjs normal --by <who> --reason "<why>" 恢复后再跑；')
    console.log('   或（仅主人手动入口）显式加 --allow-degraded 声明"人工触发"（会留审计 + 告警）。')
  }
  if (!res.ok && res.stage === 'smoke-gate') {
    // 【C-G10】冒烟未过 ⇒ 拦住（fail-closed：一条 L2 动作都没执行）
    console.log('⛔ 冒烟前置未过（C-G10 · 上生产前过测试环境冒烟）：护士**没有执行任何 L2 动作**（fail-closed）。')
    console.log('   处置①：按上面输出/审计 nurse-smoke-gate 的 [FAIL] 项先修测试环境，再重跑本编排器；')
    console.log('   处置②（仅人工显式 · 方案 §5 G10「零依赖沙箱演练」路径）：加 --allow-smoke-skip 放行（会留痕 + 出告警）。')
  }
  if (o.json) console.log(JSON.stringify(res, null, 2))
  process.exitCode = res.ok ? EXIT_OK : ((res.stage === 'lane-gate' || res.stage === 'degrade-gate') ? EXIT_ENV : EXIT_FAIL)
}

const isMain = (() => {
  try {
    const a = fs.realpathSync(process.argv[1] || '')
    const b = fs.realpathSync(fileURLToPath(import.meta.url))
    return a.toLowerCase() === b.toLowerCase()
  } catch { return false }
})()

// ---------- 【A2 · V2.9收口 · 2026-10-12】护士进程输出同份落盘 ----------
//   背景：守护鱼起护士用 `stdio:'ignore'`（guard.mjs L681）⇒ `--auto` 采证档的逐行输出生产侧无从取证。
//   修法：**只在直接运行（isMain）时**给 console.log/error 包一层 —— 先照旧写 stdout，再同份追加落盘。
//     不逐个改 28 处调用点（改动面最小）；**行为零变化**；失败静默（fail-open）。
//   关回：env `DSH_NURSE_LOG=0`；`DSH_NURSE_LOG=<path>` 指定文件。
//   为什么不必重启守护鱼：本文件是被 spawn 的子进程入口（guard 只 spawn、不 import）⇒ 落盘即生效。
function installAgentLogTee() {
  if (process.env.DSH_NURSE_LOG === '0' || process.env.DSH_NURSE_LOG === 'false') return null
  const env = process.env.DSH_NURSE_LOG
  const file = (env && String(env).trim()) ? String(env).trim()
    : path.join(DSH_ROOT, 'logs', 'nurse-agent-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + process.pid + '.log')
  try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch { /* ignore */ }
  const tap = (orig, tag) => (...a) => {
    const line = '[' + new Date().toISOString().slice(11, 19) + '] [' + tag + '] ' + a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')
    try { fs.appendFileSync(file, line + '\n') } catch { /* fail-open */ }
    return orig(...a)
  }
  console.log = tap(console.log.bind(console), 'INFO')
  console.error = tap(console.error.bind(console), 'ERROR')
  return file
}

if (isMain) {
  try {
    installAgentLogTee()
    await main()
  } catch (e) {
    console.error(`✗ 编排器异常：${e && e.stack || e}`)
    process.exitCode = EXIT_FAIL
  }
}

export { parseArgs, usage, printPlan, renderStatus, EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_ENV }
