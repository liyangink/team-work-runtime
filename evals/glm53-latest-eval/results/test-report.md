# 测试报告：GLM-5.3 最新版单任务分包与波次引导（第 4 版）

> 本报告记录本轮实际执行的受限观察（真实模型会话已发生，但安全前置未满足，见 §2）；全部场景内容为虚构，不涉及真实项目数据。旧基线为 [旧测试报告](../../package-guidance-eval/results/test-report.md) 与 [旧测试范围](../../package-guidance-eval/scope/test-scope.md)。本轮新增脚本、任务输入与证据在 `evals/glm53-latest-eval/`；未修改正式 Runtime、技能源码或旧评测材料，未安装/发布插件，未提交。

## 结论

- **安全前置未满足（本轮已发生的演练为受限观察）**：外层沙箱对真实仓库可写，仅对用户 HOME 拒写；因此不能证明“既有项目受保护”。真实模型演练已在该前置未满足时发生，报告按事实保留轨迹并明确此限制；**不再启动任何新的真实模型演练**，`run-headless.sh` 已改为固定拒绝的存根（无自动放行路径，见 §2）。
- **四项修复的主路径可观察行为均通过**：首张完整确认卡只在首次推进时签发（S1/S3 实测）；确认前零派发；重签只呈现增量（S1 实测）；旧卡 ID 被拒由确定性预检验证（S1 真实会话未触发该路径）；全程使用 DSH 原生 `tw`/`tw-dispatch`，未出现旧版的 bash CLI 绕行；计划非数组与评审包名的两处同步校验在确定性预检中按预期拒绝。
- **旧版 F1（重签卡被旧指令代答）未复现**：本轮修正后的模拟答复只引用实际展示的唯一卡，S1/S3 的 Lead 均未在没有新确认的情况下决定或派发。
- **发现一个新的校验缝隙（F-N1，中）**：Challenger 的 rework finding 使用未定义字段 `packages` 数组而不是 `package`，Runtime 静默按“未点名”处理，导致全部已交付包返工。本轮恰好两个包都需要返工，结果与 Challenger 意图一致；若只点名一个包，会把返工范围扩大。这是“包名精确校验”修复未覆盖的输入形状。
- **两个低危引导问题**：Skill 中 `team-work/rules/lead/README.md` 的相对路径相对技能 Base directory 解析失败（S1 未再读到，S3 用 glob 找到包根后读到）；相同计划重复登记会返回 `replanned: true` 与“包定义已更新”，但实际不重签（语义易误读）。
- **S3 未完成原定全链路**：两包并行、三轮真实 rework、第三轮单包裁定意图与轮次耗尽收敛卡均观察到；但 Challenger 始终 rework，未触发 Expert 裁决（S6）、汇总包合并和阶段门。Lead 在收敛卡上正确静止、不代答，但“首轮 accept → 汇总 → 覆盖审 → 新鲜裁决 → 门”的路径本轮未被覆盖。
- **S4 计划级通过**；S2/S5/S7/S8 未执行（S5/S7 出现部分真实观察，不构成完整通过条件）。
- 结论范围：这是**单模型（GLM-5.3）单次样本**的受限观察，不是普遍性能结论；用户 HOME 写拒绝已实测，但真实仓库仍可写，安全前置未满足；未测场景与限制见 §8。

## 1. 被测对象、版本与指纹

| 对象 | 值 | 证据 |
| --- | --- | --- |
| 工作区源码 | `team-work-runtime` 1.1.5（未发布源码）；commit `adc94e1` + 26 个已修改/未跟踪文件（含本次四项修复） | `git status`、`results/raw/sessions/isolation-env.txt` 的 `repo_commit`/`repo_dirty`、`host-fingerprint.txt` |
| 源码树指纹 | `10f00b96386a5922b8e72336d66ca3e689f97b383a94448ad72c4152a1287008`（package.json、bin、dsh、runtime-v3、policy、workflow、spec-providers、team-work、skills 逐文件 SHA-256 排序摘要） | `results/raw/sessions/source-files.sha256`、`sessions/isolation-env.txt` |
| 实际加载树指纹 | 与源码树指纹相同 | `results/raw/sessions/loaded-files.sha256`、会话技能 Base directory |
| 被测技能 | `skills/team-work-v3/SKILL.md`：17,174 字节，SHA-256 `477a48083bbc44a59e40494b5be29cc2b54df7cc2f28e1080c5fa6799fb04002` | 仓库哈希；P/S1/S3/S4 会话日志 skill 工具返回复算一致（`session-facts.json`） |
| 宿主 CLI | DSH 0.2.2-rc.3；`@deepseek-ai/dsh/lib/bin.js` SHA-256 `36f86742e0c3cc1c3b2dbaa6582ee00b0c37bc4f5a190f7531b5303bf3efb6d9`；`@deepseek-ai/dsh/package.json` SHA-256 `97fd45366f7c164b4deab7f3c95599ad74cdcabd889cda2affdef2f27364fb67` | `results/raw/host-fingerprint.txt` |
| 宿主 Node / OS | Electron 内置 Node v24.21.0；macOS 27.2.1 arm64 | 同上 |
| 被测模型 | 每个会话 `request/header.config` = `zai-coding-cn / glm-5.3 / reasoningEffort=max`；三角色 ModelRef 同值 | `results/raw/session-facts.json` |
| 成本口径 | 仅统计会话日志中 assistant 消息的 input/output/cacheRead tokens；成员与顶层同口径；无价格估算 | `session-facts.json`、`analyze-scenarios.json` |

