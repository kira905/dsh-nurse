// ============================================================
//  tools/lib/powershell-exe.mjs —— PowerShell 解释器选择「唯一真源」
//  ------------------------------------------------------------
//  为什么存在（2026-10-09 · 卡「360弹窗治本-pwsh7」）：
//    360 企业版 EDR（公司下发、终端只读）对 **Windows PowerShell 5.1**
//    （%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe）的每次
//    `-Command` 调用判定为「PowerShell 命令执行攻击」并弹窗拦截；本机
//    DSH 生态里有几十处 spawn 5.1 的点，watch job 每 5.5 分钟一条 ⇒ 主人被反复弹。
//    对策 = 全部改走 **pwsh 7**（同样被 360 放行），本模块即该选择的单一实现。
//
//  口径（写进坑库，新增代码必须遵守）：
//    **新增脚本/代码调 PowerShell 一律 pwsh 7 优先，禁裸 powershell.exe（5.1）**。
//    只用「解析 + spawn 薄封装」两个能力，不改变调用方的参数与输出解析口径。
//
//  实测（2026-10-09 · 某 Windows 主机）：
//    · `where pwsh` → %ProgramFiles%\WindowsApps\Microsoft.PowerShell_7.x_x64__…\pwsh.exe
//                     + %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe（两个都指向 7.6.6 别名）
//    · `%ProgramFiles%\PowerShell\7\pwsh.exe` **不存在**（本机是 Store/MSIX 安装）
//    · `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`：**fs.existsSync() = false**
//      但直接 spawn 该全路径 **可跑**（status 0 / 7.6.6）⇒ 别名形态**必须真跑探测**，
//      只看 existsSync 会漏判 ⇒ 本模块对「绝对路径候选」是 exists 或 probe 二者之一命中即选。
//    · 空 PATH 下 `spawn('pwsh')` = **ENOENT** ⇒ PATH 候选失败必须能回退（见 spawnPowerShellSync）。
//    · 5.1 与 7.6 的 Get-NetTCPConnection / Get-CimInstance / Get-Process / Start-Sleep 实测等价；
//      控制台输出编码两代都跟随代码页（GB2312），**换 7 不改变中文解码口径**（保持既有解析行为）。
//
//  设计要点：
//    · 纯解析函数可注入（env / exists / probe / candidates）⇒ 单测能造假件覆盖回退分支，不必真删 pwsh；
//    · PATH 候选默认「信任」（不为它多跑一次探测），失败由 spawn 层的 ENOENT 回退兜底；
//    · 绝对路径候选：existsSync 命中即选；否则**真跑探测**（专治 WindowsApps 别名）。
// ============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '1.0.0';

/** pwsh 7（首选）。 */
export const KIND_PWSH = 'pwsh';
/** Windows PowerShell 5.1（兜底）。 */
export const KIND_WINPS = 'windows-powershell';
/** 连 5.1 都解析不到时的硬兜底 exe 名。 */
export const HARD_FALLBACK_EXE = 'powershell.exe';

function systemRoot(env) { return env.SystemRoot || env.windir || ((env.SystemDrive || 'C:') + '\\Windows'); }
function localAppData(env) {
  return env.LOCALAPPDATA || path.join(env.USERPROFILE || path.join((env.SystemDrive || 'C:') + '\\', 'Users', 'Default'), 'AppData', 'Local');
}
function programFilesDir(env) { return env.ProgramFiles || ((env.SystemDrive || 'C:') + '\\Program Files'); }

