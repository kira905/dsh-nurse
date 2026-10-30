#!/usr/bin/env node
// ============================================================
//  collect-case.mjs — 小护士「现场包」采集器（P1 · §4.2 现场包 / §5.1 安全与隐私）
//  ------------------------------------------------------------
//  纪律：
//    · **全部只读**：只读生产 <DSH_ROOT>/logs、%TEMP%/dsh-guard、~/.dsh（读），绝不写入
//    · **脱敏**：落盘前按 §5.1 敏感清单正则替换（凭证 / 绝对用户路径 / 内网地址）
//    · **fail-open**：单节采集失败 → 记 missing=true 继续（缺失项在 manifest 里如实标注）
//    · **retention**：case-<ts>/ 默认保留 7 天，--prune 清理过期 case
//    · 产出：~/.dsh-safe\case-<ts>\manifest.json + 各节文件 + state.json（G12 原子写）
//
//  用法：
//    node collect-case.mjs --dry-run        # 只列将采集什么
//    node collect-case.mjs                  # 采集
//    node collect-case.mjs --tail 400 --days 7
//    node collect-case.mjs --prune          # 清理超过 retention 的 case 目录
//    node collect-case.mjs --with-config-dump   # 额外采集默认态/叠加态配置树（默认关）
//  退出码：0 成功 / 1 环境错误 / 2 用法或硬闸拒绝
// ============================================================
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createRedactor } from './lib/redact.mjs'
import { cliGuard } from './lib/cli-args.mjs'

// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】PowerShell 一律走统一工具（pwsh 7 优先）：360 企业版
//   EDR 只对 5.1 弹「PowerShell 命令执行攻击」；工具缺失 ⇒ 兜底 powershell（绝对 URL，与邻居同风格）。
const PS_EXE = await import('./lib/powershell-exe.mjs').then((m) => m.powerShellExe()).catch(() => 'powershell')

const HOME = os.homedir()
const SAFE_ROOT = path.join(HOME, '.dsh-safe')
const PROD_HOME = path.join(HOME, '.dsh')
const PROD_ROOT = process.env.DSH_ROOT || path.join(HOME, 'DSH')
const TEMP = process.env.TEMP || os.tmpdir()

const SPEC = {
  cmd: 'dsh-nurse-collect',
  summary: '小护士「现场包」采集器：把日志 / 进程 / 配置等现场证据采到一个 case 目录（生产目录只读，落盘前一律脱敏）。',
  usage: 'dsh-nurse-collect [--days 7] [--tail 200] [--dry-run] [--prune]',
  flags: [
    { name: '--days', arg: 'N', desc: '采集窗口天数，默认 7' },
    { name: '--tail', arg: 'N', desc: '每节日志取尾部多少行，默认 200' },
    { name: '--retention-days', arg: 'N', desc: 'case 保留天数，默认 7' },
    { name: '--dry-run', desc: '只打印将要采什么，不落盘' },
    { name: '--prune', desc: '顺带清理过期 case（会删目录）' },
    { name: '--with-config-dump', desc: '额外采主包配置转储（会临时起一次 dsh 进程，默认不采）' },
  ],
  writes: '写 ~/.dsh-safe/case-<时间戳>/ 下的现场包（manifest + 各节文件 + state.json）；带 --prune 时会删过期 case 目录。生产目录一个字节都不写。',
  dryRun: '加 --dry-run 只打印计划，不落盘、不删任何东西。',
  exits: '0 成功 · 1 前置缺失（如还没建安全 home）/ 采集失败 · 2 参数错误',
  examples: ['dsh-nurse-collect --dry-run', 'dsh-nurse-collect --days 3 --tail 500'],
};
const argv = cliGuard(SPEC)
const hasFlag = (n) => argv.includes('--' + n)
const optVal = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const DRY = hasFlag('dry-run')
const PRUNE = hasFlag('prune')
const WITH_DUMP = hasFlag('with-config-dump')
const TAIL = Number(optVal('tail', '200'))
const DAYS = Number(optVal('days', '7'))
const RETENTION_DAYS = Number(optVal('retention-days', '7'))

const out = (s) => process.stdout.write(s + '\n')
const die = (msg, code = 1) => { out(`[FAIL] ${msg}`); process.exit(code) }

// ---------- 硬闸 ----------
if (!fs.existsSync(SAFE_ROOT)) die(`安全 home 不存在：${SAFE_ROOT}（先跑 make-nurse-profile.mjs）`, 1)

