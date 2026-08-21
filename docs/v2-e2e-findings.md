# Runtime v2 真实 E2E 问题台账

本台账记录 2026-08-20 使用 OpenCode 1.18.18、DeepSeek V4 Flash 与 GPT-5.6 Luna、无 OMO 配置进行 V2-8 真实网关验证时发现的问题。它用于后续回归与根因分析，不替代 Roadmap 或自动化测试结果。

状态含义：`已修复` 表示已有实现和自动化回归；`已实测` 表示修复后真实链路再次通过；`待分析` 表示尚未确认归属或修复。

| ID | 现象与影响 | 根因 | 处理与回归证据 | 状态 |
| --- | --- | --- | --- | --- |
| E2E-01 | 重启后处于人工等待的任务可能继续预检或派单 | `runToStable` 在检查已签发人工决定前仍执行推进逻辑 | 人工等待成为首个硬边界；`task-driver.test.mjs` 覆盖重启场景 | 已修复、已实测 |
| E2E-02 | 规划 Owner 未看到“工作包数量”等用户约束，拓扑偏离目标 | 成员上下文只注入目标，没有注入 `constraints/exclusions` | Context Composer 注入约束与排除项；最终任务按约束生成单工作包 | 已修复、已实测 |
| E2E-03 | code-review 的每个 Owner 都被要求覆盖全部八个视角，成本高且与分包冲突 | 审查视角错误地下沉到每个 Owner | Owner 只负责工作包；统一 Challenger 验证八个视角；Policy Compiler 回归覆盖 | 已修复、已实测 |
| E2E-04 | Expert 提交了有效 verdict 证据，但顶层 `evidence_refs` 为空而被拒 | 平台报告形状与 Runtime 顶层证据约束不一致 | 将 findings/verdict 中的稳定证据提升到顶层，并规范化已知裸 report ID | 已修复、已实测 |
| E2E-05 | Challenger/Expert 或无写权限的 Owner 回应重复上报已有 artifacts，触发输出不匹配 | 是否保留 artifacts 只按角色判断，没有按 `writableRefs` 判断 | 只有有可写引用的 Owner 可提交 artifacts；其余 artifacts 被适配层剥离 | 已修复、已实测 |
| E2E-06 | 运行中的子会话遇到可重试网关错误后成为永久 blocker | `retryable error` 没有进入失联恢复分支 | Driver 将其映射为 `execution-lost`，使用新会话和恢复上下文重派 | 已修复、自动化通过 |
| E2E-07 | Owner 回应被要求引用 Challenger/Expert 报告，但派单中没有报告 ID 或结论 | 报告 ID 只能在依赖完成后产生，静态工作图无法提前写入 | 派发时动态注入已接受 report ID、受限摘要、findings 与 verdict；同会话回应一次通过 | 已修复、已实测 |
| E2E-08 | 成员重复读取已内嵌的 context/prompt，拼错 task-id 后扫描文件系统根目录并长时间 busy | 派单没有明确说明上下文已内嵌，也未禁止项目外 glob/search | 明确禁止重读 context/prompt、扫描 `.team-work`、项目外路径和根目录；失控会话中止后由 Runtime 新会话恢复 | 已修复、已实测 |
| E2E-09 | Owner/Challenger 把“产品代码有缺陷”写成 `recommendation=rework`，即使审查制品本身正确 | recommendation 的评价对象没有明示 | 统一定义 recommendation 只评价当前派单交付；产品风险进入 findings/unresolved | 已修复、已实测 |
| E2E-10 | DeepSeek 把 `artifacts[].ref` 写成裸 `code-review`；失败后用最小探针试错，探针占用正式报告幂等键 | 工具说明不够具体，适配层只接受完整 `artifact:` 引用 | 对派单内已知裸 artifact/report ID 安全规范化；工具 schema 给出完整格式并禁止探针提交 | 已修复、已实测 |
| E2E-11 | 最后一个成员已报告完成，但 OpenCode 状态短暂仍为 busy，人工门禁第一次 quiesce 进入可恢复 blocker | 报告事件先于宿主会话 idle 状态，存在正常尾部竞态 | 首次 quiesce 主动 abort 仍 busy/retry 的受管成员，再复核一次状态；Adapter 回归覆盖；新任务 `task-1ccc2683d4` 实测成员全部接受后一次 quiesce 直接激活 final-acceptance | 已修复、已实测 |
| E2E-12 | 长会话多次 attach/run 后出现 `MaxListenersExceededWarning`，任务仍可继续 | 尚未确认是 OpenCode Server/EventSource 监听器累积，还是插件等待监听器未释放 | 保留日志现象；终审时检查插件 listener 生命周期，并在最小复现中区分上游/插件 | 待分析 |
| E2E-13 | CLI 只显示 `workflow_run Unknown`，无法从工具行判断返回卡片类型 | OpenCode TUI 对该插件工具结果的标题/状态展示不足 | 不影响 Runtime 状态；需要确认插件可否提供更明确 metadata，或提交 OpenCode 上游问题 | 待分析 |
| E2E-14 | 最终验收后 Lead 再次调用 `run`，任务已完成却报“当前阶段未准备完成” | `runToStable` 在底层 Driver 返回 `completed` 后仍重复执行制品收尾 | 终态作为幂等硬边界，重复 `run` 直接返回 completed ActionCard；Runtime Facade 回归与真实 OpenCode 重复调用均通过 | 已修复、已实测 |
| E2E-15 | 创建任务时即使明确要求省略 `task_id`，Luna 仍连续自动填充 `"new"` | 单一工具用可选字段隐含 create/resume 分支，供应商结构化参数填充不稳定 | `workflow_open` 增加必填 `mode=create|resume`；create 安全忽略无关 task_id，resume 才使用 task_id；Luna 真实调用成功创建并进入规划 | 已修复、已实测 |
| E2E-16 | 从 code-review 介入并把已有 `CODE_REVIEW.md` 同时作为本轮输出时，Owner 连续三次被拒绝为“注册输入在可写范围外变化” | 已有制品总是分配 `input-*` ID，而阶段输出使用 canonical `artifact:code-review`，同一路径被错认为两个制品 | 当入口阶段某输出类型只有一个项目文件时，直接注册为 canonical 可写制品；Runtime Facade 覆盖原地修订；`task-2498bfb5ac` 与 `task-1ccc2683d4` 两个真实任务 Owner 原地修订一次通过 | 已修复、已实测 |
| E2E-17 | Challenger（Luna）对无写权限派单越权 `apply_patch` 修改 Owner 制品 `CODE_REVIEW.md`；Runtime 能检测并拒绝后续报告，但没有内容快照可恢复，导致同角色重派永远失败 | 平台层未强制派单写边界；任务只持久化制品 digest，不保留内容 | 三层修复：Plugin Hook 按 `writableRefs` 拦截成员 `edit/write/apply_patch`（含项目内绝对路径归一化）；任务创建与报告接受时把制品内容快照落盘 `.team-work/artifacts/`；检测到受保护制品被改时自动恢复最后注册内容并拒绝本轮报告。Facade 恢复回归、Hook 写边界、仓库快照测试覆盖；新任务实测全程无越权写、Owner 正常编辑可写制品 | 已修复、已实测 |
| E2E-18 | `install --force` 冒烟检查报 `SMOKE_TEST_FAILED`（`debug config` 空输出）并回滚；此前 `agent list` 时代记录的“plugins settling 部分列表”也是同一根因的误诊 | OpenCode 可执行文件被 Node 直接 spawn 时，stdout 无论管道还是文件都会在约 64KB 处截断（上游缺陷）；team Agent 恰好排在截断点之后 | smoke 经平台 shell（`sh`/`cmd.exe`）包裹并重定向到临时文件再解析；本机正式安装与 E2E 隔离安装、doctor 全部实测通过 | 已修复、已实测 |
| E2E-19 | 在含 v1 遗留 `.team-work/`（`config.yaml`/`task.json`，无 v2 `project.json` 标记）的项目里打开 OpenCode，每次会话注入都报 `Cannot resolve Runtime project marker safely`，阻塞 standalone 使用（违反契约第 14 条） | 标记解析把 ENOENT（未初始化/遗留）与真实损坏一律包装为 `STATE_CORRUPT` 抛出；被动 Hook（上下文注入、工具前置、事件）没有容忍层 | 分层容错：标记缺失上报独立错误码 `PROJECT_MARKER_MISSING`；被动探测对整个标记错误族返回 null 且零写入；显式工作流入口（open/plan/run/steer）把标记族失败转成修复询问卡片（缺失仍由 `initializeProjectRuntime` 自愈，v1 数据不动）；CLI 错误输出附修复提示。版本契约、适配器探测、Host 修复卡片、CLI 提示测试覆盖；真实 v1 遗留项目（Hmail）只读实测被动链零报错零写入，副本实测 `workflow_open` 自愈建标记且 v1 文件逐字节不变 | 已修复、已实测 |
| E2E-20 | 真实任务（Hmail，entry=research 未带 requirement）在 `workflow_plan` 反复报 `plan result does not match the Runtime v2 contract`（44 次），模型无法自诊断，最终自行 `rm -rf` 任务目录并留下悬挂绑定（会话每条消息报 `task does not exist`） | 三层叠加：(1) plan 先固化 taskIntent，后续修改抛 `TASK_INTENT_CONFLICT`；(2) facade 兜底把任意错误码塞进 problem 卡，而 problemCard code 是封闭枚举——未知码生成非法卡、以 schema 错误形式**掩盖真实错误**；(3) resume 不注册 `existing_artifacts` 且 `ENTRY_UNSATISFIED` 无补输入指引，模型只能猜测（把 requirement 写进运行时快照目录再 resume 无效） | (1) `problem()` 工厂收敛未知码到 `PLAN_INVALID` 并在 message 保留原始错误码；(2) `TASK_INTENT_CONFLICT` 显式映射为带恢复指引的合法卡；(3) `ENTRY_UNSATISFIED` impact 写明"制品只能创建时登记，无法补齐请重建任务"；(4) `workflow_open` 工具描述说明 existing_artifacts 仅 create 生效；(5) `describeSession` 容忍绑定任务被外部删除（返回 null，被动 Hook 不再抛）。沙箱按真实序列（db 原始参数）复现并验证修复；facade 两回归 + host 容忍测试覆盖；全量 630/630。遗留：固化 intent 且无待决策的任务是死局（无受控意图修订入口），只能重建——记录为后续设计议题 | 已修复、已复现验证 |

