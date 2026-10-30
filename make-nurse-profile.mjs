#!/usr/bin/env node
// ============================================================
//  make-nurse-profile.mjs — 小护士「安全模式实例」profile 构建（P1 · 前置阻断项 T3）
//  ------------------------------------------------------------
//  方案：docs\小护士-安全模式修复层方案-20260911.md §4.1 / §8 P1（E1 阻断项）
//  做什么：从生产 profile（~/.dsh/profiles/web）派生一个**只含官方基础 bundle**的
//          nurse profile，落到 %USERPROFILE%\.dsh-safe\profiles\nurse。
//          「摘掉全部自研插件」不是靠黑名单，而是靠**白名单**：
//          只有 `@deepseek-ai/` 前缀的 bundle 会被保留 → 自研/第三方天然全被摘掉。
//
//  安全闸（G2 home 硬闸）：
//    · 目标 home 必须位于 %USERPROFILE%\.dsh-safe 之下，否则拒绝执行（退出码 2）
//    · 本脚本只写目标 home，绝不写 ~/.dsh（读取除外：只读生产 profile 的 package.json）
//
//  幂等：内容一致 → skip；junction 目标一致 → skip。重复跑不产生任何变更。
//  用法：
//    node make-nurse-profile.mjs --dry-run            # 只看计划
//    node make-nurse-profile.mjs                      # 执行（幂等）
//    node make-nurse-profile.mjs --modules none       # 不建依赖 fallback 目录
//    node make-nurse-profile.mjs --modules self-links # 默认：独立实体目录 + 逐项链接
//    node make-nurse-profile.mjs --home <path> --source <prod profile dir>
//  退出码：0 正常 / 1 环境错误 / 2 用法或硬闸拒绝
// ============================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { cliGuard } from './lib/cli-args.mjs'

// ---------- 常量 ----------
const HOME = os.homedir()
const SAFE_ROOT = path.join(HOME, '.dsh-safe')
const DEFAULT_SOURCE = path.join(HOME, '.dsh', 'profiles', 'web')
const MAIN_NM = path.join(
  process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'),
  'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules',
)
const KEEP_PREFIX = '@deepseek-ai/'

// ---------- 参数 ----------
const SPEC = {
  cmd: 'dsh-nurse-profile',
  summary: '从生产 profile 派生一个「只含官方基础 bundle」的安全模式 profile（白名单式：非官方包一律摘掉，不靠黑名单）。',
  usage: 'dsh-nurse-profile [--home <目录>] [--source <目录>] [--modules self-links|junction-prod|none] [--dry-run] [--force]',
  flags: [
    { name: '--home', arg: '目录', desc: '目标 home（必须在用户目录下的 .dsh-safe 之内，否则拒跑）' },
    { name: '--source', arg: '目录', desc: '派生源 profile（默认生产 web profile）' },
    { name: '--modules', arg: '模式', desc: '依赖链接方式：self-links / junction-prod / none' },
    { name: '--dry-run', desc: '只打印将写什么，不建目录' },
    { name: '--force', desc: '目标已存在时覆盖重建' },
  ],
  writes: '在目标 home 下建 profiles/<名> 目录、写 package.json 并建模块链接；带 --force 会覆盖既有目标。生产 profile 只读。',
  dryRun: '加 --dry-run 只打印计划，不写文件。',
  exits: '0 成功 · 1 派生源缺失等前置失败 · 2 home 硬闸拒绝 / 未知 --modules 值 / 参数错误',
  examples: ['dsh-nurse-profile --dry-run', 'dsh-nurse-profile --modules none'],
};
const argv = cliGuard(SPEC)
const hasFlag = (n) => argv.includes('--' + n)
const optVal = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const DRY = hasFlag('dry-run')
const TARGET_HOME = path.resolve(optVal('home', SAFE_ROOT))
const SOURCE = path.resolve(optVal('source', DEFAULT_SOURCE))
const MODULES_MODE = optVal('modules', 'self-links') // self-links | junction-prod | none
const FORCE = hasFlag('force')

const out = (s) => process.stdout.write(s + '\n')
const die = (msg, code = 1) => { out(`[FAIL] ${msg}`); process.exit(code) }