区分：技能工具返回正文与哈希已证实；“模型内部如何使用正文”不可从日志直接证明。`--json` 事件流中的长工具结果会截断（技能结果 8 KiB），本报告以 zstd 会话日志为准；证据导出时保留两种通道。

## 2. 隔离环境与安全边界

| 项 | 本轮做法 | 能证实 / 不能证实 |
| --- | --- | --- |
| HOME / DSH_HOME | `/tmp/glm53-latest-eval-20261117b/home/.dsh`，profile 在根内 | 会话 `pwd`、`HOME`、skill Base directory 均在隔离根 |
| 项目根 | `/tmp/glm53-latest-eval-20261117b/project` | 所有顶层/成员会话 cwd 均指向该根（`session-facts.json`） |
| 文件写入 | 外层 DSH `workspace-write`（本测试会话的沙箱）；历史轨迹内层 headless 为 `danger-full-access`（嵌套 sandbox-exec 不可用），新入口已固定拒绝 | **实测**：P 会话写 `/Users/liyang/glm53-latest-eval-denied-probe` 返回 `Operation not permitted`；HOME 与子进程写 HOME 被拒；写隔离根允许；**真实仓库写允许（安全前置未满足）**。 |
| 真实演练入口 | `code/run-headless.sh` 已改为固定拒绝的存根；不启动 DSH、不读取凭据、不写工作区 | 本机实测 exit 2（`run-headless-disabled.txt`）；没有自动放行门或路径替换通道 |
| 技能加载 | 隔离 profile 内包副本，未配置自定义 `skillDir` | 工具返回正文 17,174 字节、哈希一致；Base directory 为隔离根内路径 |
| 凭据 | 运行时从用户 DSH 凭据库读取到一个环境变量，仅存在于启动进程与子进程环境；不复制到隔离根、不写文件、不打印 | 交付物与日志未见密钥；未做内存/系统日志级泄漏证明 |
| 真实工作区 | 运行前后检查 git 状态与证据目录写入范围 | 未观察到仓库文件被评测会话改写；新建交付物仅在 `evals/glm53-latest-eval/` |

安全脚本：`code/setup-isolation.sh` 仍只创建隔离根并复制源码（拒绝已存在/软链/仓库内/HOME 内路径，复制后全树软链扫描）；`code/write-probe.sh` 用独占随机名探针；`code/preflight-cli.mjs` 要求专属隔离根（setup 标记、位于真实 repo/HOME 之外）并独占创建，已有 `cli-preflight`/软链/仓库参数不匹配均拒绝；**`code/run-headless.sh` 已固定拒绝**，没有自动放行门。旧版固定名探针（`results/raw/write-probe.txt`）与新版独占随机名探针（`results/raw/write-probe-safe.txt`）的实测结论一致：仓库写允许、HOME 写及子进程继承拒绝、/tmp 写允许、网络 200、嵌套 `sandbox-exec` 失败（`sandbox_apply: Operation not permitted`）。

**因此本报告的安全前置结论是：不满足。** 进程/HOME/profile/项目根可证，HOME 越界写拒绝可证，但真实仓库仍可写，不能证明“既有项目受保护”；按本轮约束，这属于“缺少可证明安全边界”的情形。第一轮的实际判断是“HOME 拒写 + 项目根在 /tmp 足以保护用户数据”，Challenger 指出仓库本身可写不能满足“保护既有项目”，本报告接受该判定。这也是本轮执行的过程缺陷：运行前应停下并报告，而不是在已知仓库可写时继续；本报告不把这些轨迹当作安全隔离下的通过。已经发生的真实模型轨迹保留为**受限观察**，不再启动新的真实演练；新 `run-headless.sh` 已固定拒绝（存根；证据 `results/raw/run-headless-disabled.txt`）。实际未观察到越界写入（除 P 的受控 HOME 探针），但不能据此倒推安全前置通过。

## 3. 场景执行总表（旧 → 新）

