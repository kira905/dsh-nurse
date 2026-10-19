# dsh-nurse · DSH 安全模式修复层（小护士）

> 当主实例起不来 / 行为可疑时，**不要在生产上摸黑改文件**。小护士给你一条隔离通道：
> 用**只含官方插件**的 profile + **独立 home** + **独立端口（3091）** 起一个安全实例，
> 采集现场 → 注入修复提案 → **白名单校验** → 执行（写前备份）→ 验收（生产能否起来）→
> **逐字节回滚**，全程留 case 状态与报告。
>
> 七个小工具 + 十三个库件，**零第三方运行时依赖**（只用 `node:` 内置模块）。

---

## ⚠️ 先读这段（比任何用法都重要）

### ① 七件里**只有三件**会拒绝未知参数

| 入口 | 未知参数 | 后果 |
|---|---|---|
| `nurse-orchestrate.mjs` | **报错 + 退出码 2** | 安全（fail-closed） |
| `restore-case.mjs` | **报错 + 退出码 2** | 安全 |
| `retention.mjs` | **报错 + 退出码 2** | 安全 |
| `collect-case.mjs` | **静默忽略，继续执行** | ⚠️ 会**真去采集**（写 case 目录） |
| `nurse-ctl.mjs` | **静默忽略，继续执行** | ⚠️ 会**真起 / 真停** 3091 实例 |
| `make-nurse-profile.mjs` | **静默忽略，继续执行** | ⚠️ 会**真写** `.dsh-safe/profiles/nurse` |
| `nurse-verify.mjs` | **静默忽略，继续执行** | ⚠️ 会**真写** evidence 目录 |

⇒ 对后四件，**先把参数照 §4 抄对**，没有 `--help` 可用（`nurse-orchestrate` /
`restore-case` 实现了 `-h` / `--help`，其余五件**没有**）。
本文件不在代码块里给帮助示例 —— 参数表就是唯一权威。

### ② 所有"会写"的动作都**默认 dry-run**（`--apply` 才真写）

`restore-case` / `retention` / `nurse-ctl start|stop` 都支持 `--dry-run`；
`restore-case` 与 `retention` 的 dry-run 是**写盘函数内部的第一道门**，不是 CLI 装饰。
⚠️ 例外：`collect-case` / `make-nurse-profile` / `nurse-verify` 的**采集与 profile 生成**没有
"只预检"以外的更强保护（`collect-case --dry-run` 只列计划）。

### ③ 它依赖几个**宿主专有件**，本仓**不附带**

- `dsh-butler` 内核（`lane-gate.mjs` / `autonomy-state.mjs` / `residue-reaper.mjs`）与
  `dsh-upgrade-silence.mjs`：**只按路径动态 import**（路径可由 `DSH_ROOT` / `DSH_BUTLER_LIB` 覆盖）。
  缺席时编排器**保守拒启**（`stage: 'lane-gate'` / `degrade-gate`，退出码 `3`）——这是刻意的 fail-closed，
  不是 bug。
- `lib/dsh-host-rpc.mjs` 里的**本机凭据解析**（读 `~/.dsh/.credentials.yaml`）**不发布**：
  公开版只带可发布的 RPC 客户端件 + `withDshHome()`；cookie 走
  **显式参数 `cookieSecret` → 环境变量 `DSH_RPC_COOKIE_SECRET` → 可选本机凭据件** 三路注入。

### ④ 平台

Windows 优先：`nurse-ctl` 经 `lib/guard-launcher.mjs` 用 `CreateProcessW` 起隐藏控制台实例；
`lib/powershell-exe.mjs` 选 PowerShell（**pwsh 7 优先**，5.1 兜底）。
Linux / macOS 上"起实例"相关动作未验证。

---

## 1. 它解决什么问题

主实例（生产 3080）出问题时，直接在生产上改配置/插件是危险动作：改错了没有回退路径，
也说不清"到底改了什么"。小护士把流程拆成**确定性动作 + 隔离验收**：