// ---------- G2 home 硬闸 ----------
const rel = path.relative(SAFE_ROOT, TARGET_HOME)
const insideSafe = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
if (!insideSafe) {
  die(`home 硬闸拒绝：目标 home「${TARGET_HOME}」不在「${SAFE_ROOT}」之下（G2 fail-closed，退出码 2）`, 2)
}
if (TARGET_HOME === path.join(HOME, '.dsh')) die('home 硬闸拒绝：目标是生产 home', 2)
if (!['self-links', 'junction-prod', 'none'].includes(MODULES_MODE)) {
  die(`未知 --modules 模式「${MODULES_MODE}」（可选 self-links | junction-prod | none）`, 2)
}
if (!fs.existsSync(SOURCE)) die(`派生源 profile 不存在：${SOURCE}`, 1)

// ---------- 读派生源 ----------
let srcPkg
try {
  srcPkg = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package.json'), 'utf8'))
} catch (e) {
  die(`读派生源 package.json 失败：${e.message}`, 1)
}
const srcBundles = srcPkg?.dsh?.profile?.bundles ?? []
if (!Array.isArray(srcBundles) || !srcBundles.length) die('派生源没有 dsh.profile.bundles', 1)

const keptBundles = srcBundles.filter((b) => typeof b === 'string' && b.startsWith(KEEP_PREFIX))
const droppedBundles = srcBundles.filter((b) => !keptBundles.includes(b))
const offBundles = keptBundles.filter((b) => {
  const p = path.join(MAIN_NM, ...b.split('/'))
  return !fs.existsSync(p)
})

// ---------- 计划内容 ----------
const profileDir = path.join(TARGET_HOME, 'profiles', 'nurse')
const modulesDir = path.join(TARGET_HOME, 'profiles', 'node_modules')
const prodModulesReal = (() => {
  try { return fs.realpathSync(path.join(HOME, '.dsh', 'profiles', 'node_modules')) } catch { return null }
})()

const pkg = {
  name: 'dsh-profile-nurse',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: keptBundles } },
}
const pkgText = JSON.stringify(pkg, null, 2) + '\n'

const cordisYml = [
  '# dsh profile root — an empty entry list. The tree is composed as patches:',
  '# each bundle in package.json\'s dsh.profile.bundles, then cordis.patch.yml, then any',
  '# --patch overlays. Edit cordis.patch.yml, not this file.',
  '[]',
  '',
].join('\n')

const cordisPatch = [
  '# 小护士安全实例（nurse profile）用户层 patch —— 保持最小：不加载任何自研插件。',
  '# 由 tools\\dsh-nurse\\make-nurse-profile.mjs 生成（幂等，勿手工改后指望它保留）。',
  '[]',
  '',
].join('\n')

const meta = {
  schemaVersion: 1,
  kind: 'nurse-profile',
  generatedAt: new Date().toISOString(),
  generator: 'tools/dsh-nurse/make-nurse-profile.mjs',
  derivedFrom: SOURCE,
  derivedFromBundles: srcBundles.length,
  keptBundles,
  droppedBundles,
  modulesMode: MODULES_MODE,
  modulesTarget: MODULES_MODE === 'junction-prod' ? prodModulesReal : MODULES_MODE === 'self-links' ? MAIN_NM : null,
  planDoc: 'docs/小护士-安全模式修复层方案-20260911.md',
}

// ---------- 写文件（幂等） ----------
const actions = []
function writeIfChanged(file, text, label) {
  const exists = fs.existsSync(file)
  const old = exists ? fs.readFileSync(file, 'utf8') : null
  if (old === text) { actions.push({ action: 'skip', label, file }); return }
  if (DRY) { actions.push({ action: exists ? 'update' : 'create', label, file }); return }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  actions.push({ action: exists ? 'update' : 'create', label, file })
}

function ensureDir(dir, label) {
  if (fs.existsSync(dir)) { actions.push({ action: 'skip', label, file: dir }); return }
  if (DRY) { actions.push({ action: 'create', label, file: dir }); return }
  fs.mkdirSync(dir, { recursive: true })
  actions.push({ action: 'create', label, file: dir })
}

