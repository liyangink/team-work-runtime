# Runtime v2 真实 E2E 问题台账

本台账记录 2026-08-20 使用 OpenCode 1.18.18、DeepSeek V4 Flash 与 GPT-5.6 Luna、无 OMO 配置进行 V2-8 真实网关验证时发现的问题。它用于后续回归与根因分析，不替代 Roadmap 或自动化测试结果。

状态含义：`已修复` 表示已有实现和自动化回归；`已实测` 表示修复后真实链路再次通过；`待分析` 表示尚未确认归属或修复。

> 文件名为历史引用保留。`E2E-01` 至 `E2E-20` 是 v2 历史台账；2026-08-27 起发现的 v3 问题在下方以 `V3-E2E-*` 编号追加。`已定位、待修复` 表示已有确定性复现和源码根因，但尚未修改实现。

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

## Runtime v3 追加台账：人工门返工后的派发与身份链阻塞（2026-08-27）

### 事故摘要

一个单包方案评审任务已完成 Owner 两轮交付、Challenger 复审和 Expert 裁决。Expert 的结构化 outcome 为 `accept`，但正文提出必须先完成若干编辑性修正；用户因此在人工门选择 `rework`。这一区分很重要：现场实际进入的是 `deriveTask` 的“人工门 rework 覆盖波”，不是 `nextWave` 的“Expert verdict=rework”普通返工波。

返工后出现三层连续故障：

1. 第一张 Owner respond 派单已经写入，但在 Owner 未交付时再次调用 `run` 或 `dispatch-plan`，Runtime 又写入一张同阶段、同角色、同包、同轮次的新派单；现场连续产生了多张不同 dispatchKey 的等价派单。
2. 派单标记为 `continuation=true`，任务级注册表里也仍保存原 Owner 会话，但输出却给出 `expectedAgentIdMissing=true`。Lead 被迫查找内部状态并改开 fresh Owner，平台工具错误只是这个错误缺省值的下游表现，并非原 Owner 数据真的丢失。
3. “让重复 key 各交付一次以清空在途”会把一个逻辑轮写成多份 Owner 报告。波次机用报告数量计算当前轮次，评审快照却用报告里的最大 `round`；两者分叉后，已接受的 Challenger 评审仍被判断为未覆盖当前轮，Runtime 会再次派同一 Challenger review，形成新的死循环。

重复推进是合法用法，不是 Lead 误操作：v3 规约明确 `run` 多次调用是常态，重试、超时恢复和并发调用都必须幂等。要求 Lead“派发后绝不能再调推进命令”只能临时降低触发率，不能作为修复。

### 条目

