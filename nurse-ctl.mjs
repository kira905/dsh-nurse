#!/usr/bin/env node
// ============================================================
//  nurse-ctl.mjs — 小护士「安全模式实例」起停（P1）
//  ------------------------------------------------------------
//  三条硬闸（fail-closed）：
//    G2  home 必须在 %USERPROFILE%\.dsh-safe 之下，否则拒启
//    G9  **单次互斥**：`nurse-instance.json` 里任一 pid（真 dsh pid / launcher pid）存活 ⇒ 拒起
//        （2026-10-10 补：旧版只有端口层兜底，挡不住"上一个还在启动中"）
//    端口 3091 被占 → 明确报错退出（**不硬抢、不杀别人**）
//    端口 3080（生产）→ 一律拒绝
//  停止闸：pid 必须既不是生产 3080 的 pid，命令行里又确实带 .dsh-safe
//          （判定不了 → 拒停，绝不误杀）
//
//  零主包依赖：只用 node 内置模块 + 主包 bin 路径。
//  用法：
//    node nurse-ctl.mjs status
//    node nurse-ctl.mjs start [--dry-run] [--port 3091] [--profile nurse]
//    node nurse-ctl.mjs stop  [--dry-run]
//  退出码：0 正常 / 1 环境错误 / 2 用法或硬闸拒绝 / 3 端口被占
//
//  【2026-09-23 · L9 ①② 两处修正】
//   ① **真 dsh pid**：实例由共享 launcher 拉起（launcher 是父进程、dsh 是它 spawn 的子进程）。
//      脚本此前把 launcher pid 当真 pid 报/记（child.pid），status 里还混着端口 owner 一起印。
//      现口径：真 pid 来源优先级 = ①端口 owner（唯一客观）→ ②launcher 的 pidFile → ③记录；
//      记录区分 `pid`（真 dsh pid，可为 null）与 `launcherPid`；拿不到真 pid 时**明确标注**
//      「launcher pid N（真 dsh pid 未取到）」，绝不把 launcher pid 顶替成真 pid。
//   ② **stop 的孤儿**：旧版在「启动中」（端口尚未监听、进程已在）只清记录不杀进程 ⇒ 孤儿。
//      现按「端口 owner / 记录 pid / 记录 launcherPid / launcher 子进程 / 命令行形态」收集候选，
//      逐个过安全闸（生产 3080 pid 一律拒杀、归属判不出的一律不杀），杀序 = 先 dsh 后 launcher。
// ============================================================
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
// 【2026-09-23 · cmd 黑窗修复】起实例一律经 launcher（否则实例无控制台 ⇒ 它的命令弹黑窗）
import { spawnHidden, readDshPidFile } from './lib/guard-launcher.mjs'
import { cliGuard } from './lib/cli-args.mjs'
// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】PowerShell 一律走统一工具（pwsh 7 优先）：360 企业版
//   EDR 只对 5.1 弹「PowerShell 命令执行攻击」；工具缺失 ⇒ 兜底 powershell（绝对 URL，与上一行同风格）。
const PS_EXE = await import('./lib/powershell-exe.mjs').then((m) => m.powerShellExe()).catch(() => 'powershell')

const HOME = os.homedir()
const SAFE_ROOT = path.join(HOME, '.dsh-safe')
const PROD_PORT = 3080