function ensureJunction(dir, target, label) {
  if (fs.existsSync(dir)) {
    let cur = null
    try { cur = fs.lstatSync(dir).isSymbolicLink() ? fs.readlinkSync(dir) : null } catch { /* keep null */ }
    if (cur && path.resolve(cur) === path.resolve(target)) {
      actions.push({ action: 'skip', label, file: dir, target })
      return { ok: true, skipped: true }
    }
    if (!FORCE) {
      // N-9：conflict 必须带上**实际链接目标**，否则报告只知"哪条冲突"不知"指向哪"，
      // 无法判断它是不是 dsh 启动 heal 补的合法链接（见 lib/nurse-profile-report.mjs 判据）。
      actions.push({ action: 'conflict', label, file: dir, actual: cur, note: '已存在且不是期望的链接（用 --force 替换）' })
      return { ok: false }
    }
    if (!DRY) {
      try { fs.rmSync(dir, { recursive: false, force: true }) } catch (e) {
        actions.push({ action: 'error', label, file: dir, note: `无法移除旧链接：${e.message}` })
        return { ok: false }
      }
    }
  }
  if (DRY) { actions.push({ action: 'junction', label, file: dir, target }); return { ok: true } }
  try {
    fs.symlinkSync(target, dir, 'junction')
    actions.push({ action: 'junction', label, file: dir, target })
    return { ok: true }
  } catch (e) {
    actions.push({ action: 'error', label, file: dir, note: `建链接失败：${e.message}（360 企业 EDR 可能拦截，需手动点「允许本次操作」）` })
    return { ok: false }
  }
}

// 1) profile 目录与三件套
ensureDir(profileDir, 'profile 目录')
writeIfChanged(path.join(profileDir, 'package.json'), pkgText, 'package.json')
writeIfChanged(path.join(profileDir, 'cordis.yml'), cordisYml, 'cordis.yml')
writeIfChanged(path.join(profileDir, 'cordis.patch.yml'), cordisPatch, 'cordis.patch.yml')

// 2) 依赖 fallback 目录（解析 @deepseek-ai/dsh-base 等官方 bundle）
let modulesResult = { ok: true, skipped: true }
if (MODULES_MODE === 'junction-prod') {
  if (!prodModulesReal) {
    actions.push({ action: 'error', label: 'profiles/node_modules', file: modulesDir, note: '找不到生产 profiles/node_modules（junction-prod 模式不可用）' })
    modulesResult = { ok: false }
  } else {
    modulesResult = ensureJunction(modulesDir, prodModulesReal, 'profiles/node_modules → 生产依赖闭包（只读共享）')
  }
} else if (MODULES_MODE === 'self-links') {
  // 独立实体目录：目录本身是本地真实目录，逐项 junction 指向主包自带依赖
  // （这样 dsh 的 heal 写的是本实例自己的目录，不会污染生产依赖闭包）
  if (!fs.existsSync(MAIN_NM)) {
    actions.push({ action: 'error', label: 'profiles/node_modules', file: modulesDir, note: `找不到主包依赖目录：${MAIN_NM}` })
    modulesResult = { ok: false }
  } else {
    ensureDir(modulesDir, 'profiles/node_modules（独立实体目录）')
    const entries = fs.readdirSync(MAIN_NM).filter((n) => n !== '.bin' && n !== '.package-lock.json')
    let made = 0, kept = 0, failed = 0
    for (const name of entries) {
      const src = path.join(MAIN_NM, name)
      const dst = path.join(modulesDir, name)
      if (name.startsWith('@')) {
        // scoped：建 scoped 目录 + 逐包链接
        if (!DRY) fs.mkdirSync(dst, { recursive: true })
        for (const sub of fs.readdirSync(src)) {
          const r = ensureJunction(path.join(dst, sub), path.join(src, sub), `deps ${name}/${sub}`)
          if (r.ok && r.skipped) kept++; else if (r.ok) made++; else failed++
        }
      } else {
        const r = ensureJunction(dst, src, `deps ${name}`)
        if (r.ok && r.skipped) kept++; else if (r.ok) made++; else failed++
      }
    }
    actions.push({ action: 'summary', label: 'profiles/node_modules 链接统计', note: `新增 ${made} / 已存在 ${kept} / 失败 ${failed}` })
    modulesResult = { ok: failed === 0, made, kept, failed }
  }
} else {
  actions.push({ action: 'skip', label: 'profiles/node_modules（none 模式：交给 dsh 自建 fallback）', file: modulesDir })
}

