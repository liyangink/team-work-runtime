# team-work-runtime

> DSH 里的虚拟研发团队：一句话派活，Owner 干活、Challenger 挑错、Expert 裁决，人工门把关，全程留痕、随时恢复。

在 DSH 对话里说一句“审查这段代码”或“设计并实现这个功能”，`team-work` skill 会组建一支虚拟研发团队，按机器可读的研发流程分阶段推进任务。成员各司其职、互相制衡；方案审查与最终验收两道人工门必须由你确认；所有状态落在你项目的 `.team-work/` 目录里，随时中断、随时继续。

## 功能特性

- 🎯 **对话即派活**：用自然语言提出研发需求（审查、设计、实现、测试、迁移……），自动判断阶段入口、组团与审查强度，无需了解内部流程。
- 👥 **分工制衡的虚拟团队**：Owner 交付、Challenger 挑错、Expert 裁决；全员非作者评审，作者不自审。
- 🚧 **人工门把关**：方案审查（design-approval）与最终验收（final-acceptance）两道人工门，批准绑定制品指纹，制品改动后需重新确认。
- 💤 **随时中断恢复**：状态全在项目 `.team-work/tasks/` 目录，关掉会话、重启设备后接着推进，不丢上下文。
- 🧾 **全链路留痕**：每次交付、每条评审意见、每个人工决定、每个路由依据都落盘，可追溯、可审计。
- 💰 **三档成本可控**：junior / senior / expert 三档映射到模型——常规活默认廉价档，高风险环节自动升档并要你审批。
- 🧩 **并行施工**：多个可独立验收的改动自动拆包并行，互斥写范围避免互相踩踏。
- 🛡️ **越界兜底**：成员只能写派单声明的路径；越界写入被当场拒绝，被污染的产出物可一键恢复快照。
- 📦 **数据留在本地**：任务数据全部在项目里，不锁云；Runtime 零第三方运行时依赖。

## 快速开始

### 1. 安装

`1.0.9` 适配 DSH `0.2.0-rc.2`，尚未发布到市场；当前市场版本不代表已包含以下新版适配。根包 `team-work-runtime` 是唯一市场制品，包含 CLI、Runtime、skill 和 DSH 绑定。

**方式一：DSH 市场**：在市场搜索并安装 `team-work-runtime`；使用新版适配前先确认安装包已包含本次变更。

**方式二：CLI 安装**（显式指定实际使用的 profile；以下 `profile-demo` 是脱敏占位名）：

```bash
dsh plugin --profile profile-demo add team-work-runtime     # 安装
dsh plugin --profile profile-demo remove team-work-runtime  # 卸载
```

**方式三：本地打包**（源码用户）：

```bash
npm pack   # 在仓库根执行，产出 team-work-runtime-<版本>.tgz
dsh plugin --profile profile-demo add ./team-work-runtime-<版本>.tgz   # 安装本地包，卸载命令同上
```

### 2. 配置三档模型（两分钟）

DSH Web → 插件配置 → `team-work-dsh`，给三个档位各挑一个模型。新版配置写入当前 profile：同一 profile 内所有项目共用 tiers，没有项目覆盖，也不自动同步其他 profile。

| 档位 | 干什么活 | 选模建议 |
| --- | --- | --- |
| `junior` | 常规实施、日常杂活 | 便宜够用的快模型 |
| `senior` | 方案设计、审查挑战 | 均衡可靠的模型 |
| `expert` | 高风险环节技术裁决 | 最强模型；最贵，只在裁决时上场 |

以下展示 tiers 的数据形状；示例模型需替换为该 profile 中实际可用的 provider/model：

```json
{
  "junior": [{ "provider": "provider-demo", "model": "model-lite" }],
  "senior": [{ "provider": "provider-demo", "model": "model-balanced", "effort": "high" }],
  "expert": [{ "provider": "provider-demo", "model": "model-reasoning" }]
}
```

空配置允许首次启动；开始配置后，三档必须齐全，每档兼容单对象或候选数组，provider/model 必填，family/effort 可选。派发优先错开模型家族；热更新只影响后续波次，已派发成员沿用 journal 中的精确模型快照。