const SPEC = {
  cmd: 'dsh-nurse-ctl',
  summary: '小护士安全模式实例的起 / 停 / 看（三条硬闸：home 必须在安全根之下、单次互斥、生产端口一律拒绝）。',
  usage: 'dsh-nurse-ctl <start|stop|status> [--port 3091] [--profile nurse] [--home <目录>] [--dry-run]',
  commands: [
    { name: 'start', desc: '拉起一个安全模式实例（新进程 + 独立日志目录）' },
    { name: 'stop', desc: '停掉本工具拉起的那个实例（判不出归属就拒停，绝不误杀）' },
    { name: 'status', desc: '只读：看实例在不在、端口通不通' },
  ],
  flags: [
    { name: '--port', arg: 'N', desc: '实例端口，默认 3091；给 3080（生产）直接拒' },
    { name: '--profile', arg: '名', desc: '用哪个 profile，默认 nurse' },
    { name: '--home', arg: '目录', desc: '实例 home（必须在 .dsh-safe 之下）' },
    { name: '--cwd', arg: '目录', desc: '实例工作目录' },
    { name: '--dry-run', desc: 'start / stop 只打印动作，不起不停' },
  ],
  writes: 'start 会起一个新进程并写日志与实例记录；stop 会终止该进程。status 只读。',
  dryRun: 'start / stop 加 --dry-run 只打印将做什么。',
  exits: '0 成功 · 1 操作失败 · 2 硬闸拒绝 / 用法错',
  examples: ['dsh-nurse-ctl status', 'dsh-nurse-ctl start --dry-run'],
};
const argv = cliGuard(SPEC)
const cmd = argv[0]
const hasFlag = (n) => argv.includes('--' + n)
const optVal = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const DRY = hasFlag('dry-run')
const PORT = Number(optVal('port', 3091))
const PROFILE = optVal('profile', 'nurse')
const TARGET_HOME = path.resolve(optVal('home', SAFE_ROOT))
const CWD = path.resolve(optVal('cwd', process.env.DSH_ROOT || path.join(HOME, 'DSH')))
const BIN = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const LOG_DIR = path.join(TARGET_HOME, 'logs')

const out = (s) => process.stdout.write(s + '\n')
/** 终止：设退出码后抛信号，由顶层吞掉 —— 收尾一律走 process.exitCode（铁律：不发 process.exit 强退）。 */
const die = (msg, code = 1) => {
  out(`[FAIL] ${msg}`)
  process.exitCode = code
  const e = new Error(msg)
  e.name = 'DieSignal'
  throw e
}

// ---------- 硬闸 ----------
// 注意：必须在**入口 try 内**执行 —— die 靠抛 DieSignal 终止，顶层未捕获会覆盖退出码成 1
function guardChecks() {
  const rel = path.relative(SAFE_ROOT, TARGET_HOME)
  const insideSafe = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  if (!insideSafe) die(`home 硬闸拒绝：「${TARGET_HOME}」不在「${SAFE_ROOT}」之下（G2 fail-closed）`, 2)
  if (PORT === PROD_PORT) die(`拒绝在端口 ${PROD_PORT}（生产）上操作`, 2)
}

// ---------- 工具 ----------
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', (e) => resolve({ free: false, code: e.code }))
    srv.once('listening', () => srv.close(() => resolve({ free: true })))
    srv.listen(port, '127.0.0.1')
  })
}

function psOut(command) {
  try {
    return execFileSync(PS_EXE, ['-NoProfile', '-Command', command], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    }).trim()
  } catch { return '' }
}

function parsePidList(s) {
  return (s || '').split(/\r?\n/).map((x) => parseInt(x.trim(), 10)).filter((v) => Number.isFinite(v) && v > 0)
}

function pidOnPort(port) {
  const s = psOut(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`)
  const pid = parseInt(s, 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

/**
 * 一次只读查询拿到进程的「活否 / 父 pid / 命令行」（少起 powershell；status/stop 都要用）。
 * 返回 null = 进程不存在。
 */
function procInfo(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return null
  const s = psOut(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${n}" -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { "$($p.ProcessId)|$($p.ParentProcessId)|$($p.CommandLine)" }`)
  if (!s) return null
  const i1 = s.indexOf('|')
  const i2 = i1 >= 0 ? s.indexOf('|', i1 + 1) : -1
  if (i1 < 0 || i2 < 0) return { pid: n, parentPid: null, cmdline: null }
  const pp = parseInt(s.slice(i1 + 1, i2), 10)
  return {
    pid: n,
    parentPid: Number.isFinite(pp) && pp > 0 ? pp : null,
    cmdline: s.slice(i2 + 1) || null,
  }
}

function cmdlineOf(pid) { return procInfo(pid)?.cmdline ?? '' }
function pidAlive(pid) { return procInfo(pid) ? Number(pid) : null }
function alivePids(pids) {
  const list = pids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
  if (!list.length) return []
  return parsePidList(psOut(`Get-Process -Id ${list.join(',')} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`))
}

