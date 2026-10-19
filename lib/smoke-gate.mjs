/**
 * smoke-gate.mjs —— 小护士 P2 · **冒烟前置**（C-G10 · 「上生产前过测试环境冒烟」）
 *
 * 缺口原话（主档 §1 P 域 · L918 · 靶单 idx 255 · 源域档 `K-小护士与守护鱼.md:112`）：
 *   `C-G10 冒烟前置` = 🟡 部分生效（**产物在 · 护士线零挂点 ⇒ 装好零使用**）——
 *   冒烟脚本在位（产物 √）＋ 编排器全文 `冒烟 / smoke` **0 命中**（调用点 ✗）＋ 无 `smoke` 审计行（痕迹 ✗）
 *   ⇒ **三件缺二**，不得判 ✅。
 * 方案原文（`docs\小护士-安全模式修复层方案-20260911.md` §5 G10 · L243）：
 *   「小护士上线前，其安全实例必须过 `dsh-test-smoke.mjs` 同款四项检查；**H 盘/测试环境不在线时走
 *     『零依赖沙箱演练』路径并如实标注，不许假装过**」；
 *   同档 L382 顺序铁律：「P1/P2 全部在**隔离环境**验证，过 `…\dsh-test-smoke.mjs` 同款检查后才碰生产
 *     （沿用『测试完成才准上生产』）」。
 *   ⚠️ 脚本真身**不在**主工具树里 —— 由 `DSH_SMOKE_SCRIPT` 指定（指向你的隔离测试环境里的
 *     冒烟脚本，例如 `<test-root>/scripts/dsh-test-smoke.mjs`）。**不设 = 判 unavailable（fail-closed）**。
 *
 * 🔴 本模块只做**判定与拦阻**，不做任何生产副作用：
 *   · 不写生产文件（拦下来 = 一条 L2 动作都不执行，正是它的用处）；
 *   · 不 import 任何重启/放行类模块；
 *   · 唯一副作用由调用方（编排器）负责：审计一行 + 一条告警（G8 通道）。
 *
 * 判据（fail-closed · 纯函数 · 可单测）：**只认冒烟脚本退出码 0 为 PASS**。三态：
 *   · `pass`        （code === 0）           ⇒ 放行，继续 ④ 执行
 *   · `fail`        （code !== 0 且跑起来了）⇒ **拦住**（一条 L2 动作都不执行）
 *   · `unavailable` （脚本不在位 / 超时 / 起不来）⇒ **同样拦住**（= 方案那句「不许假装过」的实现：
 *                     环境不在线**不构成放行李由**；要走沙箱路径必须人工显式 `--allow-smoke-skip`，
 *                     且**照样留痕 + 出告警**）
 *
 * 开关（一键关回，两个口；缺省开）：
 *   · CLI：编排器 `--no-smoke`
 *   · env：`NURSE_SMOKE=0`（`0|false|off|no` 任一）
 *   另有两道天然限位：**只有 `--apply` 真跑档**才拦（dry-run 只报告，与 ④.7 降档闸同款口径）；
 *   且**只在 ④ L2 动作执行之前**判一次（"上生产前"的最后一道）。
 *
 * 纪律：本模块是**库**（无 CLI 入口）；退出码语义由调用方负责（收尾 `process.exitCode`）。
 * 守门单测：`tools\dsh-nurse\_test\test-smoke-gate.mjs`
 * 隔离链路演练：`_archive\v29-closure-P-20261014\drill\drill-smoke-gate.mjs`（通过 / 不通过两条分支）
 */

export const SMOKE_GATE_VERSION = '0.1.0'

/** 冒烟脚本真身（绝对路径 · 单一真源；由 `DSH_SMOKE_SCRIPT` 指定，缺省空 = unavailable） */
export const SMOKE_SCRIPT_DEFAULT = process.env.DSH_SMOKE_SCRIPT || ''

/** 冒烟跑在**隔离测试实例**端口上（默认 3090）；生产 3080 = 硬拒（脚本自身也拒） */
export const SMOKE_PORT_DEFAULT = 3090
export const PROD_PORT = 3080

/** 冒烟超时（默认 5 分钟：脚本自带 90s 就绪窗口 + 逐条资源校验 + 起停实例） */
export const SMOKE_TIMEOUT_MS_DEFAULT = 300_000

/** 输出留痕截断长度（审计/报告里只留尾部，防刷爆审计行） */
export const SMOKE_OUTPUT_TAIL = 1200