页面按模型目录验证已列出的候选；未列出不代表模型不存在或不允许。客户端没有精确只读校验 RPC，未列出的候选会保留草稿并提示通过原生 `list_subagent_models` 按 provider+model 精确查询，不会谎报保存成功。正式成员创建前仍由宿主 `llm.resolveCallConfig` 核验真实模型与显式 effort。保存冲突或失败保留本地草稿，重新核对当前配置后再提交。

### 无宿主的终端输入

DSH 内的 `tw` 和 `tw-dispatch` 每次操作从插件 Config 取快照。无宿主终端由编排调用方显式提供同形状的 `TW_DSH_CONFIG` JSON，不再自动读取 home 下的 YAML，也不猜测 profile：

```bash
TW_DSH_CONFIG='{"entryId":"team-work-dsh","profile":"profile-demo","tiers":{"junior":{"provider":"provider-demo","model":"model-lite"},"senior":{"provider":"provider-demo","model":"model-balanced"},"expert":{"provider":"provider-demo","model":"model-reasoning"}}}' tw models
```

该变量只是本次调用输入，不含 provider 密钥，不写长期缓存；profile 无法确定时显式写 `unresolved`。缺输入、JSON 损坏或缺档时，选模命令给出修复指引；开任务、查状态、交付和评审等平台无关操作仍可使用。

### 从旧配置升级

升级前分别备份旧 `settings.yaml` 与当前 profile 配置。DSH 首次导入会先把旧文件改名为 `settings.yaml.imported`，再尝试写入同名 entry；该过程可能覆盖 profile 已保存的 tiers。已经改名但导入失败时，宿主不会自动再次导入：只取旧 tiers，核对模型后通过新页面保存。插件不从旧文件兜底、不删除旧配置。本次源码适配不直接更改用户 profile、升级宿主或重装插件。

### 3. 第一次使用

在 DSH 会话里直接说需求，例如：

> 审查一下 src/auth 最近三天的改动，重点看安全边界。

接下来自动发生：组建团队 → Owner 干活 → Challenger 挑错 →（核心环节）Expert 裁决 → 人工门请你确认。你只需要做两件事：**读摘要、做决定**——认可就批准，不满意就让它返工。

## 使用示例

### 一次代码审查的完整体验

```text
你：审查一下 src/auth 最近三天的改动，重点看安全边界。

团队：已开任务 review-auth，进入代码审查阶段。
      ① Owner 完成安全审查，交付报告。
      ② Challenger 逐条挑战，发现 2 处越权风险 → 要求修订一轮。
      ③ 修订后复审通过；Expert 裁决：通过。
      ④ E2E 适用性评估：纯静态改动，跳过（附依据）。

你：◀ 收到人工门卡片：审查结论摘要 + 风险清单。回复确认。

团队：任务完成。审查报告 CODE_REVIEW.md 已登记在任务档案。
```

- 有分歧时自主讨论最多三轮；三轮没收敛会把选项摆到你面前，你拍板。
- 随时可以说“目标改为……”或追加约束，任务按新目标调整。
- 全部记录（交付、评审意见、决定、路由依据）在 `.team-work/tasks/review-auth/`，随时可查。

### 多包并行

“把 auth 和 billing 两个模块都迁到新框架”这类多个可独立验收的目标，会自动拆成并行施工：多个 Owner 同时干活、互斥写范围防踩踏、评审按包归属精准返工。你只需在派活时讲清范围；复杂拆分会先出方案给你确认。

## 工作原理

### 房间与门

整个系统只有一条主线：**成员在房间里自由工作，检查只发生在两处**——交卷/阅卷的瞬间，和过门的瞬间。

```text
你（DSH 会话）
  │ 一句话派活
  ▼
Lead ──组建团队──▶ 成员子代理：Owner → Challenger → 核心环节 Expert
  │                    │ 交付/评审：当场同步检查，拒绝即带修复指引
  ▼                    ▼
任务目录 .team-work/tasks/<name>/ ◀── 唯一事实源（意图/报告/决定/日志/快照）
  │
  ▼
门：产出物在场 + 检查通过 + 非作者评审在场 + 人工确认（一处、确定性、必带恢复边）
```