| ID | 现象与影响 | 直接根因 | 建议处置与回归证据 | 状态 |
| --- | --- | --- | --- | --- |
| V3-E2E-01 | 人工门 `rework` 的 Owner respond 在途时，重复或并发推进继续生成新 key；多包任务会按“重试次数 × 包数”放大派单、成本和并发写风险 | `runtime-v3/derive.mjs:30-45` 在 `wave.kind === "gate"` 的人工返工分支直接返回 `dispatch`，而统一在途检查位于 `67-77`，该分支永远到不了守卫。任务锁只能串行化写入，不能修正锁内每次都得出“再派一次”的错误判定 | 所有产生 `next.kind=dispatch` 的路径必须经过同一个“已有未结派单则 wait-inflight”深接口；同锁写入前再以稳定波次身份做幂等核验。补人工门返工下 serial run、serial dispatch-plan、混用、并发、重启、多包部分交付测试；**已实施**（方案 F3 在途守卫统一：derive 全部派发路径统一经 waveId 批次守卫，重复/并发推进返回同一在途卡）；回归：`tests/runtime-v3-waves-regression.test.mjs` 覆盖人工门 rework 后 serial run、serial dispatch-plan、混用、Promise.all 并发、重启均返回同一 wait-inflight 且 journal 不增长、多包部分交付只等剩余包（验收表第 1–2 行）；全量 179 pass / 0 fail / 1 skip | 已修复 |
| V3-E2E-02 | 原 Owner 会话仍在注册表中，第二次续派可找到，第三次续派却报 `expectedAgentIdMissing`；同类问题也会发生在 Challenger 复审和 Expert 重裁 | `runtime-v3/cli.mjs:851-868` 只取“紧邻的上一派单 key”查映射；但 `agent-map`/插件只在新建或替换成员时登记 key，成功的 `send_message` 续派不会给新 key 再登记。因此映射链必然是“首派 key 有映射 → 续派 key 无映射 → 下一次续派断链”。`pendingTags` 又会覆盖成最新 key，fresh 降级后可能把稳定标签回填给新 Owner | 最小修复为：在当前阶段、同角色、同包范围内倒序寻找“最近一个已有映射的派单”，而非只看紧邻 key；replace-owner 时最近的新映射自然胜出。结构性方案是把成员身份改成稳定 `memberSlot(stage, role, package, incarnation) → childId`，dispatchKey 只表示一次派单，不再兼任成员身份；**已实施**（方案 F4 倒序回溯，memberSlot 为方案 §8/§9 后置终局项）；回归：Owner/Challenger/Expert 各连续三次派发原成员始终可解析、replace-owner 后解析新成员、fresh 复用 key 回填新映射、不跨 stage-advanced 串线、w/d 键混存不断链（验收表第 3 行） | 已修复 |
| V3-E2E-03 | 重复的同轮 Owner key 各自交付后，下一张 review 的轮次被抬高；review 已接受后仍重复派 review，且后续自主轮次预算失真。现有公开接口没有取消/作废重复派单的恢复边 | `runtime-v3/waves.mjs:48-54` 的 `roundOf` 取 Owner 报告数量；`runtime-v3/intake.mjs:213-220` 的 `reviewedPackages` 取最大 `report.round`。正常时二者偶然相等，重复同轮报告出现后立即分叉。intake 只对“同一个 key”幂等，不识别多个 key 属于同一逻辑波；journal 也没有 superseded/cancelled 事实 | 派生轮次改为每包 `max(report.round)`，并按 `(stage, role, package, round, waveRef)` 投影唯一逻辑交付；为既有重复事实增加只增式 `dispatch-superseded` 恢复语义，不删 journal。零报告、单报告、同 digest 多报告可机械收敛；多报告且 digest 不同才出用户选择卡；**已实施**（方案 F2：轮次唯一算法 = 每包 max 已交付报告 round、round 由派发事件抄写，reviewedPackages 快照写入处与判定处同源；F9 四类恢复矩阵落地）；回归：同轮重复派发各交付后投影轮不虚增、Challenger accept 后不再重复派 review、轮次上限按真实轮消耗、异 digest 多报告出用户选择卡（验收表第 4/8 行） | 已修复 |
| V3-E2E-04 | 人工门决定后，如果成员用决定前的旧 dispatchKey 修改并重交，Runtime 会跳过应有的 Owner respond，直接进入后续评审；旧工作可能被误当成已执行新返工要求 | `runtime-v3/derive.mjs:27-28` 只用 `report.at > decision.at` 判断“返工后已交付”，比较的是到达时间，不是因果关系。intake 允许同 key 改 payload 后覆盖报告并刷新 `at`，所以决定前派单的迟到/修订报告可以冒充决定后的回应 | 人工返工派单写入 `causeDecisionId`（或稳定 waveRef），只有绑定该决定的派单报告才能完成本次返工；判断使用 journal seq/引用，不使用墙钟时间。相同 payload 重试继续幂等，变化 payload 应保留修订历史或要求新派单，不能无痕覆盖事实；**已实施**（方案 F5 结构因果判定：人工门 rework 总派 respond 波并抄写 `causeDecisionId`，完成判定 = 绑定该决定的 respond 波报告 outcome=delivered，决定前旧 key 重交结构性无效；deliveredAfter 时间判定删除；blocked/僵局转 converge-user 仲裁卡；F7 报告 ver 链使 payload 变化可追溯）；回归：`tests/runtime-v3-waves-regression.test.mjs` 覆盖决定前旧 key 重交不能完成返工（验收表第 5 行）；全量 179 pass / 0 fail / 1 skip | 已修复 |
| V3-E2E-05 | 八视角交叉评审任务中，多名 senior 档视角 Owner 在派单外自行递归派发子代理（一名派出 8 个审查子面），递归子代理继承 senior 档成本；成员数翻倍、预算失控 | 双层根因：① 派单构建把任务级 objective 原样注入包级派单（cli.mjs:238），objective 中的“八个视角独立并行审查”被成员误读为自身执行模板，成员把八视角当内部拆面递归扇出（其 8 个子代理标签与八视角一一对应）；派单未注入编排拓扑事实（“你只负责本视角，其余由其他成员并行负责”）。② DSH 子代理拥有完整工具面，runtime/插件层无成员层派发的档位/数量治理；AGENTS 规则 16 只读子派单纪律（junior、可写空）未被强制，递归子代继承 senior 档 | 下阶段修，两层：① 派单语境——包级派单不再原样注入任务级 objective，改为注入包级范围与编排位置（“你负责本视角，其余由其他成员并行负责”），成员纪律明确“不得扇出视角级审查；只读子派单须 junior + 可写空”；② 治理 hook——插件拦截成员层 subagent 或强制 RO 档位/可写空；与定向委派方案 §8 档位上限治理合并评估 | 已定位、待修复（下阶段） |