```
① 采集现场（只读、脱敏）            collect-case.mjs
①.5 接管声明（告诉守护鱼：修复中，别拉起）
② 起安全实例（official-only）       make-nurse-profile.mjs → nurse-ctl.mjs
③ 注入修复提案（--proposal 或 agent）
④ 白名单校验 + 写前备份             lib/proposal-guard.mjs
④.8 冒烟前置（上生产前过测试）       lib/smoke-gate.mjs
⑤ 验收（生产是否起来 / boot 载荷）    nurse-verify.mjs
⑥ 报告 + 终态 + SLI                 lib/butler-bridge.mjs
⑦ 失败 ⇒ 逐字节回滚                 restore-case.mjs
⑧ 保留期清理                        retention.mjs
```

编排器 `nurse-orchestrate.mjs` 把 ①–⑥ 串起来（每一步都写 case 状态，可断点续看）。

---

## 2. 仓库结构（全量文件，20 个）

```
dsh-nurse/
├── collect-case.mjs              # ① 现场包采集（只读 + 脱敏 + fail-open）
├── make-nurse-profile.mjs        # ② 从生产 profile 派生「只含官方 bundle」的 nurse profile
├── nurse-ctl.mjs                 # ② 安全实例起停（三条硬闸：home / 单次互斥 / 端口）
├── nurse-orchestrate.mjs         # 编排器（①-⑥ 全流程；fail-closed 闸门）
├── nurse-verify.mjs              # ⑤ 隔离实例验收（HTTP / boot 载荷 / 插件集 / 严格面零变化）
├── restore-case.mjs              # ⑦ 写前备份的逐字节回滚器（sha 双端核对）
├── retention.mjs                 # ⑧ case 保留期清理（默认 dry-run、不跟链接）
├── lib/
│   ├── butler-bridge.mjs         # 审计 / 告警 / 报告 / 知识库桥（可选内核，缺席即跳过）
│   ├── case-state.mjs            # case 状态机（原子写 + 预算 + SLI + 路径相对化）
│   ├── misfix.mjs                # 误修率判据（manual / recurrence / unknown）
│   ├── nurse-profile-report.mjs  # profile 报告解析 + 合法 heal 链接判定
│   ├── proposal-guard.mjs        # 提案白名单 + 写前备份 + 执行（fail-closed）
│   ├── redact.mjs                # 输出脱敏（键名 or 值形态双判据）
│   ├── restart-advisory.mjs      # 「建议重启」通道（只写待办，**绝不自动重启**）
│   ├── smoke-gate.mjs            # 冒烟前置判定（fail-closed，纯判定无副作用）
│   ├── guard-launcher.mjs        # 隐藏控制台 launcher（CreateProcessW，后代继承不可见控制台）
│   ├── guard-http.mjs            # HTTP 存活判据单一真源（2xx/3xx/401/403 = 活）
│   ├── powershell-exe.mjs        # PowerShell 解释器选择（pwsh 7 优先，5.1 兜底）
│   ├── dsh-rpc-client.mjs        # DSH Host HTTP RPC 客户端（可发布件；cookie 三路注入）
│   └── dsh-host-rpc.mjs          # 上面那个的薄壳 + withDshHome()（发布版，见 §5）
├── README.md
├── README.en.md
├── CHANGELOG.md
├── LICENSE
├── package.json
├── .gitignore
└── .gitattributes
```

---

## 3. 运行环境

- **Node.js ≥ 20**（用到 `fs.rmSync`、`structuredClone` 风格的现代 API；未在 18 上验证）
- **Windows**（起实例 / PowerShell 相关动作）
- 主包 `@deepseek-ai/dsh` 装在默认 npm 全局位置（`nurse-ctl` 用 `APPDATA/npm/node_modules/@deepseek-ai/dsh/lib/bin.js` 起实例；
  可用 `--home` / `--profile` 改道）
- **操作系统层面的东西本仓不安装**：`pwsh`、主包、`dsh-butler` 内核都要你自己准备好