### 三条设计信念

- **任务目录即状态**。没有藏在内存里的状态机：目录里有什么就是什么，任何判定都能由目录 + 流程定义重新推导。所以任务永远不会“卡死”，中断、重启、迁移后接着跑。
- **工具调用是唯一检查点**。每次交付/阅卷调用内做一次同步全量检查：accept/reject 连同全量原因与修复指引当场返回。没有异步拒绝，没有对成员不可见的第二层校验。
- **模型只供语义**。工具参数只收模型才知道的事实（做了什么、产出在哪、发现了什么）；ID、链接、簿记全部由引擎从目录推导——成员不会因为“忘了填报告 ID”这类琐事被拒。

### 四条协作铁律

- 作者不自审；每个工作单元都有非作者 Challenger 挑战，核心环节由非作者 Expert 作技术裁决。
- 每次拒绝都带 blocker、证据与恢复边——死门是缺陷。
- 自主讨论最多三轮，未收敛交你拍板；追加轮次需你授权。
- 人工门批准绑定制品指纹，制品变化即需重新确认；Agent 无权自行降级或代答。

## 架构一瞥

四块拼图，全部数据化：

| 模块 | 一句话 |
| --- | --- |
| **Workflow**（`workflow/definitions/`） | 研发路线图：阶段、合法流转边、门禁、SPEC/E2E 路由——改流程改数据，不改代码 |
| **Team-work**（`team-work/`） | 团队手册：哪个场景用哪档人、几轮收敛、审查视角、成本权重 |
| **CoreRuntime**（`runtime-v3/` + `bin/tw.mjs`） | 唯一引擎：波次推进、门禁推导、任务目录读写、交付/评审检查 |
| **DSH 绑定**（`dsh/`） | skill 装载、tw/tw-dispatch、精确模型派发与当前 profile 的插件配置页 |

> Runtime 不实现派发循环与 DAG 调度——编排是 DSH 平台职责；Runtime 只提供波次事实与验收。任务数据始终留在你项目的 `.team-work/`。

DSH 内正式成员的派发与续派由 `tw-dispatch` 自动登记；普通委派、`@junior` / `@senior` / `@expert`、成员在任务期间开的只读助手使用原生 `subagent`，继承历史用 `subagent_fork`。tiers 的 `effort` 在原生调用中转换为 `reasoning_effort`。原生选模受宿主开关与允许列表约束；模型枚举目录只是参考，可按 provider+model 精确查询，旧会话权限可能要新建会话后才生效。

原生后台 `continuable` 返回的 `subagentId` 是会话 ID，可用于 `send_message`；一次性后台的 `jobId` 和前台的 `runId` 不能当作续聊身份。宿主默认 `maxDepth=1`，若要允许正式成员再开只读助手，用户需允许至少两层；插件不自行提高限制，助手不得继续委托。

正式派单重试复用同一会话 ID，防重复创建；冷恢复能核对自身日志中的本轮正文，已收到则只发续行提醒，只有旧上下文则投增量，无上下文则投全量。这不承诺正文跨中断恰好投递一次。回执或读取不确定时保留已有 ID，按恢复提示核对。

`1.0.9` 全套 260 项通过，0 失败、0 跳过；Spec 与 Standards 独立复核通过。隔离 Web 的插件与三档配置表单加载、可见页面编辑/保存、官方 ConfigForms 空配置/完整配置往返、打包检查均通过。真实 LLM、跨进程续聊、最终页面和徽标视觉仍待用户验收，尚未发布到市场；详见 [新版适配方案](docs/dsh-020-adaptation-plan.md)。

## 更多资料

- [AGENTS.md](AGENTS.md)：产品边界与完整规则（仓库契约事实源）
- [docs/runtime-v3-charter.md](docs/runtime-v3-charter.md)：设计原则（P1–P6）与产品不变量（I1–I10）验收规约
- [docs/runtime-roadmap.md](docs/runtime-roadmap.md)：开发进度与里程碑
- [skills/team-work-v3/references/](skills/team-work-v3/references/)：拓扑与成本、场景指导、DSH 编排（skill 深度资料）