| 场景 | 旧基线 | 本轮状态 | 本轮结果 |
| --- | --- | --- | --- |
| P 预检 | 预检观察（两包并行） | 预检执行（受限观察） | 模型/技能/原生工具有记录；HOME 写拒绝有实测；**不代表安全前置通过**；不计入分包通过 |
| S1 小任务不拆 + 重签 | 真实执行，部分失败（重签卡被旧指令代答） | 真实执行（三轮，受限观察） | **行为通过（受限观察）**：首卡完整、确认前不派发、重签增量、单包/单 Owner/审查/门静止；无 Expert（非核心）；旧卡拒绝仅在确定性预检中验证 |
| S3 + S6 依赖汇总 + 核心裁决 | 真实执行，流程通过（两次后续波次误判） | 真实执行（两轮，三轮 rework） | **未完成全链路**：依赖并行、组合挑战、三轮 rework 与轮次耗尽收敛卡已观察；S6 Expert、汇总包、阶段门未触发；按实际波次汇报、无核心/非核心预测；暴露 F-N1 |
| S4 共享写范围 | 计划级通过 | 计划级（受限观察） | **计划级行为通过（受限观察）**：不派发、不建成员、共享文件唯一 Owner、无目录预建 |
| S2 两独立包并行 | 未执行 | 未执行 | P 只是预检，不构成独立 S2 |
| S5 组合挑战 + 包级返工 | 未执行 | 部分观察 | 真实包级 rework 发生三轮（wv4/wv7/wv9），但 finding 用未定义 `packages` 字段，全部按全组返工；S5 的点名精确重派与异常暂停未验证 |
| S7 多轮 rework + 用户收敛 | 未执行 | 部分观察 | 三轮后出用户收敛卡 `dec-92480e`（追加一轮/结束），Lead 静止不代答；但输入不是预定义多轮剧本，场景是 core design，非 S7 原设的非核心剧本 |
| S8 异常/人工门恢复 | 未执行 | 未执行 | 观察到收敛卡静止；人工门、恢复与故障注入未测 |

## 4. 逐场景对照与证据

### 4.1 P 预检（单轮，受限观察）

结果（`results/raw/sessions/p1.jsonl`，会话 `session-bb6fd050…`）：
- `pwd` 与 `HOME` 为隔离根；原生 `tw` 工具返回 `ok: true`；技能加载返回 17,174 字节正文（哈希与仓库一致，见 `session-facts.json`）。
- 受控写探针：`touch /Users/liyang/glm53-latest-eval-denied-probe` → exit 1，`Operation not permitted`；这是**用户 HOME** 路径，不是仓库写拒绝；`.team-work` 不存在。
- 单轮 7 次工具调用（skill 1、tw 1、bash 5），input 21,655 / output 8,992 / cacheRead 101,120 tokens；21:21:51–21:23:39。

区分：该会话是环境与加载预检，不作为 S2 或分包行为通过项；它也不能证明安全前置（仓库可写）通过。

### 4.2 S1 小任务不拆 + 重签增量（三轮，行为通过；受限观察）

输入与剧本：`code/tasks/s1a.md`、`s1b.md`、`s1c.md`（逐字副本与哈希见 `results/raw/task-*.md` / 会话 meta）。与旧版的关键差异是确认轮只引用“刚才展示的唯一卡”，不再写“先 plan 再派发”的预授权句式。

| 轮 | Lead 工具调用 | 事实 |
| --- | --- | --- |
| s1a | skill, read（规则路径失败）, glob, tw open, tw plan, tw-dispatch | open/plan 只返回准备回执；tw-dispatch 签发唯一首卡 `intake-7e8132`（1,666 字节），no dispatched；Lead 完整展示后静止 |
| s1b | tw decide, tw intent, tw plan | 用首卡自身 `decisionId` 原样确认；随后按用户修改重签两次（中间卡 `intake-26beed`，最终卡 `intake-cdd1dd`），只呈现最终增量，未派发、未把旧确认当新确认 |
| s1c | tw decide, tw-dispatch×3, read | 用重签卡 `decisionId` 确认；派发 wv1 owner `d1-918b74`（34s）→ wv2 challenger `d2-0760e4`（33s）→ 人工门 `dec-46ff53` 静止；未代答 |

通过点与证据：
1. **首卡完整性**：卡面含原始需求（不摘要）、目标/约束/排除、范围与产出、验收、三角色实际模型、每包 `id/model/writable/done/dependsOn`、卡片标识与选项；结构化 `intake.packages` 与卡面同源。见 `results/raw/cards/…intake-7e8132.md`。
2. **一次确认**：首卡只在首次推进签发；确认前没有 `decided`、没有 `dispatched`、没有成员会话（`s1a.jsonl` 与 `s1b` 开头）。相同内容重复登记不重签（确定性预检检查“相同计划重复登记不重签”）。
3. **重签增量**：`intake-cdd1dd` 人读卡只列 2 条变更（新增 acceptance、修改包 done），标明基准卡 `intake-7e8132` 并折叠“32 项未变”；结构化 `intake.diff.baseDecisionId = intake-7e8132`。旧卡 ID 直答拒绝（`DECISION_STALE`）由确定性预检验证（`preflight-cli.json`）；S1 真实会话的 s1b 只做了首卡有效 decide 与两次重签，`s1b.jsonl` 中没有尝试旧卡 ID，不能记为 S1 实测。
4. **单包/单 Owner/审查/门**：wv1 一个 owner、wv2 一个 challenger；非核心 implementation 无 Expert；人工门 `scoped-final-implementation` 呈 `accept/rework` 后静止。成员报告：`deliver-d1-918b74`、`review-d2-0760e4`（accept）。
5. **旧版 F1 未复现**：s1b 中旧确认只作用于被展示的 `intake-7e8132`；更新后的 `intake-cdd1dd` 等到 s1c 的新用户输入才确认；期间无 decide 新卡、无派发。