/** 开关判定（纯函数；缺省**开**，`0|false|off|no` 关）—— 一键关回两个口 */
export function smokeEnabled({ env = process.env, opts = {} } = {}) {
  if (opts.smoke === false) return { enabled: false, why: 'CLI --no-smoke' }
  const v = String((env && env.NURSE_SMOKE) ?? '').trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') {
    return { enabled: false, why: 'env NURSE_SMOKE=0' }
  }
  return { enabled: true, why: '缺省开（仅 --apply 真跑档 + 上生产前拦一道）' }
}

/**
 * 组装冒烟命令参数（纯函数）。**拒在 3080（生产）上跑** —— 与脚本自身的安全闸同款。
 * @returns {{ok:boolean, args?:string[], reason?:string}}
 */
export function buildSmokeArgs({ port = SMOKE_PORT_DEFAULT } = {}) {
  const p = Number(port)
  if (!Number.isInteger(p) || p < 1024 || p > 65535 || p === PROD_PORT) {
    return { ok: false, reason: `冒烟端口非法：${port}（拒 ${PROD_PORT}=生产 / 拒越界；建议 ${SMOKE_PORT_DEFAULT}）` }
  }
  // 刻意**不加** `--keep`：冒烟跑完自己把测试实例停掉（护士线不留第二个在跑实例）。
  return { ok: true, args: ['--port', String(p)] }
}

/** 输出尾巴（供审计/报告留痕；空输出返回空串） */
export function outputTail(out, max = SMOKE_OUTPUT_TAIL) {
  const s = String(out ?? '')
  if (!s) return ''
  return s.length <= max ? s : `…（前 ${s.length - max} 字节省略）…\n${s.slice(-max)}`
}

/**
 * 判定冒烟结果（纯函数 · **fail-closed**）。
 * @param {{code?:number|null, out?:string, timedOut?:boolean, notFound?:boolean, portInvalid?:string, error?:string}} r
 * @returns {{verdict:'pass'|'fail'|'unavailable', pass:boolean, reason:string, code:number|null}}
 */
export function interpretSmokeResult(r = {}) {
  const code = Number.isFinite(r.code) ? r.code : null
  if (r.portInvalid) return { verdict: 'unavailable', pass: false, code, reason: `冒烟未跑：${r.portInvalid}` }
  if (r.notFound === true) {
    return {
      verdict: 'unavailable', pass: false, code,
      reason: '冒烟脚本不在位（测试环境不在线）—— 方案 §5 G10：走零依赖沙箱路径须**人工显式**声明并如实标注，不许假装过（本闸 fail-closed 拦住）',
    }
  }
  if (r.timedOut === true) {
    return { verdict: 'unavailable', pass: false, code, reason: `冒烟超时（脚本没在预算内收尾）⇒ 保守判不过 —— fail-closed 拦住` }
  }
  if (code === 0) return { verdict: 'pass', pass: true, code, reason: '冒烟 PASS（脚本退出码 0）' }
  if (code === null || code === -1) {
    return { verdict: 'unavailable', pass: false, code, reason: `冒烟没跑起来${r.error ? `：${r.error}` : ''} ⇒ 保守判不过 —— fail-closed 拦住` }
  }
  return { verdict: 'fail', pass: false, code, reason: `冒烟 FAIL（脚本退出码 ${code}）⇒ 拦住：不许拿未过冒烟的东西上生产` }
}

/** 步骤表文案（纯函数 · 单测断言用；格式与本文件同批落地） */
export function smokeStepDetail({ verdict, script, port, code = null, note = '' } = {}) {
  const head = `${verdict?.verdict ?? '?'} · 脚本=${script ?? '(默认)'} · 端口=${port ?? SMOKE_PORT_DEFAULT}`
  const tail = code === null || code === undefined ? '' : ` · 退出码=${code}`
  const why = verdict?.reason ? ` —— ${verdict.reason}` : ''
  return `${head}${tail}${why}${note ? `｜${note}` : ''}`
}

export default {
  SMOKE_GATE_VERSION,
  SMOKE_SCRIPT_DEFAULT,
  SMOKE_PORT_DEFAULT,
  PROD_PORT,
  SMOKE_TIMEOUT_MS_DEFAULT,
  smokeEnabled,
  buildSmokeArgs,
  outputTail,
  interpretSmokeResult,
  smokeStepDetail,
}