### 环境变量

| 变量 | 含义 | 缺省 |
|---|---|---|
| `DSH_ROOT` | DSH 工作区根（`logs/`、`tools/` 所在） | `~/DSH` |
| `DSH_HOME` / `BUTLER_DSH_HOME` | DSH home（生产 `~/.dsh`；测试环境用它改道） | `~/.dsh` |
| `DSH_BUTLER_LIB` | `dsh-butler/lib` 目录（`audit.mjs` 等） | `<DSH_ROOT>/tools/dsh-butler/lib` |
| `DSH_SMOKE_SCRIPT` | 冒烟脚本绝对路径（`smoke-gate` 用；**不设 = unavailable ⇒ 拦截**） | 空 |
| `DSH_RPC_COOKIE_SECRET` | RPC cookie 签名密钥（base64；不给则尝试本机凭据件） | 空 |
| `DSH_NURSE_SAFE_ROOT` | 安全 home 根（`case-<ts>/` 落在这里） | `~/.dsh-safe` |
| `NURSE_SMOKE` / `NURSE_RESTART_ADVISORY` | `0` = 关回冒烟闸 / 建议重启通道 | 开 |

---

## 4. 命令（**唯一权威参数表**）

### 4.1 `collect-case.mjs` —— 现场包采集

| 参数 | 说明 |
|---|---|
| （无参数） | 采集到 `~/.dsh-safe/case-<ts>/` |
| `--dry-run` | 只列将采集什么 |
| `--tail <n>` | 日志尾行数（缺省 400） |
| `--days <n>` | 时间窗（缺省 7） |
| `--prune` | 顺手清理超过 retention 的 case 目录 |
| `--with-config-dump` | 额外采集配置树（默认关） |

退出码：`0` 成功 · `1` 环境错误 · `2` 用法或硬闸拒绝。**未知参数被忽略。**

### 4.2 `make-nurse-profile.mjs` —— 派生安全 profile

| 参数 | 说明 |
|---|---|
| （无参数） | 从 `~/.dsh/profiles/web` 派生出 `~/.dsh-safe/profiles/nurse`（只保留 `@deepseek-ai/` bundle） |
| `--dry-run` | 只看计划 |
| `--modules <self-links\|junction-prod\|none>` | 依赖目录建法（缺省 `self-links`） |
| `--home <path>` | 目标 home（必须在 `~/.dsh-safe` 之下） |
| `--source <dir>` | 生产 profile 目录 |

退出码：`0` 正常 · `1` 环境错误 · `2` 用法或硬闸拒绝（home 不在 `.dsh-safe` 下即拒）。

### 4.3 `nurse-ctl.mjs` —— 安全实例起停

| 命令 | 说明 |
|---|---|
| `status` | 打印实例状态（真 pid / launcher pid / 端口归属） |
| `start [--dry-run] [--port 3091] [--profile nurse] [--home <safeRoot>] [--cwd <dir>]` | 起实例 |
| `stop [--dry-run]` | 停实例 |

三条硬闸（fail-closed）：目标 home 必须在 `~/.dsh-safe` 之下；**单次互斥**（记录里任一 pid 存活 ⇒ 拒起）；
端口 `3091` 被占 ⇒ 明确报错；**端口 3080 一律拒绝**。停止闸：pid 必须既不是 3080 的 pid、命令行里又确实带 `.dsh-safe`，
否则拒停（绝不误杀）。

### 4.4 `nurse-orchestrate.mjs` —— 编排器（**有 `--help`，未知参数拒**）

| 参数 | 说明 |
|---|---|
| `--plan` / `--apply` | 只打印计划 / 真执行（真执行需 `--proposal` 或 `--inject llm`） |
| `--proposal <json>` | 离线提案（测试 / 人工） |
| `--inject llm` | 把修复任务注入安全实例，由其中的 agent 产出提案 |
| `--port <n>` | 安全实例端口（拒绝 3080；缺省 3091） |
| `--case <id>` | 续跑既有 case |
| `--safe-root <dir>` | 安全 home 根（缺省 `~/.dsh-safe`） |
| `--no-smoke` / `--smoke-script <path>` / `--allow-smoke-skip` | 冒烟闸相关 |
| `--no-silence` | 不动静默窗 |
| `--allow-degraded` | 降档态下仍放行（留痕） |
| `--json` | JSON 摘要 |
| `--help` / `-h` | 用法 |