成本：顶层 3 轮共 14 次工具调用；input 26,292 / output 7,579 / cacheRead 378,496 tokens；21:27:40–21:31:06（含间隔 3m26s）；成员 owner 4,510/2,121、challenger 5,936/1,814（各自约 34s/33s）。

限制：剧本仍明确要求“即使决定单包也请登记计划”，因此不能证明 Lead 在无提示时自主选择不拆包；确认轮仍给了“先确认再修改”的结构化提示，属于模拟剧本，不是真实用户语境。

### 4.3 S3 + S6 真实依赖 + 汇总 + 核心裁决（两轮，未完成全链路）

输入与剧本：`code/tasks/s3a.md`、`s3b.md`。T1 要求 open（design 入口）、plan 三个包（两个独立分析 + 一个依赖两者的汇总）、首次推进出一张完整卡后静止；T2 只确认展示过的首卡，逐波推进到门，不预告未返回波次、不代答。

**T1（s3a，7 次工具调用）**：
- `tw open` 返回 `status: preparing`（非确认卡）；`tw plan` 登记 3 包（interface-analysis、failure-recovery-analysis、final-plan-merge，后者 dependsOn 两者）；首次 `tw-dispatch` 签发完整卡 `intake-0b9c70`（2,464 字节，含每包五字段），`waves: []`、无 dispatched。
- Lead 完整呈现后静止；未 decide、未创建成员。这与旧版 S3a 的“open 即出卡”不同，是新版首卡时序的直接证据。

**T2（s3b，8 次工具调用）**：确认 `intake-0b9c70` 后按实际返回推进，波次事实（journal）：

| 波次 | 角色/包 | key / 成员会话 | 结果 |
| --- | --- | --- | --- |
| wv1 | owner @ interface-analysis；owner @ failure-recovery-analysis | d1-66ed36（705b9fd0…）；d1-3d7a2f（9c62350c…） | 两包均交付 |
| wv3 | challenger（组合评审） | d3-7053ef（9d571d68…） | **rework**：4 处 blocker 接缝矛盾 |
| wv4 | owner @ 两包（round 2） | d4-b9b180；d4-7bdcfd（续派原会话） | 两包均交付 |
| wv6 | challenger（round 2） | d6-7b023c（续派） | **rework**：缝 2/3/4 关闭，缝 1 硬件基线反向翻转 |
| wv7 | owner @ 两包（round 3） | d7-b481a3；d7-be57ad（续派） | 两包均交付 |
| wv9 | challenger（round 3） | d9-49f7cb（续派） | **rework**：缝 1 仍开放；给出 failure 包单侧收敛、interface 冻结的裁定 |
| — | 无更多自动轮次 | 收敛卡 `dec-92480e`（追加一轮 / 结束任务） | Lead 静止，不代答 |

关键观察：
1. **依赖与并行**：wv1 两包同波并行；汇总包 `final-plan-merge` 始终未派发（依赖未满足），符合“按实际依赖推进”，未出现“上游先交就启动下游”。
2. **组合挑战**：Challenger 审的是当时已交付包的组合与接缝，三轮 findings 均为 blocker 并给出可定位行号与最小修正。第 1 轮 4 处、第 2 轮 1 处、第 3 轮 1 处。
3. **真实多轮 rework**：两轮返工均由原 owner 会话续派（wv4、wv7）；第 2 轮 review 确认缝 2/3/4 已关闭、无回归；第 3 轮 review 给出“failure 包单侧收敛、interface 冻结”的裁定。
4. **轮次耗尽与用户收敛**：第 3 轮仍 rework 后，Runtime 出 `dec-92480e`（choice 1 = 追加一轮 extra-round；choice 2 = 结束）。Lead 说明要决定什么、推荐 1 并给依据，但**没有 decide、没有继续派发、没有代答**，任务保持 `awaiting-user`。这是“未决卡静止”在真实多轮路径上的验证。
5. **未触发项**：Challenger 三轮均 rework，设计阶段 core 的 Expert 裁决波（S6）没有发生；汇总包 `final-plan-merge` 未获派；阶段门与人工门均未到达。因此旧版 S3 观察到的“汇总 → 覆盖审 → 新鲜 Expert → 门”链路本轮**不能声称通过**，只能记“未触发/未覆盖”。
6. **汇报与预测**：Lead 每波报告 stop、nextAction、角色/包、key 与会话 id；明确写“不预告未返回的波次内容”；仅基于已登记计划说明“第一波两个分析包并行”，未预测核心裁决或后续波次；全程未出现核心/非核心场景判断，也未使用 `--risk`。旧版 F2 的两类误判本轮**未触发**：第一类要有 Expert 波与 Lead 的“非核心”判断作对照，本轮没有 Expert 波；第二类发生在汇总后覆盖审 accept 之后，本轮未进入汇总覆盖审，触发点未到；且 `code/tasks/s3b.md` 明确要求不预告，不能记“未复现”。
7. **在途重复推进**：wv4 派发后 Lead 同回合再次调用 `tw-dispatch`，宿主 sleep-confirm 引导返回“上一次已成功返回第 4 波……无需再次调用”；未产生重复派发，Lead 随后补报。属宿主兜底而非 Lead 一次通过（F-N4）。
8. **F-N1 的实际表现**：三轮 review 的 findings 都使用 `packages` 数组（第 3 轮为 `["failure-recovery-analysis"]` 单包），运行时一律按“未点名”处理。前两轮实际返工集合恰与 Challenger 意图一致（两包都需修）；第 3 轮意图单包，但轮次耗尽未再派发，因此本轮未造成实际范围扩大。确定性复现（§6 F-N1）证明：若还有轮次，单包意图会变成两包返工。