## 本轮终验结果

- 干净任务：`task-9b4de68cd8`，从 `code-review` 任意阶段介入，through-stage 到 `code-review`。单 Owner、Senior Challenger、Expert、同会话 Owner 回应；用户授权一次定向追加轮次后一致，`accept` 收敛 `completed`。
- 队列恢复任务：`task-2498bfb5ac`，Owner 报告经进程重启后从持久队列消费并接受（E2E-16 原地修订一次通过）；随后 Challenger 越权写污染制品（E2E-17），该任务创建于内容快照修复之前、无恢复来源，保留现场作为台账证据，不再续跑。
- 门禁复验任务：`task-1ccc2683d4`，全新任务从 `code-review` 介入，Challenger/Expert/Owner 回应使用低成本模型（Luna/DeepSeek）一轮收敛，四份报告全部接受后一次 quiesce 激活 `final-acceptance`（E2E-11），用户明确选择 `accept`，状态 `completed`，累计成本 64。
- 本轮同时落地：用户配置改为 role 驱动目录（junior/senior/expert/challenger/assistant，challenger 回退 senior、assistant 回退 junior），能力快照 digest 公式保持兼容，`task-2498bfb5ac` 钉住的目录跨升级复现一致。

## V2-8 覆盖矩阵

| 能力 | 真实 OpenCode/网关 | 确定性自动化 | 结论 |
| --- | --- | --- | --- |
| DeepSeek/Luna 工具与后台派发 | 文本、检索、修改、双成员、续派已通过 | Adapter 与控制面 E2E | 通过 |
| 正式 Team-work | Owner、Senior Challenger、Expert、Owner 回应和多轮收敛已通过 | 完整 Workflow 与分支矩阵 | 通过 |
| 人工门禁 | 新旧任务最终 accept、一次 quiesce 进入门禁与终态幂等均已通过 | 决定凭证、并发、过期制品和 quiesce 矩阵 | 通过 |
| 宿主重启 | 同一 child session 续派，人工等待任务恢复 | 重启对账、in-doubt inspect | 通过 |
| 完整 Workflow 与 OpenSpec | 本轮未用真实模型跑完全阶段 | Fake SPEC 四路径、OpenSpec Provider 集成、全 Workflow E2E | 自动化通过，不冒充真实全流程 |
| 网关错误与成员失联 | 真实网关连通与跨进程恢复 | retryable error、execution-lost、重派和幂等矩阵 | 故障注入通过；未主动消耗供应商限流 |

## 后续跟踪规则

1. 每个真实 E2E 新问题先记录现场症状和任务阶段，再判断是模型、PlatformPlugin、CoreRuntime 还是 OpenCode 上游。
2. 已修复项必须同时有自动化回归；高风险状态机/门禁问题还要在下一次真实 E2E 中复验。
3. 临时 `/tmp` 任务目录不是长期证据源；稳定证据必须落到测试、本文或 `docs/validation/`。