function childPidsOf(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return []
  return parsePidList(psOut(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${n}" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId`))
}

/** launcher 形态判据：共享 launcher 由 `node -e (launcherMain)` 启动，命令行里必带 --pid-file。 */
function looksLikeLauncher(cmdline) { return !!cmdline && cmdline.includes('--pid-file') }

/** 兜底发现：按命令行形态找本实例进程（--profile 与 --port 同时命中；记录丢失/陈旧时用）。
 *  ⚠️ 必须排除查询进程自己（`$PID`）—— powershell 的命令行里就带着这两个 pattern，
 *     不排除会自匹配出一条「进程已不存在」的假候选（2026-09-23 实测）。 */
function pidsByCmdline(profile, port) {
  return parsePidList(psOut(`Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like '*--profile ${profile}*' -and $_.CommandLine -like '*--port ${port}*' } | Select-Object -ExpandProperty ProcessId`))
}

async function httpCode(url, timeoutMs = 4000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ac.signal })
    return r.status
  } catch { return null } finally { clearTimeout(t) }
}

// ---------- status ----------
// ---------- 实例身份（G12 状态文件：唯一权威的"这是我起的"凭据） ----------
const INSTANCE_FILE = path.join(TARGET_HOME, 'nurse-instance.json')

function readInstance() {
  try { return JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8')) } catch { return null }
}

function writeInstance(obj) {
  const tmp = INSTANCE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, INSTANCE_FILE) // 原子写
}

function clearInstance() {
  try { fs.rmSync(INSTANCE_FILE, { force: true }) } catch { /* ignore */ }
}

/**
 * 记录里的两个 pid（真 dsh pid / launcher pid）。
 * 旧格式（无 launcherPid 字段，2026-09-23 之前写的）：若 pid 的命令行是 launcher 形态，
 * 就归位成 launcherPid —— 旧版正是把 launcher pid 写进 pid 的。
 */
function instancePids(inst) {
  if (!inst) return { dshPid: null, launcherPid: null, legacy: false, movedFromLegacy: false }
  const legacy = !('launcherPid' in inst)
  let dshPid = Number(inst.pid) > 0 ? Number(inst.pid) : null
  let launcherPid = Number(inst.launcherPid) > 0 ? Number(inst.launcherPid) : null
  let movedFromLegacy = false
  if (legacy && dshPid && looksLikeLauncher(cmdlineOf(dshPid))) {
    launcherPid = dshPid
    dshPid = null
    movedFromLegacy = true
  }
  return { dshPid, launcherPid, legacy, movedFromLegacy }
}

/** 归属判定：命令行必须明确带着本实例的 profile 与端口（DSH_HOME 在环境变量里、命令行看不到）。 */
function looksLikeOurs(cmdline, profile, port) {
  if (!cmdline) return false
  const hasProfile = cmdline.includes(`--profile ${profile}`)
  const hasPort = cmdline.includes(`--port ${port}`)
  return hasProfile && hasPort
}

/**
 * 【C-G9 · 单次互斥 · 2026-10-10】**pid 文件防双小护士**。
 *
 * 方案 §5 G9 原文：「pid 文件防双小护士（沿用分身既有互斥）」。
 * 旧实现只有**端口层**兜底（`portFree`）——它挡得住"第二个实例抢同一端口"，
 *   挡不住「上一个实例**还在启动中**（端口尚未监听）」时再起一个：那一刻端口是空的，
 *   于是两个 nurse 进程并存、各自写同一份 `nurse-instance.json`，后写者覆盖前写者
 *   ⇒ stop 只杀得掉一个，另一个成孤儿（与 `nurse-ctl` 2026-09-23 L9 ② 修过的孤儿问题同源）。
 *
 * 判据（**唯一权威凭据 = `nurse-instance.json`**，G12）：记录里的 `pid`（真 dsh pid）
 *   或 `launcherPid` **任一存活** ⇒ 判定"已有实例在跑" ⇒ **拒起**（exit 2，fail-closed）。
 *   · 两个 pid 都探不到 ⇒ 记录**陈旧** ⇒ 清掉再继续（不阻断启动；dry-run 档只提示不清）；
 *   · 命令行形态兜底**不**在这里用：形态匹配（`pidsByCmdline`）留 stop 的"防漏杀"侧，
 *     起实例侧宁可"记录说没有就起"——多起一次的代价是一个孤儿进程，误拒的代价是
 *     "出事那天小护士起不来"，两害相权取前者（且端口层仍有一道兜底）。
 */