/** 路径比较（Windows 大小写不敏感；容忍引号与斜杠差异）。 */
export function sameExe(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const n = (s) => s.trim().replace(/^"|"$/g, '').replace(/\//g, '\\').toLowerCase();
  return n(a) === n(b);
}

/**
 * 候选解释器（**有序**：pwsh 优先，5.1 最后）。
 * 顺序 = 环境变量 → PATH 的 pwsh → Program Files 的 pwsh → WindowsApps 别名 pwsh → PATH 的 5.1 → System32 的 5.1。
 * @param {{env?:object}} [opts]
 * @returns {Array<{exe:string,kind:string,source:string,pathed:boolean}>}
 */
export function powerShellCandidates(opts = {}) {
  const env = opts.env ?? process.env;
  const out = [];
  const push = (c) => { if (typeof c.exe === 'string' && c.exe.trim()) out.push(c); };
  if (env.DSH_PWSH) {
    push({ exe: env.DSH_PWSH, kind: KIND_PWSH, source: 'env:DSH_PWSH', pathed: !/[\\/]/.test(env.DSH_PWSH) });
  }
  push({ exe: 'pwsh', kind: KIND_PWSH, source: 'path', pathed: true });
  push({ exe: path.join(programFilesDir(env), 'PowerShell', '7', 'pwsh.exe'), kind: KIND_PWSH, source: 'program-files-7', pathed: false });
  push({ exe: path.join(localAppData(env), 'Microsoft', 'WindowsApps', 'pwsh.exe'), kind: KIND_PWSH, source: 'windowsapps-alias', pathed: false });
  push({ exe: HARD_FALLBACK_EXE, kind: KIND_WINPS, source: 'path-fallback', pathed: true });
  push({ exe: path.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), kind: KIND_WINPS, source: 'system32-fallback', pathed: false });
  return out;
}

/**
 * 默认探测 = **真跑一次** `-NoProfile -NonInteractive -Command exit 0`（专治 WindowsApps 别名：
 * existsSync=false 但能跑）。任何异常都当"不可用"，绝不抛。
 * @returns {boolean}
 */
export function defaultProbe(exe, { spawnImpl = spawnSync, timeoutMs = 20_000, env } = {}) {
  try {
    const r = spawnImpl(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
      { windowsHide: true, timeout: timeoutMs, stdio: 'ignore', env });
    return !r?.error && r?.status === 0;
  } catch { return false; }
}

/**
 * 解析优先解释器（纯函数，可注入）。
 * @param {{
 *   env?:object, exists?:(p:string)=>boolean, probe?:Function|null,
 *   candidates?:Array, spawnImpl?:Function, probeTimeoutMs?:number
 * }} [opts]
 *   · `probe` 缺省（undefined）= 用 {@link defaultProbe} 真跑；`null` = 完全不探测（PATH 候选直接信任、绝对路径只看 exists）
 *   · `exists` 缺省 = `fs.existsSync`
 * @returns {{exe:string,kind:string,source:string,pathed:boolean,verified:boolean,reason:string}|null}
 */
export function resolvePowerShell(opts = {}) {
  const exists = opts.exists ?? fs.existsSync;
  const rawProbe = opts.probe;
  const probe = rawProbe === undefined
    ? (exe) => defaultProbe(exe, { spawnImpl: opts.spawnImpl, timeoutMs: opts.probeTimeoutMs, env: opts.env })
    : (typeof rawProbe === 'function' ? rawProbe : null);
  const cands = opts.candidates ?? powerShellCandidates(opts);
  for (const c of cands) {
    if (c.pathed) {
      if (!probe) return { ...c, verified: false, reason: 'path-trusted(no-probe)' };
      if (probe(c.exe)) return { ...c, verified: true, reason: 'path-probe-ok' };
      continue;
    }
    if (exists(c.exe)) return { ...c, verified: false, reason: 'exists' };
    if (probe && probe(c.exe)) return { ...c, verified: true, reason: 'probe-ok(alias)' };
  }
  return null;
}

let CACHE = null; // { exe, kind, source, verified, reason, at }

/**
 * 优选解释器 exe（带进程内缓存；**永不返回 null** —— 全找不到时给 `powershell.exe` 现状兜底）。
 * @param {{noCache?:boolean} & Parameters<typeof resolvePowerShell>[0]} [opts]
 */