退出码：`0` 成功 · `1` 失败 · `2` 用法 · `3` 环境/闸门（lane-gate / degrade-gate）。

### 4.5 `nurse-verify.mjs` —— 隔离实例验收

| 参数 | 说明 |
|---|---|
| （无参数） | 对运行中的实例取证：HTTP 判活 / boot 载荷 / 插件集全为官方包 / API 探针 / 严格面零变化 |
| `--baseline` | 采集隔离基线（写 evidence 目录） |
| `--safe-root <dir>` | 安全 home（同时决定证据目录与 cookie 的 home 口径） |
| `--attribution` | 对照归因实验（W1 不在场 / W2 在场） |
| `--port <n>` | 实例端口（缺省 3091） |

### 4.6 `restore-case.mjs` —— 逐字节回滚（**有 `--help`，未知参数拒**）

| 参数 | 说明 |
|---|---|
| `--case <dir>` 或 `--latest` | 指定 case / 取最新 |
| `--apply` | 真回滚（缺省 dry-run） |
| `--only <path>` | 只回滚某几个文件（可多次） |
| `--force` | 跳过部分拒绝条件（慎用） |
| `--no-audit` | 不写审计 |
| `--json` | JSON 摘要 |
| `--help` / `-h` | 用法 |

硬闸：备份副本 sha 与 manifest 不符 ⇒ 拒；目标/备份是链接 ⇒ 拒；只动 manifest 列出的文件；倒序回滚。

### 4.7 `retention.mjs` —— case 保留期清理（**未知参数拒**）

| 参数 | 说明 |
|---|---|
| （无参数） | 报告过期 case（默认 dry-run） |
| `--apply` | 真删；打默认 safeRoot（`~/.dsh-safe`）还必须带 `--allow-production` |
| `--safe-root <dir>` | 安全 home 根 |
| `--days <n>` | 保留天数（缺省 7） |
| `--json` | JSON 摘要 |

硬闸：待删目录必须落在 safeRoot 之下、名字以 `case-` 开头；safeRoot 自身不删；**不跟链接**（是链接 ⇒ 跳过 + 告警）。

---

## 5. 依赖件说明（**如实登记**）

| 件 | 随仓发布？ | 说明 |
|---|---|---|
| `lib/guard-http.mjs` | ✅ | 纯函数、零依赖、零 IO 的 HTTP 存活判据（2xx/3xx/401/403 = 活） |
| `lib/guard-launcher.mjs` | ✅ | 隐藏控制台 launcher（起实例用；只依赖 `node:`） |
| `lib/powershell-exe.mjs` | ✅ | PowerShell 选择器（pwsh 7 优先） |
| `lib/redact.mjs` | ✅ | 脱敏实现（与生态共享件同源） |
| `lib/dsh-rpc-client.mjs` | ✅ | RPC 客户端件（官方标注「可发布」：零 fs / 零凭据路径） |
| `lib/dsh-host-rpc.mjs` | ✅（**本仓薄壳**） | re-export 上面那件 + `withDshHome()`；**不含本机凭据解析** |
| `dsh-butler` 内核：`lane-gate` / `autonomy-state` / `residue-reaper` | ❌ | 运行时按 `<DSH_ROOT>/tools/dsh-butler/lib/*` 动态 import；**缺席 ⇒ 编排器 fail-closed 拒启** |
| `dsh-upgrade-silence.mjs` | ❌ | 同上（缺席 ⇒ 静默步骤标 warn，不阻断） |
| `dsh-firstaid/timeline.mjs` | ❌ | `collect-case` 采集时间轴时可选读取；缺失记 `missing=true` 继续 |
| `_test/`（11 个测试件） | ❌ | 断言绑死私有树结构与源码字面（含绝对路径），脱敏后必红 ⇒ 不随仓发布（见 §8） |