function assertNoLiveInstance() {
  const inst = readInstance()
  if (!inst) return { ok: true, note: '无实例记录' }
  const ip = instancePids(inst)
  const aliveD = ip.dshPid ? pidAlive(ip.dshPid) : null
  const aliveL = ip.launcherPid ? pidAlive(ip.launcherPid) : null
  if (aliveD || aliveL) {
    die(`单次互斥（G9）拒绝第二次启动：已有活着的安全实例\n`
      + `       记录文件：${INSTANCE_FILE}\n`
      + `       dsh pid ${ip.dshPid ?? '(未取到)'} 存活=${aliveD ? '是' : '否'} · launcher pid ${ip.launcherPid ?? '(无)'} 存活=${aliveL ? '是' : '否'}`
      + `（记录端口 ${inst.port ?? '?'}，本次 port ${PORT}）\n`
      + `       要复用它：node nurse-verify.mjs --port ${inst.port ?? PORT}；要重起：node nurse-ctl.mjs stop --port ${inst.port ?? PORT}`, 2)
  }
  out(`[INFO] 实例记录陈旧（记录的两个 pid 都已退出）→ ${DRY ? 'dry-run 只提示、不清记录' : '清理记录后继续'}`)
  if (!DRY) clearInstance()
  return { ok: true, note: '陈旧记录已清' }
}

async function doStatus() {
  const portPid = pidOnPort(PORT)              // 端口 owner = 真 dsh 实例 pid（唯一客观判据）
  const prodPid = pidOnPort(PROD_PORT)
  const profileDir = path.join(TARGET_HOME, 'profiles', PROFILE)
  const inst = readInstance()
  const ip = instancePids(inst)
  const dshPid = portPid ?? ip.dshPid
  let launcherPid = ip.launcherPid
  if (!launcherPid && portPid) {               // 记录缺 launcher 时，向父进程要（须确为 launcher 形态）
    const pp = procInfo(portPid)?.parentPid ?? null
    if (pp && looksLikeLauncher(cmdlineOf(pp))) launcherPid = pp
  }
  const aliveL = launcherPid ? pidAlive(launcherPid) : null
  const aliveD = dshPid ? pidAlive(dshPid) : null

  out('============================================================')
  out(' 小护士安全实例 状态')
  out('============================================================')
  out(`  home      : ${TARGET_HOME}`)
  out(`  profile   : ${PROFILE}（${fs.existsSync(path.join(profileDir, 'package.json')) ? '已就绪' : '缺失 → 跑 make-nurse-profile.mjs'}）`)
  out(`  端口 ${PORT}  : ${portPid ? `LISTEN (dsh pid ${portPid})` : '空闲'}`)
  out(`  生产 ${PROD_PORT}  : ${prodPid ? `LISTEN (pid ${prodPid})` : '未监听'}`)
  if (!inst) {
    out('  实例记录  : 无（未由本脚本启动过）')
  } else {
    const head = dshPid
      ? `dsh pid ${dshPid}${launcherPid ? ` · launcher pid ${launcherPid}` : ''}`
      : `launcher pid ${launcherPid ?? '?'}（真 dsh pid 未取到）`
    out(`  实例记录  : ${head}（startedAt ${inst.startedAt}）`)
    out(`  记录判活  : dsh ${dshPid ? (aliveD ? `存活 (${dshPid})` : '已退出') : '未知'} · launcher ${launcherPid ? (aliveL ? `存活 (${launcherPid})` : '已退出') : '未知'}`)
    if (ip.legacy) out(`  记录格式  : 旧版（无 launcherPid 字段）${ip.movedFromLegacy ? '，且原 pid 实为 launcher pid → 已归位' : ''}`)
    if (!portPid && aliveL) out('  ⚠ 启动中  : 端口尚未监听但 launcher 仍存活 —— stop 会按记录清理，不留孤儿')
    if (!portPid && !aliveL && !aliveD) out('  陈旧记录  : 记录里的进程都已不在 → 下次 stop 会清掉')
  }
  if (portPid) {
    const cl = cmdlineOf(portPid)
    out(`  进程命令行: ${cl ? cl.slice(0, 200) : '(读不到)'}`)
    out(`  归属判定  : ${looksLikeOurs(cl, PROFILE, PORT) ? '本实例（命令行含 --profile ' + PROFILE + ' --port ' + PORT + '）' : '⚠ 非本实例命令行形态'}`)
    const code = await httpCode(`http://127.0.0.1:${PORT}/`)
    out(`  HTTP /    : ${code ?? '无响应'}`)
  }
  out('')
  process.exitCode = 0
}