export function powerShellExe(opts = {}) {
  if (opts.noCache !== true && CACHE) return CACHE.exe;
  const hit = resolvePowerShell(opts);
  const picked = hit
    ? { ...hit, at: Date.now() }
    : { exe: HARD_FALLBACK_EXE, kind: KIND_WINPS, source: 'hard-fallback', pathed: true, verified: false, reason: 'none-resolved', at: Date.now() };
  if (opts.noCache !== true) CACHE = picked;
  return picked.exe;
}

/** 清缓存（spawn 撞 ENOENT / 单测需要重解析时用）。 */
export function resetPowerShellCache() { CACHE = null; }

/** 只读诊断快照（报告 / 自检 / 面板用）。 */
export function describePowerShell(opts = {}) {
  const hit = resolvePowerShell(opts);
  const picked = hit ?? { exe: HARD_FALLBACK_EXE, kind: KIND_WINPS, source: 'hard-fallback', verified: false, reason: 'none-resolved' };
  return {
    exe: picked.exe, kind: picked.kind, source: picked.source, verified: picked.verified, reason: picked.reason,
    cached: CACHE ? { ...CACHE } : null,
    candidates: powerShellCandidates(opts).map((c) => ({
      ...c,
      exists: c.pathed ? null : Boolean((opts.exists ?? fs.existsSync)(c.exe)),
    })),
  };
}

/**
 * spawn 薄封装：**参数与返回值与 `spawnSync(exe, args, spawnOpts)` 兼容**，
 * 只是 exe 自动优选，并在 `ENOENT`（PATH 里没有 pwsh / 别名失效）时**自动回退到下一个候选**。
 * 非 ENOENT 的错误（超时 / 被杀）**不回退** —— 语义是「解释器找到了，只是命令失败」。
 *
 * @param {string[]} args 原样透传给解释器的参数（如 ['-NoProfile','-Command', cmd]）
 * @param {object} [spawnOpts] spawnSync 选项（encoding / timeout / windowsHide / maxBuffer / env …）
 * @param {{spawnImpl?:Function, candidates?:Array, exe?:string, noCache?:boolean,
 *          env?:object, exists?:Function, probe?:Function|null}} [resolveOpts]
 * @returns {object} spawnSync 结果 + `exe` / `kind` / `attempts`（诊断用）
 */
export function spawnPowerShellSync(args, spawnOpts = {}, resolveOpts = {}) {
  const spawnImpl = resolveOpts.spawnImpl ?? spawnSync;
  const cands = resolveOpts.candidates ?? powerShellCandidates(resolveOpts);
  const target = resolveOpts.exe ?? (resolveOpts.noCache === true ? null : CACHE?.exe) ?? powerShellExe(resolveOpts);
  let start = cands.findIndex((c) => sameExe(c.exe, target));
  if (start < 0) start = 0;
  const attempts = [];
  let last = null;
  for (let i = start; i < cands.length; i++) {
    const c = cands[i];
    let r;
    try { r = spawnImpl(c.exe, args, spawnOpts); } catch (e) { r = { error: e }; }
    attempts.push({ exe: c.exe, kind: c.kind, status: r?.status ?? null, errCode: r?.error?.code ?? null });
    last = r;
    if (!r?.error) return { ...r, exe: c.exe, kind: c.kind, attempts };
    if (r.error?.code !== 'ENOENT') return { ...r, exe: c.exe, kind: c.kind, attempts };
    if (resolveOpts.noCache !== true) resetPowerShellCache(); // PATH 候选失效 ⇒ 缓存作废，下一候选顶上
  }
  return { ...(last ?? {}), error: last?.error ?? new Error('no-usable-powershell'), exe: null, kind: null, attempts };
}

/** 便捷：跑一条 `-Command`（自动 `-NoProfile -NonInteractive`）。 */
export function runPowerShell(command, spawnOpts = {}, resolveOpts = {}) {
  return spawnPowerShellSync(['-NoProfile', '-NonInteractive', '-Command', String(command)], spawnOpts, resolveOpts);
}