### 确定性复现与覆盖缺口

全部复现均在临时项目目录运行，没有修改仓库源码或真实任务状态：

1. **人工门在途幂等**：完成门前收敛 → 用户选 rework → 连续推进两次。期望 `dispatch(k1) → wait-inflight(k1)`；实际 `dispatch(k1) → dispatch(k2)`，journal 出现两条同轮 respond。
2. **成员身份链**：首派 Owner `k1` 登记为会话 A → Challenger rework → `k2` 正确导出 A → Owner 交付 → Challenger 再 rework → `k3`。期望仍导出 A；实际 `expectedAgentIdMissing=true`。该复现不需要人工门，证明身份缺陷是所有三轮续派的通病。
3. **轮次分叉**：让两条同为 round 2 的重复 Owner key 都交付。下一张 review 被错误标成 round 3；提交该 review 后再次推进，仍得到 round 3 review，而不是 respond、verdict 或门。
4. **旧派单冒充新返工**：人工门 rework 后，不取新 respond，改用决定前的 Owner key 重交；下一步实际进入 Challenger review，证明 `deliveredAfter` 只有时间关系、没有因果关系。

现有相关套件 54 项全部通过，但没有覆盖上述交叉点：

- `tests/runtime-v3-invariants.test.mjs:150-162` 只断言人工门 rework 的**第一次**调用能派 respond，没有再调用一次验证在途幂等。
- `tests/runtime-v3-dsh.test.mjs:297-303` 只验证普通首派的重复 `dispatch-plan` 会等待，没有覆盖人工门特殊分支。
- `tests/runtime-v3-topology.test.mjs:319-344` 的测试名声称覆盖 `expectedAgentId`，正文既没有构造同角色的第二次续派，也没有任何 `expectedAgentId` 断言；因此对断链没有检测能力。
- `tests/tag-agent-auto-register.test.mjs:22-32` 明确固化“同标签续派把 pending key 覆盖为最新 key”，但没有验证 `send_message` 不会触发新子会话回填，从而遗漏了 pending key 与 mappings 的生命周期错位。

### 根因链与边界判定

1. **首要控制流缺陷**：人工门返工是后来叠加在 gate 分支里的特殊提前返回，没有复用普通波次的在途判定。既往“并发/重复 run 双派发已修复”的结论只覆盖了走到文件末尾的普通波，人工门分支仍是漏网路径。
2. **身份实体建模错误**：dispatchKey 是一次工作尝试，childId 是一个可持续成员，两者生命周期不同；用“上一 dispatchKey 的映射”推导稳定成员，必然在一次成功续聊后断链。
3. **幂等粒度过浅**：同 key 重交做到了幂等，但同一逻辑波可以生成多个 key；真正应唯一的是“波/包/轮/原因”，不是随机 key。
4. **轮次的双重定义**：`waves.mjs` 用报告基数，intake 快照用显式 round。平时相等掩盖了问题，重复事实一出现就形成两个状态宇宙。
5. **恢复边不完整**：`resumeNote` 建议 fresh 重开，只解决“没有句柄”，没有处理旧 key 仍在途、身份迁移、重复 key 作废和轮次投影。Lead 按提示操作后仍可能进入死门，违反 I5；Lead 被迫读 Runtime 源码，也违反“深 Interface 不要求 Lead 拼装底层字段”的产品边界。

### 分阶段优化建议

#### P0：先恢复正确性

1. 抽取唯一的 `deriveInflightBatch` 纯函数，供 `deriveTask`、在途卡重建和 intake 提示共同使用；任何分支只要准备返回 `dispatch`，必须先经 `dispatchOrWait`。不要只把现有几行代码向上移动，否则下一个特殊分支仍会绕过。
2. 在同一任务锁内为派发写入增加稳定 `waveRef`，建议至少由 `stage + kind + role + round + package 集合 + causeRef` 确定；相同未结 waveRef 已有派发时返回原在途卡，不再生成随机新 key。随机 dispatchKey 继续作为单次交付凭证。
3. 续派解析先做当前结构可兼容的倒序“最近已映射成员”查找，并限制在当前阶段、同角色、同包；不可跨阶段误续。replace-owner/fresh 成功后写入更新的 incarnation，使新成员成为最近合法映射。
4. `roundOf` 改成每包最大显式 round，并把同一 waveRef 的多份历史报告投影为一个逻辑轮。门禁、评审覆盖、轮次耗尽必须消费同一个投影函数。
5. 给受影响旧任务提供无损恢复：追加 superseded 事实而不是删 journal/report。只有一个已接受报告时自动选它；多报告且 digest 相同可机械合并；digest 不同则呈现用户卡选择保留版本，其他 key 作废。

#### P1：消除同类缺陷