// ---------- 脱敏（§5.1 敏感清单） ----------
//  规则与实现统一在 lib/redact.mjs（有独立单测守着 —— 此处曾出过两条真 bug：
//  manifest 自身漏脱敏、路径正则漏 JSON 转义的双反斜杠）。
const redactor = createRedactor()
const redactAndCount = (text) => redactor.redactAndCount(text)
const deepRedact = (obj) => redactor.deepRedact(obj)
const redactionStats = () => redactor.stats()
void os

// ---------- 采集工具 ----------
const sections = []

function newestFile(dir, filter) {
  try {
    const files = fs.readdirSync(dir).filter(filter).map((f) => {
      const p = path.join(dir, f)
      return { p, mtimeMs: fs.statSync(p).mtimeMs }
    }).sort((a, b) => b.mtimeMs - a.mtimeMs)
    return files[0]?.p ?? null
  } catch { return null }
}

function tailLines(file, n) {
  const buf = fs.readFileSync(file, 'utf8')
  const lines = buf.split(/\r?\n/)
  return { text: lines.slice(-n).join('\n'), lines: Math.min(n, lines.length), total: lines.length }
}

function addSection(id, file, source, producer) {
  try {
    const r = producer()
    if (r == null) {
      sections.push({ id, file, source, missing: true, note: '来源不存在' })
      return
    }
    const text = typeof r === 'string' ? r : JSON.stringify(r, null, 2)
    const payload = redactAndCount(text)
    if (!DRY) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, payload, 'utf8')
    }
    sections.push({
      id, file: path.basename(file), source, missing: false,
      bytes: Buffer.byteLength(payload, 'utf8'),
      ...(typeof r === 'object' && r.lines ? { lines: r.lines, totalLines: r.total } : {}),
    })
  } catch (e) {
    sections.push({ id, file, source, missing: true, note: `采集失败（fail-open）：${e.message}` })
  }
}

function psJson(command, timeout = 30000) {
  const s = execFileSync(PS_EXE, ['-NoProfile', '-Command', command], {
    encoding: 'utf8', timeout, windowsHide: true,
  })
  return JSON.parse(s)
}

// ---------- case 目录 ----------
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
const caseId = `case-${stamp}-${Math.random().toString(16).slice(2, 6)}`
const caseDir = path.join(SAFE_ROOT, caseId)