---

## 6. 隔离纪律（写死在实现里）

1. **home 硬闸**：所有写动作的目标 home 必须在 `~/.dsh-safe` 之下（可用 `DSH_NURSE_SAFE_ROOT` 改根）。
2. **端口硬闸**：拒绝 3080（生产）；3091 被占即报错，**不硬抢、不杀别人**。
3. **提案白名单**：只允许 `write` / `mkdir` / `copy`，路径必须在允许根内；注外/越界/超预算一律拒。
4. **写前备份**：每个被改的文件先落 `case-<ts>/before/` + sha256；回滚按 sha 双向核对。
5. **不跟链接**：junction / symlink 一律跳过或拒动（递归删/写会跟到别的树）。
6. **默认 dry-run**：`restore-case` / `retention` / `nurse-ctl`。
7. **不自动重启**：`restart-advisory` 只写「建议重启」待办；编排器源码里**不得**出现 `request-restart`。

---

## 7. 已知限制

- **没有 `--help` 的五件**（§4.1 / 4.2 / 4.3 / 4.5）：未知参数会被忽略 ⇒ 见文首警告。
- **内核缺席时编排器拒启**：这不是降级到"半功能"，是刻意保守（宁可不动）。
- **`smoke-gate` 缺省不可用**：必须设 `DSH_SMOKE_SCRIPT`，否则冒烟闸判 `unavailable` ⇒ 拦（除非 `--allow-smoke-skip` / `NURSE_SMOKE=0`）。
- **本机凭据件不发布**：没有它时必须显式给 `cookieSecret` / `DSH_RPC_COOKIE_SECRET`，否则对隔离实例取页面会 401。
- **未在非 Windows 平台验证**。
- **未随仓发布测试套件**（§8），所以"改一行就红"的守门要靠你自己的 CI。

---

## 8. 未随仓发布：`_test/` 测试套件（11 件）

原私有树里有一套 11 个测试件（`test-nurse-b6` / `p1` / `p2` / `p2a` / `http-alive` / `inject-llm` /
`profile-report` / `restart-advisory` / `smoke-gate` / `probe-with-log` / `s13-import-probe`）。
**不发布的原因（如实说）**：

1. 断言的**输入是私有树的字面**：多处用 `pathToFileURL('<DSH_ROOT>/…/lib/…')` 与
   "源码里必须出现某绝对 import" 这类断言 ⇒ 脱敏（改成相对 import）后**必然红**；
2. 其中 7 件直接引用被替换的依赖面（`../lib/dsh-host-rpc.mjs`、`nurse-orchestrate.mjs` 的内部常量）；
3. 它们属于"本机开发期守门"，不是运行能力。

⇒ 本仓发布的是**运行件**；测试套件需要随宿主私有树一起使用。

---

## 9. 许可

**AGPL-3.0 + 商业授权（双许可）**，全文见 [LICENSE](./LICENSE)。

个人 / 学习 / 开源项目：按 AGPL-3.0 自由使用与修改（衍生作品须同样开源）。
闭源 / 商业场景：需另行获取商业授权 —— **请通过本仓 Issue 联系**。

> **AGPL-3.0 本身不禁止商用**，它要求的是衍生作品同样开源；
> 「+ 商业授权」= 双许可（要么按 AGPL 开源、要么买商业授权）。

---

## 10. 相关仓

`dsh-butler-archive` · `dsh-diagnostics-extra` · `dsh-quality-toolkit` · `dsh-ops-toolkit` ·
`dsh-board-toolkit` · `dsh-memory-toolkit` · `dsh-imgtmpl` · `dsh-gongwen` ·
`dsh-api-balance-folded` · `dsh-notekit` · `dsh-host-adapter-client`（GitHub / Gitee 同名）。
