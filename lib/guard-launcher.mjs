// ============================================================
// 【隐藏控制台 launcher · 共享模块】（2026-09-23 · 卡「cmd 黑窗定位与修复」）
// ------------------------------------------------------------
// 背景（R-9 报告 + 本卡实测）：dsh 实例如果**没有控制台**，它用主包原生的
//   CreateProcessW（flags=1028，无 CREATE_NO_WINDOW）拉起 runner/pwsh/cmd 时，
//   每个子进程都要**新建控制台**；本机默认终端是 Windows Terminal ⇒ 每条命令
//   弹一个黑窗（实测窗口形态：class=CASCADIA_HOSTING_WINDOW_CLASS | 1168x624 |
//   title=<SystemDrive>\WINDOWS\system32\cmd.exe）。
//
// 判据（本卡实测，可复跑）：用 **conhost 归属**判"实例有没有控制台"——
//   有 conhost 子进程 = 有控制台（隐藏的也算）；没有 = 无控制台 ⇒ 迟早弹窗。
//   实测：生产 dsh（经 launcher 起）hasOwnConhost=true；
//         repair 形态（detached+windowsHide 直起）hasOwnConhost=false。
//
// 修法：**任何"拉起 dsh 实例"的入口都必须经本模块的 spawnHidden** ——
//   spawnHidden 起一个 launcher（detached+windowsHide ⇒ 自身无控制台、独立于调用方生死），
//   由 launcher 用 {windowsHide:true, detached:false} 起 dsh ⇒ CREATE_NO_WINDOW ⇒
//   dsh 拿到**不可见控制台**，后代（runner.js/pwsh/cmd）继承它 ⇒ 全程 0 可见窗口。
//
// ⚠️ 为什么必须多这一层（2026-09-22 实测归因，别删）：CREATE_NO_WINDOW 创建的控制台
//   **由创建者进程拥有**，创建者一退出（正常退出或被 taskkill /F）就被销毁并连带杀掉
//   附着者。所以创建者必须"活到 dsh 结束" —— 调用方（repair 分身 / nurse-ctl /
//   测试启动器）都做不到（它们起完就退），launcher 可以（child.on('exit') 跟着走）。
//
// ⚠️ launcher 用 `node -e (launcherMain)(...)` 起：命令行里**不出现 guard.mjs /
//   repair.mjs**，否则 guard 的 findGuardProcs / dsh-restart.ps1 的"第二只守护鱼"
//   检测会把它杀掉（杀 launcher = 杀 dsh）。
//
// ⚠️ launcherMain 只依赖 process / 动态 import（CJS `-e` 与 ESM 两边都能跑），
//   用 toString() 注入。**与 guard.mjs 内联的那份逐字同源** —— 改一处必须同步另一处，
//   一致性由 tools\_test\test-guard-launcher-consistency.mjs 断言（不一致即报红）。
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function launcherMain(argv) {
  const fs = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const o = { log: null, cwd: null, pidFile: null, prog: null, args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--log') o.log = argv[++i];
    else if (a === '--cwd') o.cwd = argv[++i];
    else if (a === '--pid-file') o.pidFile = argv[++i];
    else if (a === '--') { o.prog = argv[++i]; o.args = argv.slice(i + 1); break; }
  }
  const note = (m) => { try { fs.appendFileSync(o.pidFile + '.log', '[' + new Date().toISOString() + '] ' + m + '\n'); } catch {} };
  if (!o.prog) { note('missing -- prog; exiting'); process.exit(2); }
  let fd = 'ignore';
  try { fd = fs.openSync(o.log, 'a'); } catch (e) { note('open log failed: ' + e.message); }
  // ⭐ 关键：detached:false + windowsHide:true ⇒ CREATE_NO_WINDOW ⇒ dsh 拿到不可见控制台
  const child = spawn(o.prog, o.args, {
    cwd: o.cwd || undefined,
    detached: false,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  try {
    fs.writeFileSync(o.pidFile + '.tmp', JSON.stringify({
      dshPid: child.pid, launcherPid: process.pid, at: new Date().toISOString(),
      prog: o.prog, argv: o.args,
    }));
    fs.renameSync(o.pidFile + '.tmp', o.pidFile);
  } catch (e) { note('pid file write failed: ' + e.message); }
  note('launched dsh pid=' + child.pid);
  child.on('error', (e) => { note('spawn error: ' + e.message); process.exit(3); });
  // launcher 必须活到 dsh 退出（它拥有 dsh 的控制台）；dsh 一走就跟着走，不积残留。
  child.on('exit', (code) => { note('dsh exited code=' + code + '; launcher exiting'); process.exit(0); });
  setInterval(() => {}, 3600000);
}

/**
 * 用 launcher 形态起 prog（prog 会得到一个**不可见控制台**）。
 *
 * @param {string} prog  可执行文件（通常是 process.execPath）
 * @param {string[]} args 参数
 * @param {object} [opts]
 * @param {string} [opts.log]       dsh 的 stdout/stderr 落盘文件
 * @param {string} [opts.cwd]       子进程 cwd
 * @param {string} [opts.pidFile]   launcher 写 {dshPid,launcherPid} 的文件（供调用方读真 pid）
 * @param {string} [opts.stateDir]  未给 pidFile/log 时的默认目录
 * @param {object} [opts.env]       额外环境变量（注入给 launcher，再由 launcher 传给 dsh）
 * @returns {{ child: import('node:child_process').ChildProcess, pidFile: string, logFile: string }}
 *          child.pid 是 **launcher** 的 pid；dsh 真 pid 见 pidFile（用 readDshPidFile 等它落盘）。
 */
export function spawnHidden(prog, args, opts = {}) {
  const stateDir = opts.stateDir || path.join(os.tmpdir(), 'dsh-guard');
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch { /* ignore */ }
  const pidFile = opts.pidFile || path.join(stateDir, `dsh-launcher-pid-${process.pid}.json`);
  const logFile = opts.log || path.join(stateDir, `dsh-hidden-${Date.now()}.log`);
  try { fs.rmSync(pidFile, { force: true }); } catch { /* ignore */ }
  const code = '(' + launcherMain.toString() + ')(process.argv.slice(1));';
  const child = spawn(process.execPath, ['-e', code, '--',
    '--log', logFile,
    '--cwd', opts.cwd || process.cwd(),
    '--pid-file', pidFile,
    '--', prog, ...args,
  ], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  child.unref();
  return { child, pidFile, logFile };
}

/**
 * 同步等待并读取 launcher 写下的 dsh 真 pid（launcher 起 dsh 后再写文件，需 ~50-300ms）。
 * **失败绝不静默**：超时返回 { dshPid: null, reason }，调用方自行决定（别把 launcher pid 当真 pid 用）。
 */
export function readDshPidFile(pidFile, { timeoutMs = 5000, pollMs = 100 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const j = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      if (j && Number.isInteger(j.dshPid)) return { dshPid: j.dshPid, launcherPid: j.launcherPid ?? null, raw: j };
    } catch { /* not yet written */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
  return { dshPid: null, launcherPid: null, reason: `pid file not readable within ${timeoutMs}ms: ${pidFile}` };
}