// ---------- retention 清理 ----------
if (PRUNE) {
  const now = Date.now()
  const removed = []
  for (const d of fs.readdirSync(SAFE_ROOT)) {
    if (!/^case-/.test(d)) continue
    const p = path.join(SAFE_ROOT, d)
    try {
      const ageDays = (now - fs.statSync(p).mtimeMs) / 86400000
      if (ageDays > RETENTION_DAYS) { if (!DRY) fs.rmSync(p, { recursive: true, force: true }); removed.push(`${d}（${ageDays.toFixed(1)} 天）`) }
    } catch { /* ignore */ }
  }
  out(`retention 清理：${removed.length ? removed.join(', ') : '无过期 case'}`)
  if (!DRY && removed.length) out(`（保留期 ${RETENTION_DAYS} 天）`)
  process.exitCode = 0
} else {
  out('============================================================')
  out(' 小护士 · 现场包采集（只读 + 脱敏）')
  out('============================================================')
  out(`  caseId  : ${caseId}`)
  out(`  输出    : ${caseDir}`)
  out(`  参数    : tail=${TAIL} 行 / timeline=${DAYS} 天 / retention=${RETENTION_DAYS} 天`)
  out('')

  // 1) 崩溃日志尾（最新 dsh-web 日志）
  const webLog = newestFile(path.join(PROD_ROOT, 'logs'), (f) => /^dsh-web-.*\.log$/.test(f))
  addSection('crash-tail', path.join(caseDir, 'crash-tail.log'), webLog || `${PROD_ROOT}\\logs\\dsh-web-*.log`,
    () => (webLog ? tailLines(webLog, TAIL) : null))

  // 1b) 守护鱼日志尾
  const guardLog = path.join(TEMP, 'dsh-guard', 'guard2.log')
  addSection('guard-log-tail', path.join(caseDir, 'guard-log-tail.log'), guardLog,
    () => (fs.existsSync(guardLog) ? tailLines(guardLog, TAIL) : null))

  // 2) 哨兵状态与崩溃计数
  const guardState = path.join(TEMP, 'dsh-guard', 'guard-state.json')
  addSection('guard-state', path.join(caseDir, 'guard-state.json'), guardState,
    () => (fs.existsSync(guardState) ? JSON.stringify(JSON.parse(fs.readFileSync(guardState, 'utf8')), null, 2) : null))

  // 3) 进程 / 端口快照
  addSection('processes', path.join(caseDir, 'processes.json'), 'Win32_Process + Get-NetTCPConnection',
    () => {
      const procs = psJson(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Depth 3`)
      const ports = [3080, 3090, 3091, 3092].map((p) => {
        try {
          const s = execFileSync(PS_EXE, ['-NoProfile', '-Command',
            `(Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
          ], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim()
          return { port: p, pid: s ? Number(s) : null }
        } catch { return { port: p, pid: null } }
      })
      const list = Array.isArray(procs) ? procs : [procs]
      const guards = list.filter((p) => (p.CommandLine || '').includes('dsh-guard'))
      return {
        nodeProcessCount: list.length,
        guardProcessCount: guards.length,
        ports,
        nodeProcesses: list.map((p) => ({ pid: p.ProcessId, startedAt: p.CreationDate, cmd: (p.CommandLine || '').slice(0, 300) })),
      }
    })

  // 4) 最近改动时间轴（复用急救台 timeline）
  //    注意：timeline 会用**非零退出码**表达"有异常"（这是它的语义，不是失败），
  //    所以这里用 spawnSync 收 stdout，把退出码写进现场包而不是当错误抛掉。
  const timeline = path.join(PROD_ROOT, 'tools', 'dsh-firstaid', 'timeline.mjs')
  addSection('timeline', path.join(caseDir, 'timeline.md'), timeline,
    () => {
      if (!fs.existsSync(timeline)) return null
      const r = spawnSync(process.execPath, [timeline, '--days', String(DAYS)], { encoding: 'utf8', timeout: 180000, windowsHide: true })
      const text = `${r.stdout || ''}${r.stderr ? '\n--- stderr ---\n' + r.stderr : ''}`
      if (!text.trim()) throw new Error(`timeline 无输出（exit=${r.status}, error=${r.error?.message ?? '-'}）`)
      return `${text}\n\n---\n（timeline 退出码 ${r.status}：0 正常 / 1 有异常 / 2 用法 / 3 环境不可用 —— 语义见急救台文档）`
    })

  // 5) 备份清单（_archive 最近目录，只列名字与时间，不递归）
  addSection('backups', path.join(caseDir, 'backups.json'), `${PROD_ROOT}\\_archive`,
    () => {
      const dir = path.join(PROD_ROOT, '_archive')
      if (!fs.existsSync(dir)) return null
      const items = fs.readdirSync(dir).map((n) => {
        const p = path.join(dir, n)
        const st = fs.statSync(p)
        return { name: n, dir: st.isDirectory(), mtime: st.mtime.toISOString(), entries: st.isDirectory() ? fs.readdirSync(p).length : null }
      }).sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, 20)
      return { total: fs.readdirSync(dir).length, newest: items }
    })

  // 6) 崩溃前活跃会话（按 mtime 取最近的会话文件，只记路径/时间/大小，不读内容）
  addSection('active-sessions', path.join(caseDir, 'active-sessions.json'), `${PROD_HOME}\\sessions`,
    () => {
      const root = path.join(PROD_HOME, 'sessions')
      if (!fs.existsSync(root)) return null
      const found = []
      const walk = (dir, depth) => {
        if (depth < 0) return
        for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, it.name)
          let st
          try { st = fs.lstatSync(p) } catch { continue }
          if (st.isSymbolicLink()) continue
          if (it.isDirectory()) { walk(p, depth - 1); continue }
          if (/\.(zstd|jsonl)$/.test(it.name)) {
            found.push({ rel: path.relative(root, p), mtime: st.mtime.toISOString(), bytes: st.size })
          }
        }
      }
      walk(root, 3)
      found.sort((a, b) => b.mtime.localeCompare(a.mtime))
      return { count: found.length, newest: found.slice(0, 5) }
    })

  // 7) 知识库命中（同签名历史）
  addSection('knowledge', path.join(caseDir, 'knowledge.json'), `${PROD_HOME}\\repair-knowledge`,
    () => {
      const dir = path.join(PROD_HOME, 'repair-knowledge')
      if (!fs.existsSync(dir)) return null
      const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
        const p = path.join(dir, f)
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf8'))
          return { file: f, signature: j.signature ?? j.cause ?? null, at: j.at ?? j.timestamp ?? null, summary: String(j.summary ?? j.diagnosis ?? '').slice(0, 200) }
        } catch { return { file: f, parseError: true } }
      }).sort((a, b) => String(b.file).localeCompare(String(a.file))).slice(0, 5)
      return { dir, total: fs.readdirSync(dir).length, newest: entries }
    })

  // 8) 配置树两视角对比（默认关：避免对生产 home 做任何多余动作）
  if (WITH_DUMP) {
    const bin = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    addSection('config-default', path.join(caseDir, 'config-default.txt'), `dsh --profile web --dump-default-config`, () =>
      execFileSync(process.execPath, [bin, '--profile', 'web', '--dump-default-config'], {
        encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, DSH_HOME: PROD_HOME },
      }))
    addSection('config-user', path.join(caseDir, 'config-user.txt'), `dsh --profile web --dump-config`, () =>
      execFileSync(process.execPath, [bin, '--profile', 'web', '--dump-config'], {
        encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, DSH_HOME: PROD_HOME },
      }))
  } else {
    sections.push({
      id: 'config-default', file: 'config-default.txt', source: 'dsh --dump-default-config',
      missing: true, note: 'P1 默认跳过（加 --with-config-dump 才采集；避免对生产 home 做多余动作）',
    })
    sections.push({
      id: 'config-user', file: 'config-user.txt', source: 'dsh --dump-config',
      missing: true, note: 'P1 默认跳过（加 --with-config-dump 才采集）',
    })
  }

  // ---------- manifest + state ----------
  let manifest = {
    schemaVersion: 1,
    kind: 'nurse-case',
    caseId,
    createdAt: new Date().toISOString(),
    host: process.env.COMPUTERNAME || os.hostname(),
    generator: 'tools/dsh-nurse/collect-case.mjs',
    mode: 'read-only',
    plan: 'docs/小护士-安全模式修复层方案-20260911.md §4.2 / §5.1',
    prodHome: PROD_HOME,
    sections,
    retentionDays: RETENTION_DAYS,
    expiresAt: new Date(Date.now() + RETENTION_DAYS * 86400000).toISOString(),
    notes: [
      '全部只读采集：未写入生产 home / 工作区',
      '落盘前已按 §5.1 敏感清单脱敏（凭证 / 绝对用户路径 → <home> / 内网地址）',
      WITH_DUMP ? '配置树两视角已采集（--with-config-dump）' : '配置树两视角未采集（P1 默认关）',
    ],
  }

  // manifest 自身也过脱敏（含 prodHome / sections[].source 这类路径字段）
  manifest = deepRedact(manifest)
  manifest.redaction = redactionStats()

  if (!DRY) {
    fs.mkdirSync(caseDir, { recursive: true })
    fs.writeFileSync(path.join(caseDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    const state = {
      schemaVersion: 1, caseId, phase: 'collected', startedAt: manifest.createdAt,
      updatedAt: new Date().toISOString(), mode: 'manual-p1', prodTouched: false,
    }
    const tmp = path.join(caseDir, 'state.json.tmp')
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, path.join(caseDir, 'state.json')) // 原子写（G12）
  }

  out('  ── 采集结果 ──')
  for (const s of sections) {
    out(`   ${s.missing ? '[missing]' : '[ok]     '} ${s.id.padEnd(16)} ${s.source}`)
    if (s.missing && s.note) out(`              ↳ ${s.note}`)
    else if (s.bytes != null) out(`              ↳ ${s.file}（${s.bytes} B${s.lines ? `，${s.lines}/${s.totalLines} 行` : ''}）`)
  }
  out('')
  const rstats = redactionStats()
  out(`  脱敏：共替换 ${rstats.total} 处${rstats.total ? '（' + Object.entries(rstats.byRule).map(([k, v]) => `${k}×${v}`).join(', ') + '）' : ''}`)
  out(`  保留：${RETENTION_DAYS} 天（到期用 --prune 清理）`)
  if (DRY) out('  【dry-run】未写盘')
  else out(`  manifest：${path.join(caseDir, 'manifest.json')}`)
  out('')
  process.exitCode = 0
}