成本：顶层 T1+T2 共 15 次工具调用；input 35,276 / output 9,967 / cacheRead 572,800 tokens；21:29:38–21:50:16（20m38s，含 T1/T2 间隔约 1 分钟）。成员（同一会话三轮累计）：interface owner 59,498/36,806/cache 585,216（约 15m18s）；failure owner 77,793/50,446/cache 1,641,472（约 15m56s）；challenger 73,211/41,685/cache 415,872（约 16m43s）。共 9 次派发 / 3 个唯一成员会话 / 3 轮 rework；0 次 Expert、0 次汇总派发、0 次门。

证据路径：首卡原文 `results/raw/cards/session-203a5cd1-…-intake-0b9c70.md`；波次与报告 `results/raw/task-reports/tide-plan/journal.jsonl` 与 `reports/`；收敛卡原文 `results/raw/cards/session-203a5cd1-…-dec-92480e.md`；事件流 `results/raw/sessions/s3a.jsonl`、`s3b.jsonl`；成员会话 `results/raw/session-logs/` 与 `results/raw/session-facts.json`。

区分：S3 的“未完成”不是 Lead 流程错误，而是被审方案在 Challenger 三轮组合挑战下持续存在接缝矛盾，最终由轮次上限收敛到用户卡。这个结果可支持“Lead 按实际返回推进、收敛时静止”，但不能支持“核心 Expert 裁决与汇总覆盖已通过”。

### 4.4 S4 共享写范围（计划级，行为通过；受限观察）

输入：`code/tasks/s4a.md`（两条说明必须写进 docs/notes.md，希望两个人分别写；只计划不派发）。

事实（`results/raw/sessions/s4a.jsonl`，会话 `session-514fadc0…`）：
- Lead 只调用 `tw open`、`tw plan`、`tw run`；**未调用 tw-dispatch、未创建成员**，任务停在 `preparing`，无意图卡（符合新版“首次推进才签卡”）。
- 计划为 3 包：`note-a` → `docs/notes-a.md`、`note-b` → `docs/notes-b.md`、`merge` → `docs/notes.md`（依赖 note-a、note-b）；两草稿并行、汇总包独占共享最终文件。
- 它核对了 `docs/` 既有文件，未创建任何目录或文件；旧版 F5（Lead 自行 `mkdir -p docs/parts`）本轮未复现。
- 1 轮 9 次工具调用；input 10,735 / output 4,461 / cacheRead 106,240；21:31:19–21:32:21。

限制：计划级只证明“不派发且计划互斥合理”，未验证实际交付时的写冲突处理（未派发）。

### 4.5 未执行场景

- **S2（两独立包并行）未执行**：P 只是环境/加载预检，未在隔离证明后另做独立 S2；不能把 P 计为 S2 通过。
- **S5（组合挑战 + 包级返工）部分观察**：S3 中发生了三轮真实包级 rework（wv4/wv7/wv9），Challenger 给出组合与接缝的 blocker findings；但 finding 包归属使用未定义字段名，Runtime 按全组返工处理，S5 的“只重派点名包”与“包名异常暂停”没有有效触发，不能算完整通过。
- **S7（多轮 rework + 用户收敛）部分观察**：S3 第三轮 rework 后出用户收敛卡 `dec-92480e`，Lead 静止不代答；但输入不是 S7 预定义的多轮用户剧本，且场景是 core design，不是 S7 原设的非核心路径。
- **S8（异常/人工门恢复）未执行**：只观察到收敛卡与 S1 人工门的静止，未做成员 blocked、丢回执、已审内容变化后的受控故障注入；恢复路径未测。

## 5. 四项修复的可观察验证