// ---------- start ----------
async function doStart() {
  if (!fs.existsSync(BIN)) die(`找不到主包入口：${BIN}`, 1)
  const profileDir = path.join(TARGET_HOME, 'profiles', PROFILE)
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    die(`nurse profile 不存在（bootstrap 前置未做）：${profileDir}\n       先跑：node ${path.join(path.dirname(process.argv[1]), 'make-nurse-profile.mjs')}`, 1)
  }
  if (!fs.existsSync(CWD)) die(`cwd 不存在：${CWD}`, 1)

  // 【C-G9】单次互斥（pid 文件防双小护士）—— **排在端口闸之前**：
  //   端口闸只能看见"已监听"的实例；「上一个还在启动中」时端口是空的，必须靠记录层拦。
  assertNoLiveInstance()

  const pf = await portFree(PORT)
  if (!pf.free) {
    const pid = pidOnPort(PORT)
    const cl = pid ? cmdlineOf(pid) : ''
    die(`端口 ${PORT} 已被占用（${pf.code}）${pid ? ` pid=${pid}` : ''}\n       占用者：${cl ? cl.slice(0, 180) : '(读不到命令行)'}\n       本脚本不硬抢端口：请先停掉占用者，或用 --port 指定其它端口`, 3)
  }

  fs.mkdirSync(LOG_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const logFile = path.join(LOG_DIR, `dsh-nurse-${stamp}.log`)

  // 注意：`dsh web` 是 `--profile web` 的别名，**不能与 --profile 同时给**
  // （实测报 "web takes none of parent --profile ..."）→ 用 --profile + app 参数形态
  const args = [BIN, '--profile', PROFILE, '--port', String(PORT), '--no-open']
  out('============================================================')
  out(' 小护士安全实例 启动')
  out('============================================================')
  out(`  home   : ${TARGET_HOME}`)
  out(`  profile: ${PROFILE}   端口: ${PORT}   cwd: ${CWD}（只读视角）`)
  out(`  权限   : read-only（D1=A 判断与动手分离）`)
  out(`  命令   : node ${args.join(' ')}`)
  out(`  日志   : ${logFile}`)
  if (DRY) { out('  【dry-run】未真正启动'); out(''); process.exitCode = 0; return }

  // 【2026-09-23 · cmd 黑窗修复】经 launcher 起实例（与 guard 同款机制）：
  //   旧写法 detached:true + windowsHide:true ⇒ DETACHED_PROCESS ⇒ 实例**没有控制台**
  //   ⇒ 它跑任何命令都要新建可见控制台 ⇒ 默认终端是 Windows Terminal ⇒ 弹黑窗。
  //   改用共享 launcher：launcher 用 {windowsHide:true, detached:false} 起实例 ⇒ CREATE_NO_WINDOW
  //   ⇒ 实例拿到**不可见控制台**，后代继承 ⇒ 0 可见窗口；launcher 自身活到实例结束
  //   （CREATE_NO_WINDOW 的控制台归创建者，创建者一退就销毁并连坐杀实例，故这层不能省）。
  //   ⚠️ 因此 child.pid 是 **launcher** 的 pid，真 dsh pid 要读 launcher 的 pidFile（L9 ①）。
  let child
  let pidFile
  try {
    const r = spawnHidden(process.execPath, args, {
      log: logFile,
      cwd: CWD,
      stateDir: path.join(os.tmpdir(), 'dsh-guard'),
      env: {
        DSH_HOME: TARGET_HOME,
        DSH_PERMISSION_MODE: 'read-only',
        DSH_WEB_URL: `http://127.0.0.1:${PORT}`,
      },
    })
    child = r.child
    pidFile = r.pidFile
  } catch (e) {
    die(`spawn 失败：${e.message}`, 1)
  }
  const realPidInfo = readDshPidFile(pidFile, { timeoutMs: 8000 })
  const dshPid = realPidInfo.dshPid ?? null                       // 真 dsh 实例 pid
  const launcherPid = realPidInfo.launcherPid ?? child.pid ?? null // 拉起它的 launcher（父进程）
  if (!dshPid) out(`[WARN] 真 dsh pid 未取到（${realPidInfo.reason ?? '启动中，pidFile 未落盘'}）—— 记录里只存 launcher pid ${launcherPid}`)

  writeInstance({
    schemaVersion: 1,
    kind: 'nurse-instance',
    pid: dshPid,               // 真 dsh 实例 pid（拿不到即 null，**绝不用 launcher pid 顶替**）
    launcherPid,               // launcher（父进程）pid —— stop 的候选之一
    port: PORT,
    profile: PROFILE,
    home: TARGET_HOME,
    cwd: CWD,
    permissionMode: 'read-only',
    startedAt: new Date().toISOString(),
    log: logFile,
    pidFile,
    note: '本文件是 stop 判据的唯一权威凭据（G12）；丢失后用命令行形态 --profile/--port 兜底',
  })

  out('')
  if (dshPid) out(`  真 dsh pid ${dshPid}（launcher pid ${launcherPid}，已脱钩）`)
  else out(`  launcher pid ${launcherPid}（真 dsh pid 未取到，记录已如此标注；已脱钩）`)
  out(`  实例记录写入 ${INSTANCE_FILE}`)
  out(`  就绪探活：node nurse-verify.mjs --port ${PORT}   # 一次性取证（nurse-verify 只做一次性探活，无轮询参数）`)
  out('')
  out(JSON.stringify({ pid: dshPid, launcherPid, port: PORT, home: TARGET_HOME, log: logFile }))
  process.exitCode = 0
}