// 3) meta 记录（G12 状态文件登记）
//    generatedAt 变化不算内容变化：除它以外全等 → 保留旧文件（严格幂等，复跑零变更）
const metaFile = path.join(TARGET_HOME, 'nurse-profile.json')
let metaText = JSON.stringify(meta, null, 2) + '\n'
if (fs.existsSync(metaFile)) {
  try {
    const oldMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    const strip = (o) => {
      const c = JSON.parse(JSON.stringify(o))
      delete c.generatedAt
      return JSON.stringify(c)
    }
    if (strip(oldMeta) === strip(meta)) metaText = fs.readFileSync(metaFile, 'utf8')
  } catch { /* 旧文件损坏 → 按 update 处理 */ }
}
writeIfChanged(metaFile, metaText, 'nurse-profile.json')

// ---------- 输出 ----------
out('============================================================')
out(' 小护士 nurse profile 构建（P1 · T3）')
out('============================================================')
out(`  目标 home    : ${TARGET_HOME}`)
out(`  profile 目录 : ${profileDir}`)
out(`  派生源       : ${SOURCE}`)
out(`  依赖模式     : ${MODULES_MODE}`)
if (MODULES_MODE === 'junction-prod' && prodModulesReal) out(`  链接目标     : ${prodModulesReal}`)
if (MODULES_MODE === 'self-links') out(`  链接目标     : ${MAIN_NM}`)
out(`  ${DRY ? '【dry-run】' : ''}保留 bundle ${keptBundles.length} 个 / 摘掉 ${droppedBundles.length} 个`)
out('')
out('  ── 保留（白名单 @deepseek-ai/）──')
for (const b of keptBundles) out(`    + ${b}`)
out('  ── 摘掉（自研/第三方，V1 要求零加载）──')
for (const b of droppedBundles) out(`    - ${b}`)
out('')
const byLabel = {}
for (const a of actions) {
  const k = `${a.action}`
  byLabel[k] = (byLabel[k] || 0) + 1
}
// N-9：error / conflict 明细**不得被过滤** —— `deps ` 开头的 label 恰恰承载这些明细，
// 旧版一刀切过滤 ⇒ 只报「FAIL（N 项错误）」却看不到是谁（现场取证无从下手）。
const shown = actions.filter((a) => !a.label.startsWith('deps ') || a.action === 'error' || a.action === 'conflict')
for (const a of shown) {
  out(`  [${a.action}] ${a.label}${a.note ? ' — ' + a.note : ''}`)
  // target = 期望目标（junction/skip）；actual = 现存链接的实际指向（conflict 专用）
  const tgt = a.target ? ` → ${a.target}` : (a.actual ? ` →（实际）${a.actual}` : '')
  out(`        ${a.file}${tgt}`)
}
const linkActions = actions.filter((a) => a.label.startsWith('deps '))
if (linkActions.length) {
  out(`  [deps] profiles/node_modules 逐项链接：共 ${linkActions.length} 条（新增/已存在明细见上「链接统计」）`)
}
out('')
if (offBundles.length) {
  out(`  [warn] 以下 bundle 在主包依赖目录里找不到实体，启动可能失败：${offBundles.join(', ')}`)
}
const errs = actions.filter((a) => a.action === 'error' || a.action === 'conflict')
out(`  结果：${errs.length ? 'FAIL（' + errs.length + ' 项错误）' : DRY ? 'DRY-RUN OK' : 'OK'}`)
out(`  统计：${Object.entries(byLabel).map(([k, v]) => `${k}=${v}`).join(' ')}`)
out('')

process.exitCode = errs.length ? 1 : 0