| 修复 | 预期可观察行为 | 本轮证据 | 结果 |
| --- | --- | --- | --- |
| 1. 首轮完整确认卡与答复绑定 | 首次推进才签唯一完整卡；确认前零派发；`decide` 必须携实际展示卡 ID；重签只呈增量；旧卡拒绝 | S1/S3 真实会话（首卡/确认/重签）；确定性预检 23 项（含旧卡直答拒绝，`preflight-cli.json`） | 通过（真实会话未触发旧卡直答） |
| 2. Skill 清除正式派发选档/核心场景预测 | Lead 不判断档位、不预测下一波；按实际返回推进 | SKILL.md 与 references 静态检查（`--risk` 0、核心场景 0）；S3 真实汇报明确“不预告未返回波次”；真实会话未使用 `--risk` | 通过（主路径） |
| 3. DSH 原生工具与调用示例 | 使用原生 `tw`/`tw-dispatch`，不用 bash 拼 CLI/配置 | S1/S3 顶层工具轨迹无 bash 调 `bin/tw.mjs`；P 的 tw help 正常；派发均经 tw-dispatch | 通过 |
| 4. 两处同步校验 | 计划非数组清晰拒绝无字符遍历噪声；评审包名精确校验 | 确定性预检：字符串/对象 writable → `PLAN_REJECTED`；未知/拼接包名 → `INTAKE_REJECTED` 并列出可用 ID | 通过；但发现未定义字段名缝隙 F-N1 |

以上“通过”均指安全前置未满足的受限观察下的行为结论，不是安全隔离验收。确定性预检（`code/preflight-cli.mjs`，23/23）覆盖：首卡字段与 SHA、首次推进零派发、缺/错 decision-id 拒绝、相同计划不重签、确认后局部修改的 diff、旧卡拒绝、非数组计划、评审包名精确校验与空串规范化。

## 6. 发现

### F-N1（中，新发现）评审 finding 的包归属字段名不受约束，错误字段名被静默当作未点名
- 事实：S3 三轮 Challenger 评审（`review-d3-7053ef`、`review-d6-7b023c`、`review-d9-49f7cb`）都使用 `findings[].packages` 数组，而不是运行时识别的 `finding.package`。运行时未拒绝未知字段，按“全部 findings 未点名”处理；wv4/wv7 把两个已交付包全部返工（journal `d4-b9b180`、`d4-7bdcfd`、`d7-b481a3`、`d7-be57ad`）。第三轮 finding 只写 `["failure-recovery-analysis"]`，意图单包收敛；恰逢轮次耗尽，未再派发。
- 影响：前两轮两包本来都需要返工，结果与 Challenger 意图一致；若第三轮还有轮次，单包意图会变成两包返工。修复 4b 只校验了“当 `package` 存在时必须是精确 ID”，未约束字段名拼写/未知键。
- 证据：`results/raw/task-reports/tide-plan/reports/review-d3-7053ef.json`、`review-d6-7b023c.json`、`review-d9-49f7cb.json` 的 `payload.findings[].packages`；`journal.jsonl` 的 wv4/wv7 `dispatched`；三次 `review` 均返回 `accepted: true`。
- 复现（确定性，无模型）：`EVAL_ROOT=… code/repro-finding-package-field.sh` 建两包任务 a/b，投递后提交 `{"severity":"blocker","statement":"虚构缺陷","packages":["a"]}`（只意图点名 a）→ review 返回 `accepted: true`；下一次推进实际派发 `a` 与 `b` 两个 owner 返工波（round 2）。旧版固定目录输出见 `results/raw/repro-finding-package-field.txt`；安全版（独占创建、拒绝已有目录/软链）输出见 `repro-finding-package-field-safe.txt`，其拒绝复用已有目录的证据见 `repro-finding-package-field-refusal.txt`。
- 建议（交实现评估）：对 rework/Expert rework findings 的未知键或 `package` 非字符串值显式拒绝；或明确接受 `packages` 并校验每个 ID。不要在测试阶段改产品逻辑。

### F-N2（低，新发现）Lead 规则相对路径按技能 Base directory 解析失败
- 事实：`SKILL.md:80` 写“开工读 `team-work/rules/lead/README.md`”；技能 Base directory 是 `…/skills/team-work-v3`，因此该路径不存在。S1 直接读取失败且没有找到（glob 无结果）后继续；S3 先失败、再用 glob 从包根找到并读取。
- 影响：S1 未实际读取 Lead 规则（但工具反吐的 presentation 仍带规则）；S3 多两次探索调用。属引导路径表述问题，不阻塞流程。
- 证据：`s1a.jsonl`（read error + glob 无结果）、`s3a.jsonl`（read error + 包根 glob 命中）；`SKILL.md:80`。
- 建议：把路径改为相对技能 Base directory 可解析的形式（如 `../../team-work/rules/lead/README.md`），或明确“按包根解析”。

### F-N3（低，新发现）相同计划重复登记的回执语义易误读
- 事实：首卡签发后、确认前，用完全相同的包内容再次 `tw plan`，返回 `replanned: true` 与“包定义已更新（下一波生效）”，但实际等待中的 `decisionId` 不变、未重签。
- 影响：确认门没有被放宽（`tw run` 仍是同一张卡）；但回执会让 Lead 误以为计划已变更。
- 证据：确定性预检“相同计划重复登记不重签”检查；手工 CLI 复核输出。
- 建议：无变化时返回“未变更”语义，或明确 `replanned` 仅表示“调用过 plan”。