// ---------- stop ----------
async function doStop() {
  const portPid = pidOnPort(PORT)
  const prodPid = pidOnPort(PROD_PORT)
  const inst = readInstance()
  const ip = instancePids(inst)
  out('============================================================')
  out(' 小护士安全实例 停止')
  out('============================================================')

  // ── 收集候选：端口 owner（真实例）/ 记录两个 pid / launcher 的子进程 / 命令行形态兜底 ──
  //    「启动中」的实例端口还没监听，光看端口会漏 ⇒ 必须靠记录与进程树兜住（L9 ②）。
  const cands = []
  const add = (pid, why) => {
    const n = Number(pid)
    if (!Number.isInteger(n) || n <= 0) return
    if (n === process.pid) return            // 绝不把自己（本 stop 进程）当候选
    if (cands.some((c) => c.pid === n)) return
    cands.push({ pid: n, why })
  }
  if (portPid) add(portPid, `端口 ${PORT} owner（真 dsh 实例）`)
  if (ip.dshPid) add(ip.dshPid, '实例记录 dsh pid')
  if (ip.launcherPid) add(ip.launcherPid, '实例记录 launcher pid')
  if (portPid) {
    const pp = procInfo(portPid)?.parentPid ?? null
    if (pp && looksLikeLauncher(cmdlineOf(pp))) add(pp, '端口 owner 的父进程（launcher）')
  }
  if (ip.launcherPid) for (const c of childPidsOf(ip.launcherPid)) add(c, `launcher ${ip.launcherPid} 的子进程（启动中的 dsh）`)
  for (const p of pidsByCmdline(PROFILE, PORT)) add(p, '命令行形态匹配（--profile/--port）')

  if (!cands.length) {
    out(`  端口 ${PORT} 无监听进程，也没有归本实例的进程（未运行）`)
    if (inst) { out('  实例记录存在但无对应进程 → 清理陈旧记录'); if (!DRY) clearInstance() }
    out('')
    process.exitCode = 0
    return
  }

  // ── 安全闸：逐个确认归属；生产 pid 一律拒杀；判不出的一律不杀（fail-closed）──
  const plan = []
  const refused = []
  for (const c of cands) {
    const info = procInfo(c.pid)
    if (!info) { refused.push({ dead: true, text: `pid ${c.pid}（${c.why}）：进程已不存在` }); continue }
    if (prodPid && c.pid === prodPid) { refused.push({ dead: false, text: `pid ${c.pid}（${c.why}）：与生产 ${PROD_PORT} 的 pid 相同 → 保守拒动` }); continue }
    const cl = info.cmdline
    if (!cl) { refused.push({ dead: false, text: `pid ${c.pid}（${c.why}）：读不到命令行，无法确认归属（fail-closed）` }); continue }
    const oursByCmd = looksLikeOurs(cl, PROFILE, PORT)
    const oursByFile = !!(inst && Number(inst.port) === PORT && (Number(inst.pid) === c.pid || Number(inst.launcherPid) === c.pid))
    if (!oursByCmd && !oursByFile) {
      refused.push({ dead: false, text: `pid ${c.pid}（${c.why}）：命令行不含 --profile ${PROFILE} --port ${PORT}，也不在实例记录中 → 拒杀\n         ${cl.slice(0, 200)}` })
      continue
    }
    plan.push({
      pid: c.pid,
      why: c.why,
      cred: [oursByFile ? '记录匹配' : '', oursByCmd ? '命令行匹配' : ''].filter(Boolean).join('+'),
      isLauncher: looksLikeLauncher(cl),
      cmdline: cl,
    })
  }
  // 杀序：先 dsh 子进程、后 launcher（launcher 持有 dsh 的隐藏控制台，反序会连坐且可能留下无主子进程）
  plan.sort((a, b) => Number(a.isLauncher) - Number(b.isLauncher))

  out(`  生产 ${PROD_PORT}  : ${prodPid ? `pid ${prodPid}（一律不碰）` : '未监听'}`)
  out(`  端口 ${PORT}  : ${portPid ? `LISTEN (dsh pid ${portPid})` : '未监听（启动中/已停 —— 记录与进程树照样兜住）'}`)
  out(`  待停止 ${plan.length} 个：`)
  for (const p of plan) out(`    · pid ${p.pid} [${p.why}] 凭据=${p.cred}${p.isLauncher ? ' · launcher' : ' · dsh/子进程'}`)
  for (const r of refused) if (!r.dead) out(`    ✗ 不杀 ${r.text}`)
  const ghosts = refused.filter((r) => r.dead).length
  if (ghosts) out(`    （另有 ${ghosts} 个候选在查询时已不存在，忽略）`)
  if (!plan.length) {
    if (refused.length && refused.every((r) => r.dead)) {
      out('  候选进程都已不存在（实例已停）')
      if (inst) { out('  清理实例记录'); if (!DRY) clearInstance() }
      out('')
      process.exitCode = 0
      return
    }
    out('  ⚠ 没有任何进程通过归属闸 → 拒绝停止（fail-closed，绝不误杀）')
    out('')
    process.exitCode = 2
    return
  }
  if (DRY) { out('  【dry-run】未真正停止'); out(''); process.exitCode = 0; return }

  for (const p of plan) {
    try {
      execFileSync('taskkill', ['/PID', String(p.pid), '/F'], { windowsHide: true, timeout: 20000 })
      out(`  taskkill pid ${p.pid} → OK`)
    } catch (e) {
      // 常见于「launcher 已随它拉起的 dsh 退出」——以复查存活为准，别把已退出的进程报成失败
      const alive = pidAlive(p.pid)
      out(alive
        ? `  taskkill pid ${p.pid} → 失败且进程仍存活：${String(e.message).split('\n')[0]}`
        : `  taskkill pid ${p.pid} → 进程已自行退出（taskkill 未命中，复查确认）`)
    }
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (!pidOnPort(PORT)) break
  }
  const survivors = alivePids(plan.map((p) => p.pid))
  const stillPort = pidOnPort(PORT)
  if (!survivors.length && !stillPort) {
    clearInstance()
    out(`  已停止（进程已退出、端口 ${PORT} 已释放、实例记录已清理）`)
  } else {
    out(`  ⚠ 未清干净：残留进程 ${survivors.length ? survivors.join(', ') : '无'} · 端口 ${stillPort ? `仍 LISTEN (pid ${stillPort})` : '已释放'} —— 实例记录保留`)
  }
  out('')
  process.exitCode = 0
}

// ---------- 入口 ----------
try {
  guardChecks()
  if (cmd === 'start') await doStart()
  else if (cmd === 'stop') await doStop()
  else if (cmd === 'status') await doStatus()
  else {
    out('用法：node nurse-ctl.mjs <status|start|stop> [--dry-run] [--port 3091] [--profile nurse]')
    out('      单次互斥（G9）：已有活着的实例时 start 会被拒（先 stop，或用 nurse-verify 复用）')
    process.exitCode = 2
  }
} catch (e) {
  if (e?.name !== 'DieSignal') throw e   // DieSignal = 已打印并设好退出码的正常终止
}