1. 以稳定 `memberSlot` 绑定平台会话；`agent-map` 更新 slot 的当前 incarnation，`expectedAgentId` 不再依赖派单链回溯。后续定向委派实现应以此为前置，不要把新工具返回的 sessionId 继续只挂在一次性 dispatchKey 上。
2. 人工决定、返工波和报告形成显式因果链：`decisionId → waveRef → dispatchKey → reportId`。多次人工返工、迟到报告、进程重启都按引用推导，不按时间戳猜测。
3. 对齐“报告不可变”规约：同 key + 同 payload 是幂等返回；payload 变化应产生可追溯 revision 或被拒绝并要求新派单。当前无痕覆盖会让已签发人工卡所依据的 Challenger/Expert 结论在等待期间变化。
4. 人工门等待期若允许评审修订，决定上下文指纹应同时绑定制品和最新评审链；否则应拒绝成员修改并要求 Lead 重新签发卡。现场曾在 `decision-issued` 后出现同一 Expert key 的修订报告，说明这不是纯理论场景。
5. 角色语义指引补强：Expert `accept` 应表示“无需再修改即可过技术门”；存在必须完成的前置修改时应给 `rework`。这能避免“accept + 强制修正”把本可走普通返工波的问题推到人工门，但不能替代上述 Runtime 修复。

### 相邻场景推演

| 场景 | 当前可能结果 | 修复后应满足 |
| --- | --- | --- |
| Expert 直接 `verdict=rework` | 普通波当前能进入在途守卫，但第三次 Owner 续派仍会断身份链 | 只派一次；始终续同一有效 Owner，除非显式 replace-owner |
| Challenger 连续两轮 rework | 第三张 Owner respond 找不到原 Owner | 最近合法 memberSlot 稳定解析 |
| Challenger 第三次复审或 Expert 第三次重裁 | 续派 key 没有映射，fresh 成员丢上下文 | 同角色 slot 持续，复审/重裁不因 key 更换断线 |
| 多包人工门 rework + 重试 | 每次重试重复扇出全部包；成本成倍、同包可能并发写 | 同一 waveRef 只保留一批；部分交付只等待剩余包 |
| `run` 与 `dispatch-plan` 混用、命令超时后重试 | 人工门分支每次生成新 key；调用者无法判断第一次是否成功 | 任意入口、串行或并发都返回同一在途事实 |
| 派发落 journal 后进程崩溃、平台尚未创建成员 | 普通波可重建，人工门返工却可能再生新 key | 重启后重放原 key/prompt，不扩大波次 |
| send_message 失败后 fresh Owner | pendingTags 可能绑定最新重复 key，后续身份漂移 | fresh 明确创建新 incarnation，并作废旧成员映射/未结尝试 |
| replace-owner 后再次返工 | 简单倒序若不分阶段/代次，可能回退旧 Owner | 以最新 incarnation 为准，旧 incarnation 只保留审计 |
| 决定前派单的迟到报告 | 仅凭新 `at` 冒充决定后回应 | 必须带本次 `causeDecisionId` 才能消费返工 |
| 同轮重复报告已经落盘 | round 基数与 reviewedPackages 最大 round 分叉，评审循环 | 历史事实保留，逻辑投影去重，轮次与覆盖同源 |
| 人工等待时 Expert 改写同 key verdict | 用户卡仍是旧问题文本，决定却作用于新评审链 | 冻结评审或使决定上下文指纹失效并重新签发 |
| 新阶段复用同名包和 Owner 角色 | 全历史倒序可能续到上一阶段成员 | memberSlot 含 stage；回溯绝不跨 stage-advanced 边界 |

### 修复验收门槛

1. 人工门 rework 后首次推进只写一批；随后任意次数的 `run`、`dispatch-plan`、两者混用和 `Promise.all` 并发均返回同一 `wait-inflight`，journal 不增长。
2. 单包、多包、部分交付、重启恢复均满足“一逻辑波一批派单”；多包只等待未交付包，不重复已交付包。
3. Owner、Challenger、Expert 各做至少三次连续派发，原成员始终可解析；replace-owner 后只解析新成员；同名角色/包不跨阶段串线。
4. 注入一组历史重复 key：零报告、一个报告、同 digest 多报告、不同 digest 多报告四类均有确定、可审计、无删除的恢复结果。
5. 两个相同 round 的 Owner 报告不抬高逻辑 round；Challenger 接受后不会再次派同轮 review，轮次上限只按真实返工轮消耗。
6. 决定前 dispatch 的迟到或同 key 修订报告不能完成决定后的 rework；第二次人工 rework 也不能被第一次的报告消费。
7. 现有相关套件继续全绿，并修正测试名与正文不一致的问题；高风险状态恢复完成后再做一次真实 DSH 人工门 rework 复验。

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