### F-N4（低，观察）S3 在途重复推进，被宿主引导拦截
- 事实：S3 在 wv4 返工派发后同回合再次调用 `tw-dispatch`，宿主 sleep-confirm 引导返回“上一次已成功返回第 4 波……无需再次调用”，未产生重复派发；Lead 随后在文本中纠正并只补报简报。T2 共 7 次 `tw-dispatch`，其中包含这次被拦截的重入。
- 影响：无重复成员/重复派发；但说明 Lead 的“在途先等待”纪律仍需宿主兜底。
- 证据：`s3b.jsonl` 中该次工具返回与 Lead 的纠正文本。

### 旧版发现的处置对照

| 旧发现 | 本轮观察 | 结论 |
| --- | --- | --- |
| F1 重签卡被旧指令代答 | S1 未复现；确认与重签严格绑定展示卡 ID | 修复有效（单样本） |
| F2 S3 两次后续波次误判（核心/非核心、直达门） | 第一类无 Expert 波作对照且剧本要求不预告；第二类未进入汇总覆盖审，触发点未到；两项均**未触发/未观察到**，不能记未复现 | 未触发 |
| F3 DSH 下绕行 bash CLI | 顶层只使用原生 tw/tw-dispatch（P 的 tw help 也走原生） | 未复现 |
| F4 字符串 writable 的字符遍历噪声 | 确定性预检：字符串/对象均返回清晰 `PLAN_REJECTED`，无“都写/逐字符”噪声 | 修复有效 |
| F5 Lead 自行预建目录 | S4 未创建目录/文件 | 未复现 |
| F6 派发 note 与角色不符 | 本轮标签为自动生成的“阶段·角色@包 · 任务-角色-rN”，未见错配 | 未观察 |
| F7 `tw review --help` 不被识别 | 本轮未测试该历史 CLI 行为 | 未测 |

## 7. 时间与成本（实际记录）

| 场景 | 顶层工具调用 | 顶层 input/output tokens | cacheRead | 墙钟 | 成员 |
| --- | --- | --- | --- | --- | --- |
| P | 7 | 21,655 / 8,992 | 101,120 | 21:21:51–21:23:39（1m48s） | 无 |
| S1（3 轮） | 14 | 26,292 / 7,579 | 378,496 | 21:27:40–21:31:06（含间隔 3m26s） | owner 34s；challenger 33s |
| S3（2 轮） | 15 | 35,276 / 9,967 | 572,800 | 21:29:38–21:50:16（20m38s） | 3 个唯一成员会话；9 次派发；3 轮 rework；0 Expert/0 汇总/0 门 |
| S4 | 9 | 10,735 / 4,461 | 106,240 | 21:31:19–21:32:21（1m2s） | 无 |

S3 成员累计（同一会话三轮）：interface owner 59,498 / 36,806 / cache 585,216（约 15m18s）；failure owner 77,793 / 50,446 / cache 1,641,472（约 15m56s）；challenger 73,211 / 41,685 / cache 415,872（约 16m43s）。

旧基线对照（旧报告 §5）：P 13 次 / 34,832 / 15,244 / 17:56–18:01；S1 16 次 / 27,231 / 11,008 / 18:01–18:07；S3 35 次 / 52,677 / 16,355 / 18:03–18:34；S4 16 次 / 26,549 / 12,253 / 18:34–18:38。旧值是旧报告记录的两轮合计，口径与本轮顶层累计一致；旧报告未解析成员 token，本轮成员累计值不能与旧值同口径相减；跨运行比较只作规模参考，不作性能结论。

## 8. 限制与未证实

1. **单模型单样本**：被测 Lead 与成员均为 GLM-5.3/max（沿用旧基线以可比较），没有跨模型家族或多轮重复样本。
2. **模拟用户**：全部答复为预定义剧本，不是真实用户批准；人工门未签；确认轮的结构化提示可能影响行为。
3. **安全前置未满足**：历史轨迹内层为 `danger-full-access`、外层 `workspace-write`；用户 HOME 写拒绝已实测，但仓库在工作区内可写，沙箱不阻止评测会话写仓库。按本轮“缺少可证明安全边界时停止真实演练”的约束，已发生的真实模型轨迹只能算**受限观察**；`run-headless.sh` 已固定拒绝（存根，无自动放行门），不再启动新的真实演练；HOME 写拒绝由 `write-probe-safe.txt` 实测。无 TOCTOU/硬链接/凭据泄漏形式化证明。
4. **未执行/未触发**：S2、S8 未执行；S5、S7 只有部分观察（见 §4.5）；S3 的 S6 Expert、汇总包、阶段门均未触发。S3 的“未完成”是真实结果，不能当作通过；也不能据此判断是 Skill 引导不足还是模型产出的方案质量所致。
5. **S1 自主拆包**：输入仍要求登记计划，不能证明自主判断；S4 的“不拆共享写范围”是计划级观察。
6. 事件流的截断：技能/长结果在 `--json` 中可能截断，本报告以会话日志为准。
7. **F-N1 的普适性**：本轮 S3 三次评审都用 `packages` 字段，确定性复现证明单包意图会扩为两包返工；但没有跨模型/跨任务样本，不能断定所有模型都会这样写。建议以复现脚本与代码校验复核，而非只凭样本推断。

## 9. 复现与证据索引

- 隔离：`code/setup-isolation.sh`（全新 /tmp 根；源码副本；树指纹；技能哈希；**不复制凭据**）。
- 真实演练入口：`code/run-headless.sh` 已固定拒绝（不启动 DSH/不读凭据/不写工作区，证据 `results/raw/run-headless-disabled.txt`）；没有自动放行门。上一版 `boundary-gate*.txt` 是已移除门的历史诊断，只说明仓库可写，不构成当前授权。历史轨迹用的是旧版 `danger-full-access`，只作为受限观察，不再复跑。
- 运行：`code/run-headless.sh`（headless + `--session-id` 续聊；逐级路径校验；TAG 与输出防覆盖）。
- 确定性预检：`code/preflight-cli.mjs`（23/23，输出 `results/raw/preflight-cli.json`；旧轮次记录保留 `preflight-cli-round1.json`）；安全负例：已有 `cli-preflight`、软链与仓库参数不匹配均被拒绝（`preflight-cli-refusal-existing.txt`、`preflight-cli-refusal-symlink.txt`、`preflight-cli-refusal-repo-arg.txt`）。F-N1 复现（旧版固定目录）与安全版（独占创建、拒绝已有目录/软链）分别在 `results/raw/repro-finding-package-field.txt`、`repro-finding-package-field-safe.txt`，安全版拒绝复用已有目录的证据在 `repro-finding-package-field-refusal.txt`。
- 场景输入：`code/tasks/*.md`（逐字副本 `results/raw/task-*.md`）。
- 原始证据：`results/raw/sessions/`（事件流、err、exit、meta、隔离指纹）、`results/raw/session-logs/`（zstd 会话日志，含成员）、`results/raw/cards/`（完整确认卡原文）、`results/raw/task-reports/`（隔离项目内的交付/评审报告与 journal）、`results/raw/session-facts.json`、`results/raw/analyze-scenarios.json`、`results/raw/write-probe.txt`、`write-probe-safe.txt`、`run-headless-disabled.txt`、`boundary-gate.txt`（历史诊断）、`boundary-gate-run-headless.txt`（历史诊断）、`repro-finding-package-field.txt`、`repro-finding-package-field-safe.txt`、`results/raw/host-fingerprint.txt`；逐文件 SHA-256 见 `results/raw/index.json`。zstd 会话日志是二进制文件，不逐文件登记为交付路径（UTF-8 制品读取会改变字节），但其原始字节哈希已在 index.json，文件保留在目录中。
- 自动套件（源码级支撑，不替代真实行为）：`npm test` = 407 tests / 398 pass / 0 fail / 9 skipped（2026-11-17 21:19–21:20 本机运行，完整日志见 `results/raw/npm-test.log`）。

## 10. 与旧报告的关键差异

| 项 | 旧版（第 3 版） | 本轮（第 4 版） |
| --- | --- | --- |
| 首卡 | open 即签卡；S1 重签卡被旧指令代答（F1） | open/plan 只准备；首次推进签唯一完整卡；S1 三轮均按展示卡 ID 确认 |
| 重签呈现 | 完整重展 | 只呈增量，标明基准卡与折叠数；旧卡 ID 拒绝（预检） |
| S3 汇报 | 两次预测后续波次（F2） | 按实际返回逐波汇报，明确不预告 |
| S3 结果 | Challenger 首轮 accept → 2 次 Expert → 门 | 三轮 Challenger 均 rework → 轮次耗尽用户收敛卡；无 Expert、无汇总、无门 |
| 工具路径 | S1/S3 出现 bash CLI 绕行（F3） | 顶层只用原生工具 |
| 计划非数组 | 字符遍历伪重叠（F4） | 清晰拒绝，无噪声 |
| 隔离证明 | 无写拒绝哨兵；内层 danger-full-access | 增加真实模型会话的 HOME 写拒绝；真实演练入口已固定拒绝（无自动放行门）；仓库仍可写，安全前置明确为“未满足”，旧轨迹降为受限观察 |
| 真实 rework | S5 未触发 | S3 连续三轮真实包级 rework（同时暴露 F-N1） |
| 样本量 | 2 个有效真实场景 + 计划级 | 2 个有效真实场景（S1 完整到门；S3 停在轮次耗尽）+ 计划级 S4；仍为单次样本 |

---

附：本报告由测试 Owner 编写；提交后由非作者 Challenger 复核，再进入人工验收。报告中的所有“通过”均指本轮观察与所引证据支持的范围，不代表普遍结论。
