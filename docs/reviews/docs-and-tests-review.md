# docs-and-tests 包代码审查报告

- 任务：twr-framework-re-arch-code-review · 阶段 code-review · 角色 owner（包 docs-and-tests）；轮次 1（wv1，key d1-015f4d）交付，轮次 2（wv4，key d4-7434f5）按 review-d3-cede5f 修订，轮次 3（wv7，key d7-752a21）按 review-d6-c89e0f 更正统计口径，轮次 4（wv11，key d11-05580a）按 Expert 裁决（review-d10-d624f4，用户授权追加轮）核验三处覆盖误判并调整判定。
- 审查基线：runtime-v3/twr-framework-architecture-design.md，SHA-256 实测 6668e09bb5686267e5f7b58040e76c18bb3b1adebaa9d7e4c9e45cfbfcb21b8b，与派单声明一致（2026-11-20 实测，shasum -a 256）。
- 审查性质：只读代码审查；未修改任何源码、技能、测试或冻结设计基线。
- 结论先行（轮次 2 修订后）：本包完成标准满足——skills/team-work-v3/、team-work/rules/、docs/ 及 tests/ 的实施改动与设计方案 §9 验证矩阵及文档契约逐项对照完成，核心覆盖真实（完整测试套件 479 项中 467 项通过；3 项失败全部位于 tests/evals-harness.test.mjs，该文件及其全部静态依赖 git diff 为空、与本次变更无 import 交集，具体根因未逐项定位、未做基线回放，标为环境相关未确认，见 §2.1）。矩阵 28 行现判定为 18 行充分、9 行部分、1 行缺口（轮次 3 更正统计口径；轮次 4 按 Expert 裁决将【多包多卡和前置门】降为部分——普通批准分支未验证存在未决迁移冲突前置卡时的拒绝写入行为，并在【返工语义】行补记 Expert 定点选择性返工分支无直接断言）；降级的 4 行（宿主直接对账、旧 key 用户取舍、每包完整清单、返工语义）均系 Challenger 指出后逐条核验成立——所引用例只覆盖子场景，不足以支撑充分判定（核验记录见 §7）。另发现 2 项顺手修正与 3 项次要覆盖缺口均非阻塞；1 项实现与冻结方案正文差异（续派原 ID 不可见时换新 key 确定性 ID 重建）按指令标为待核实（见 §4.1）。

## 1. 实际覆盖范围

以 git status/diff 对照工作区实际变更，本包范围内改动共 24 个文件（23 个修改 + 1 个新增），全部逐一读取 diff 或全文核查：

| 区域 | 文件 | 改动量（+/- 行） |
| --- | --- | --- |
| skills | skills/team-work-v3/SKILL.md | 80 |
| skills | skills/team-work-v3/references/dsh-orchestration.md | 38 |
| skills | skills/team-work-v3/references/rules.md | 2 |
| skills | skills/team-work-v3/references/scenarios.md | 16 |
| skills | skills/team-work-v3/references/topology-and-cost.md | 31 |
| rules | team-work/rules/challenger/README.md | 3 |
| docs | docs/file-inventory.json | 22 |
| docs | docs/twr-framework-architecture-design.md（新增） | 链接适配副本 |
| tests | tests/dsh-dispatch.test.mjs | 1042 |
| tests | tests/dsh-subagent-session.test.mjs | 163 |
| tests | tests/e2e-b-matrix.test.mjs | 6 |
| tests | tests/repository-contract.test.mjs | 267 |
| tests | tests/runtime-v3-cli.test.mjs | 2186 |
| tests | tests/runtime-v3-concurrency.test.mjs | 91 |
| tests | tests/runtime-v3-core.test.mjs | 32 |
| tests | tests/runtime-v3-dsh.test.mjs | 35 |
| tests | tests/runtime-v3-intake.test.mjs | 68 |
| tests | tests/runtime-v3-invariants.test.mjs | 86 |
| tests | tests/runtime-v3-rules-lazy.test.mjs | 9 |
| tests | tests/runtime-v3-rules.test.mjs | 9 |
| tests | tests/runtime-v3-topology.test.mjs | 154 |
| tests | tests/runtime-v3-waves-regression.test.mjs | 154 |
| tests | tests/support/v3-fixtures.mjs | 63 |
| tests | tests/tag-hints-runtime.test.mjs | 11 |

未纳入逐行审查（范围界定事实，非遗漏掩盖）：

- 工作区另有其他任务产物：docs/glm53-eval-findings-fix-plan.md、docs/lead-reporting-alignment-plan.md、docs/parallel-package-guidance-plan.md、docs/prompt-injection-optimization-plan.md（未跟踪）及 evals/glm53-latest-eval/、evals/package-guidance-eval/。前三者与 evals 两个目录已（部分）登记 file-inventory.json，但内容与本次架构重构无直接关系，未逐行审查。
- runtime-core/dsh-binding 两包（runtime-v3/ 源码、dsh/、policy/）不在本包职责内，仅在做文档契约一致性与轮次 2 差异核验时定点引用（行号见 §3/§4.1）。
- 本审查未运行真实 LLM 实机演练、未做本机插件目录安装（派单排除项）。

## 2. 测试运行证据（覆盖真实性的核心验证）

命令：node --test tests/*.test.mjs（仓库根，package.json test 脚本等价展开为 20 个文件）。实测（2026-11-20，46.7s）：

- tests 479 · pass 467 · fail 3 · skipped 9 · cancelled 0。
- 本次修改的 17 个测试文件（含 runtime-v3-*、dsh-*、repository-contract、e2e-b-matrix、tag-hints）全部通过，无本包范围内失败。
- 9 个 skipped 为条件跳过：e2e-root.test.mjs:17 与 dsh-plugin-e2e.test.mjs:16（未指定 DSH_TEST_HOST，隔离宿主验证未执行）、evals-harness.test.mjs 5 项（PYTHON3/SQLITE3_SKIP_REASON，tests/evals-harness.test.mjs:707、718）。真实宿主收单语义验证在设计方案 §9 末段已显式列为待获取的证据，此处跳过与设计声明一致，不构成虚假覆盖。

### 2.1 evals-harness 3 项失败的报错证据与范围判断（轮次 2 修订）

单跑 node --test tests/evals-harness.test.mjs 复现，3 项失败的实际报错：

- tests/evals-harness.test.mjs:254 guardDir 测试：AssertionError [ERR_ASSERTION] urllib.request.urlopen 必须失败，null !== 1（at :278）——被 guard 环境包装的 python3 子进程以 status=null 退出形态结束（execFileSync 非正常退出），而非预期的退出码 1 + 离线提示文案（:279 期望 /离线评测环境：Python 外部网络访问已被禁用/）。该测试把 PATH 前置 guardDir、PYTHONPATH 指向 guardDir（:258），行为依赖本机 python3 与网络环境细节。
- tests/evals-harness.test.mjs:2954 uh3 基线：Expected 13, actual 0（at :2959）。
- tests/evals-harness.test.mjs:3058 uh3 线程亲和：在导入线程创建 sqlite3 连接的合规实现必须得 100 分，15 !== 100（at :3073）。两项均通过 gradeUltraHardTask 以本机 python3 子进程评分。

范围判断的可复查证据（只读命令）：

- git diff HEAD --stat -- tests/evals-harness.test.mjs evals/runner.mjs evals/zstd-log.mjs evals/grade.mjs evals/pricing.mjs 输出为空：该测试与其全部被测模块均无未提交修改；git status 对 evals/ 已跟踪文件亦无 M 项（仅两个未跟踪评测目录）。
- tests/evals-harness.test.mjs 的 import 集（:1-12）只含 node 内置模块与 evals/pricing.mjs、evals/zstd-log.mjs、evals/runner.mjs、evals/grade.mjs——与本次 33 文件变更清单交集为空，无运行时依赖路径。
- 本机环境实测：系统 python3 为 3.9.6（sqlite3 3.54.0 在场）；无 guard 的裸 urllib 请求在本机同样失败（网络受限环境）。

结论口径（按指令收敛）：上述 3 项失败与本次重构在代码与依赖结构上无交集（结构证据如上）；但具体根因（guard 链在 3.9.6 的行为、uh3 探针与该版本的匹配性）未逐项定位，也未回放 HEAD 基线验证改动前同样失败，故标为环境相关·根因未确认，不作为与重构无关的定论。

## 3. §9 验证矩阵逐行覆盖核查（轮次 2 修订）

对照设计方案 §9（runtime-v3/twr-framework-architecture-design.md:207-238）逐行映射到 tests/ 实际用例（判定：✓ 充分 / ◐ 部分 / ✗ 缺口）：

| 矩阵行 | 覆盖位置（文件:行） | 判定 |
| --- | --- | --- |
| Ghost Wave | dsh-dispatch.test.mjs 新增【continuation 活会话未见本轮正文且无活动证明：不投递不创建】【活会话未见本轮正文但有可靠旧轮活动与通知标记时只等待旧轮（wait-prior-turn）】【混合在途项中未确认收单不被健康项掩盖，可靠旧轮信号聚合 wait-prior-turn】 | ✓ |
| 同 key 重试 | dsh-dispatch.test.mjs【报告已存在或波已作废时重验状态，不访问宿主或发送】【首次登记后重验发现已报告或作废时绝不创建】【已报告即使冻结正文损坏也短路】 | ✓ |
| 并发 | dsh-dispatch.test.mjs【同 key 并发在共享投递锁内对账，不会重复创建】【两个进程同 key 投递锁不允许临界区交叠】【多包波：两张派单逐张串行登记→重验→创建】【旧写者未停写和续派映射缺失均阻止自动投递】；runtime-v3-concurrency.test.mjs 并发 open/首卡/屏障/重拆 4 项 | ✓ |
| 宿主直接对账 | dsh-dispatch.test.mjs【首次登记只创建一次并复核收单】【精确块比对排除继承前缀、宿主前置文本及相似 key】【日志读取、持久化屏障或关闭失败均保持 recover 且不重投】【续投后消息回执、flush 或精确收单无法确认时不得称健康】；dsh-subagent-session.test.mjs 9 项收单原语。但其中【续派原 ID 当前不可见时，以新 key 的确定性 ID 重建并发送全量正文】（:1988-1998，断言 action=fresh_rebuilt、sessionId=deterministicSessionId(task,key)）与【用户裁决下当前不可见的创建可重试】（:2135-2146）对应的行为与冻结方案 §4.2:72 以该 ID 创建、§4.3-3:81 不自动换 ID 存在正文差异，且均为 mock 夹具断言（:2146 断言消息自述模拟的不可见状态下允许重试但不证明真实宿主无重复），不证明真实宿主无迟到/重复——差异与授权缺口见 §4.1 | ◐（待核实） |
| 波事实 | runtime-v3-cli.test.mjs【journal 故障：多成员派发读错不提交半波且原样可重试】及 journal 故障系列 | ✓ |
| Deliver | runtime-v3-cli.test.mjs【普通 deliver 事务故障注入：快照写失败与 journal 提交前失败均零半提交】【普通 deliver 提交后视图/回执丢失：同 key 同字节重交幂等】；符号链接逃逸 intake.test.mjs:151-172。blocked 带路径负面断言未见（D5） | ◐ |
| Lead 授权刷新 | runtime-v3-cli.test.mjs【Lead 授权刷新：准备卡列完整清单与候选 SHA…】【刷新授权边界：缺 reason 拒绝；确认前磁盘再变 → 旧卡不可确认并要求重签；未确认不产生新基线】 | ✓ |
| 多卡按 ID 决定 | runtime-v3-cli.test.mjs【多卡并存按 decisionId 交叉：人工门 C1 与刷新卡 C2 并存，确认 C2 收口 C1 为 superseded 而非 accept】 | ✓ |
| 刷新后旧门收口 | runtime-v3-cli.test.mjs【刷新原子性故障注入：快照写失败与 journal 提交失败均无半提交（决定/新基线/旧门收口全有或全无）】 | ✓ |
| 恢复 C1 与取消 C2 | runtime-v3-cli.test.mjs 同名测试（磁盘恢复 H1 后 C1 按原 ID 批准且不自动取消 C2） | ✓ |
| 刷新卡重签 | runtime-v3-cli.test.mjs【刷新授权边界】+【刷新提交后回执/索引丢失：同 decisionId 幂等重显原结果】 | ✓ |
| 多包多卡和前置门 | 展示前置已覆盖：runtime-v3-cli.test.mjs【多包刷新卡交叉】【候选恢复取消隔离】【候选恢复生效使旧刷新卡失效】；dsh-dispatch.test.mjs【人工门保留全部待决、失效和阻塞包】；waves-regression.test.mjs:1008-1044 F9 加固断言迁移冲突卡 pending 期间 run 静止、零新增派发、intake 照常接受交付。缺口：拒绝写入分支——存在未决迁移冲突前置卡时对普通人工门卡执行肯定性 decide 应被拒绝且不落决定，无任何断言（F9 加固 :1039 只 decide 了迁移取舍卡本身；autoCaller 通道会掩盖普通 decide 的拒绝形态） | ◐（轮次 4 降级） |
| 多卡兼容与故障 | runtime-v3-cli.test.mjs【旧意图卡 ID 遇到人工门不得错答】【确认卡 ID 随机数撞号时重试】【journal 故障：decide 读错不落决定】；v3-fixtures asLegacyTask | ✓ |
| 刷新授权和原子性 | 同刷新原子性故障注入 + 幂等重显 | ✓ |
| 旧 key 用户取舍（§9:225） | 已覆盖子场景：waves-regression.test.mjs:354-386（同轮跨 key 双交付 → 迁移出多版本取舍卡）、:390-414（旧 key 同字节幂等/异内容 ver+1 均不消费人工返工）、invariants.test.mjs:96-116（跨 key 清单扩展重交）。缺口：设计 225 行的完整序列——d1 交 X → d2 交 X/Y → d1 迟到以新 X 重交使 Y 移出有效清单、旧评审/人工门指纹随之失效、Lead 版本链核查——无端到端断言；【旧评审/人工门指纹失效】仅刷新卡 C2 路径（多卡并存按 decisionId 交叉）有覆盖，普通旧 key 迟到重交触发指纹失效未见 | ◐（轮次 2 降级） |
| 历史快照恢复 | runtime-v3-cli.test.mjs【历史快照恢复：默认恢复当前有效基线；--list 列版本；--source 显式选历史；恢复不改有效清单】 | ✓ |
| 报告事务 | runtime-v3-cli.test.mjs deliver 事务故障注入系列 + journal 故障系列；invariants.test.mjs:118-133 孤立报告不进登记 | ✓ |
| 每包完整清单（§9:228） | 已覆盖子场景：invariants.test.mjs:81-134 同 key ver+1（组 1）、跨 key 重交（组 2）、同 digest（组 3）、损坏索引重建逐字段等价（:118-125）、孤立报告不进登记；cli.test.mjs:1954-1990 刷新准备对照。缺口：三组交付清单只扩不缩（组 3 :103 注释声称未列入路径将被完整清单语义移出，但组 3 清单 A,B,B2 仍全部重新列入，无任何路径被移出）；全库检索（移出/removed）无【仅交 X 时 Y 移出有效清单且磁盘文件保留】的直接断言——设计 228 行核心判据之一未落地验证 | ◐（轮次 2 降级） |
| 作废波完整回退 | runtime-v3-waves-regression.test.mjs F3 系列（retire 幂等矩阵、部分交付后 retire、投影排除、回退） | ✓ |
| 旧任务和摘要转换 | runtime-v3-cli.test.mjs【旧摘要协议转换：digestValue 无损迁移为 sha256-bytes-v1，重跑幂等】【旧增量歧义与证据缺失：三源不一致保留原件引导授权刷新】；非 UTF-8 字节用例 | ✓ |
| 协议与 Expert | runtime-v3-intake.test.mjs:174-183（Expert verdict 形状）、185-217（scope 形状枚举全拒绝且不落 journal/报告）、219-239（匿名单 Owner 只能 all-covered、损坏计划 fail-closed）；core.test.mjs 双结论组合。finding 顶层旧 package/packages 字段名直接拒绝的负面断言未见（D5） | ◐ |
| 返工语义（§9:232） | 已覆盖子场景：单包点名重派（runtime-v3-rules.test.mjs:735-746，scope packages 点名 perspective-1 → respond.package=perspective-1）、多包分列 must-fix+context 提交级（intake.test.mjs:207-216）、人工门返工仅重派未修包（waves-regression.test.mjs:682-732，:718 reworkStalemate 只含未修包、:721-722 仅重派该包）、core.test.mjs I6 裁决链。缺口：设计 232 行的【全组+具名混合（一条 all-covered 与一条 packages 点名并存，任一 all-covered 即覆盖全体）】【一条 finding 点多个包】【依赖包不被误解锁】无直接断言；waves-regression.test.mjs:205-304 为单 Owner 续派用例，不能证明多包混合并集语义。分清全组与定点（轮次 4 补记）：全组分支有 topology.test.mjs:320-344（verdict rework 无归属 → :339 断言全组 respond 两包、每个包派单内嵌裁决原因）；Expert 定点分支（verdict=rework 携 must-fix scope packages → 仅重派点名包）无直接断言——waves-regression.test.mjs:588-615 exh-t 的 verdict rework 走【回 challenger 复审】链（:609）而非定点重派 owner，topology.test.mjs:252-257 仅为 Challenger 定点 | ◐（轮次 2 降级，轮次 4 补记定点缺口） |
| 原始字节 SHA 与新鲜度 | runtime-v3-cli.test.mjs【非 UTF-8 原始字节：NUL 与无效字节的 SHA-256、bytes-v1 快照与 restore 逐字节无损】；core.test.mjs 人工门绑定制品指纹（artifactFingerprints + decision-issued/decided 同 ID 匹配）；刷新授权边界（确认前磁盘再变拒绝）。ABA 竞态按设计 §6.2 为如实声明的限制而非可测判据 | ✓ |
| 按包阻塞恢复 | runtime-v3-topology.test.mjs:100-128（blocked 静止卡、扩权重跑不解除、--resolve-blocked 恢复卡确认后重派）、130-169（多包 blocked：计划变更不自动解除 b）；runtime-v3-cli.test.mjs 候选恢复系列 | ✓ |
| 规则路径（F-N2） | runtime-v3-rules.test.mjs:448（Lead 通道三层：用户公共优先、项目追加、旁路副本忽略）、617（成员卡单块正文不收 Lead 正文）；help 出口 leadGeneralRules 组装无直接断言（D4） | ◐ |
| 迁移与回退 | 旧摘要协议转换（重跑幂等）+ waves-regression F9 系列（半迁移可续跑、跨阶段不误并、冲突卡静止） | ✓ |
| 开销和保密 | 未找到任何对应测试（无 journal 大小/耗时记录、无冻结正文凭据检查用例） | ✗（D3） |
| 集成验收 | e2e-b-matrix.test.mjs:47-97 F-10（三视角并行 + 汇总包依赖锁 → 组合评审 → Expert → 汇总解锁 → 评审链 → E2E skip → 人工门 → completed）为多包全链但属 accept 直通，无返工后完整重交 X/Y 组合场景与全套报告实际成功/失败/跳过数产物 | ◐（D6） |

抽样核验断言真实性（非空壳）：intake.test.mjs:201-206 对 8 种非法 scope 逐一断言 INTAKE_REJECTED 且 journal 逐字节不变；invariants.test.mjs:118-124 断言重建与损坏前登记逐字段等价；topology.test.mjs:113-122 断言未确认恢复前扩权重跑不解除 blocked；waves-regression.test.mjs:398-409 断言旧 key 同/异内容重交均不消费返工。以上均为行为级断言，非仅不抛错。

## 4. 文档契约一致性核查

- SKILL.md：分包六步、findings 必须 disposition=must-fix + 显式 scope、--decision-id 多卡审批、--resolve-blocked 按包恢复卡、tw restore --list/--source、tw refresh-artifacts、tw retire 整波作废、deliver 完整清单语义、首卡/增量重签卡——逐条与设计方案 §5/§6.1/§6.2.1/§6.2.2/§6.3 及 cli.mjs help 文本（cli.mjs:4395-4421）一致。
- references/dsh-orchestration.md：续派对账语义（wait-children 仅证明宿主收单、wait-prior-turn、promptFrozen/promptDigest 重算、AGENTS_STATE_CORRUPT 不自动重建、retire 后旧写者证实要求、restore/refresh-artifacts 恢复边、实时字节 SHA）与设计 §4/§6.2 一致；其【映射缺失：不得仅凭映射缺失推定旧会话不存在……仅在可靠证明原会话活/冷均不存在且不会再执行时才同 ID fresh 重建并回填映射】的表述与冻结方案 §4.2 一致，但与 dsh/tw-dispatch.js:317-326 实际按新 key 确定性 ID 重建的实现存在张力（见 §4.1）。
- references/rules.md 与 dsh-orchestration.md 的 help 通道替代 skill 指路：与 F-N2 修复实现（cli.mjs:4386-4393 helpCard 返回 leadGeneralRules/leadGeneralRulesSources）一致。
- references/scenarios.md、topology-and-cost.md、team-work/rules/challenger/README.md：must-fix/scope、verdict 一致性矩阵、blockedPackages/package-recovery——与设计 §5/§6.3 及 intake 测试一致。
- --risk 与 tier 语法糖：CLI 实现保留（cli.mjs:1455 校验 --risk、3826 tier: 解析、4397-4398 help 仍列两参数），Skill/引导文删除相关段落，并由 tests/repository-contract.test.mjs 新增【正式派发选档与核心场景预测已从 Skill 清理】锁定——属刻意的能力保留 + 引导收敛，文档与实现无矛盾（e2e-b-matrix.test.mjs:55,64 仍用包级 tier 语法糖夹具，与 cli.mjs:1194 兼容路径对应）。
- docs/twr-framework-architecture-design.md：与 runtime-v3/ 冻结基线逐行比对，25 行差异经路径归一化后全部一致——仅为文档移位后的相对链接适配，无实质内容差异；docs/file-inventory.json 已同步登记（符合设计 §1/§8.4 迁移要求）。

### 4.1 实现与冻结方案的正文差异（跨包事项，待核实）

轮次 2 按 Challenger 跨包意见与 Lead 指令核验并如实记录（本包不对实现修法下结论）：

- 实现：dsh/subagent-session.js:6-15 将 persistence.stat 未命中记为 { status: none }（stat 不可用/异常记 unknown）；dsh/tw-dispatch.js:317-326 在【原续派 ID 当前不可见（none）且本 key 尚无映射且 expectedAgentId 等于该 ID】时，priorAgentId 记录原 ID 后改用 deterministicSessionId(task, key)（新 key 的确定性 ID）重建，:411-429 在 none 分支 createSubagent 并返回 action=fresh_rebuilt（:429）。代码注释（:317-318）自述 none 仅是当前观察，不证明旧调用不可能迟到，并称按用户裁决使用新 key 的确定性 ID。
- 冻结方案正文：§4.2 表（runtime-v3/twr-framework-architecture-design.md:72）要求【宿主可靠确认该 sessionId 活/冷均不存在 → 原 ID 登记不变，以该 ID 创建并投完整正文】；§4.3-3（:81）要求【短暂未查到记录不等于安全未发送……不自动换 ID、删除会话或无证重投】。实现换用新 key 的 ID 重建与以该 ID 创建的正文要求存在差异（未覆盖旧 ID，但构成换 ID 重建路径）。
- 测试实际断言：tests/dsh-dispatch.test.mjs:1988-1998 断言 fresh_rebuilt、sessionId=新 key 确定性 ID、mappings 指向新 ID（mock 夹具）；:2135-2146 断言回执丢失后允许重试，:2146 断言消息自述【模拟的不可见状态下允许重试但不证明真实宿主无重复】。测试名称中的【用户裁决下】不能当作授权文档引用。
- 授权状态：Lead 告知实施期间用户曾裁决允许该行为；该裁决未合入冻结方案（本报告已通读冻结方案全文 299 行，§4.2/§4.3 无此例外），工作区与冻结方案中亦无可定位的裁决文档（本角色不读取 .team-work 任务内部状态，无法自行核验任务 decisions）。按指令明确标注：fresh_rebuilt 行为源于实施期用户对话裁决但未合入冻结方案，且不代表无迟到/重复风险；真实宿主下旧调用迟到或同 ID 重复创建的风险未验证。此差异的裁决证据补齐或方案修订属 Lead/用户事项，本报告仅记录事实与待核实状态。轮次 4 补充处置方向（Expert 裁决）：F-7 待 Lead 核对用户裁决原文，并安排以后在隔离宿主中的验收；本轮不更改实现、测试或冻结设计，也不据此批准安装或发布。

## 5. 发现清单

均非阻塞；每条注明位置、影响与建议。

- D1（本次修改引入·顺手修正）：tests/runtime-v3-core.test.mjs:175 残留调试输出 if (!accepted.passed) console.log("DBG gate blockers:", ...)。仅失败路径打印，不影响测试行为；建议删除。
- D2（本次修改引入·顺手修正）：skills/team-work-v3/references/topology-and-cost.md 尾部链接锚点 rules.md#lead-通道skill-指路与工具反吐——rules.md 对应标题已改为 Lead 规则通道（help 读取 + 工具反吐），旧锚点失效。建议同步改为新标题锚点。
- D3（覆盖缺口·非阻塞建议）：设计 §9 开销和保密行在 tests/ 中无任何对应用例。建议后续补基准型测试或显式记录为遗留项。
- D4（覆盖缺口·非阻塞建议）：F-N2 的 help 出口（cli.mjs:4389-4393 组装 leadGeneralRules、缺失时省略字段）无直接测试断言；三层解析已有 runtime-v3-rules.test.mjs:448 覆盖。建议补一条对 tw help 返回字段的断言。
- D5（覆盖缺口·非阻塞建议）：SKILL.md:97/help（cli.mjs:4411-4412）/dsh-orchestration.md 均声明 blocked 必须 paths 为空、旧 package/packages 字段会被拒绝并提示替换写法，tests/ 未见这两条负面路径的直接断言。建议补负面用例。
- D6（部分覆盖·非阻塞）：§9 集成验收行的返工后完整重交 X/Y 组合场景无端到端用例（e2e-b-matrix F-10 为 accept 直通链）。
- D10（轮次 2 新增·覆盖缺口汇总·非阻塞）：矩阵降级行共同构成测试矩阵缺口——清单缩小语义（仅交 X 时 Y 移出）、旧 key 迟到重交的完整取舍序列与旧评审/人工门指纹失效、全组+具名混合并集与依赖不解锁、Expert 定点选择性返工分支（verdict=rework + scope packages 仅重派点名包）、迁移冲突未决时普通批准的拒绝写入、宿主对账换 ID 重建与冻结正文的差异（§4.1）。均建议随后续测试任务补齐，本轮不改测试（派单排除）。
- D11（轮次 4 新增·本次修改引入·测试断言放宽，非阻塞记录）：tests/runtime-v3-cli.test.mjs【包级模型变更：续派出换模型卡（target=package），回滚恢复 packages[].model 后按旧模型续派】相对 HEAD 放宽了回滚验证——HEAD 版本断言回滚后重签意图卡内容（resign.card.intake.packages[0].modelRef.modelName === "cli-junior"，即回滚后的完整计划必须进入确认链），新版（现 :1301-1303）删除该断言，改为 decisionId 前缀宽松检查（回滚改变配置指纹：重签待决卡（换模型/意图卡均可））。触发条件：包模型换模回滚（decide 选 3）后重签卡为非意图卡或卡内模型未回滚时测试仍通过；影响：若实现存在回滚只写 packages.json 视图、未把完整计划写入 journal 决定提交的回归，该测试不再拦截（对应 Expert 裁决指出的产品缺陷方向，core 包报告负责补记缺陷本体）；最小必要修正建议：恢复对重签卡类型的结构化断言（意图卡且 intake.packages 列出回滚后模型）。本条为测试覆盖记录，本轮不改测试（派单排除）。有效计划与文件视图的区分据此明确：现有测试断言 journal 存在 re-planned 事件（:1299）与 packages.json 视图回滚（:1298），未断言完整计划与决定同一次 journal 提交。
- D7（范围外记录）：docs/prompt-injection-optimization-plan.md 为工作区未跟踪文件且未登记 docs/file-inventory.json（其余 3 个新增 plan 文档已登记）。属其他任务遗留，与本次重构无直接关系；按仓库规范新增文件必须同步清单，提请后续任务处理。
- D8（范围外记录）：AGENTS.md 当前基线仍把 risk 升档、tier 语法糖描述为在用能力并详述选档预测，本次 Skill 清理后根文档未同步（AGENTS.md 不在本次修改清单）。属文档滞后，提请 Lead 评估是否随本次或后续任务更新。
- D9（观察项·设计方案已自声明）：runtime-v3/twr-framework-architecture-design.md 原件保留（冻结基线）且 docs/ 副本并存；package.json 打包整个 runtime-v3/ 会携带原件。设计方案 §1（:13）已自行声明此风险，无需本轮处理。

## 6. 审查边界与未验证事项

- 覆盖真实性结论以 §2 实测运行为准；测试全部在无隔离宿主环境下执行（DSH_TEST_HOST 未设），真实宿主收单/通知语义（设计 §9 末段待获取的证据）未验证，与派单排除项一致。
- evals-harness 3 项失败标为环境相关·根因未确认（§2.1）：未逐项定位 guard/uh3 在本机 python3 3.9.6 上的失败机制，未回放 HEAD 基线。
- 未对 runtime-core/dsh-binding 包的实现正确性下结论（其他 Owner 职责）；§4.1 的实现与冻结方案差异仅按指令记录事实并标待核实，不裁定修法。
- docs/ 下其他三个 plan 文档与 evals/ 两个目录未逐行审查（非本次范围）。
- 工作区存在其他任务未提交产物，若 Lead 以 git diff 全量口径核对 33 个文件，注意与派单口径的差集（本包按目录职责圈定 24 个文件）。

## 7. 轮次 2 意见核验与修订记录（key d4-7434f5）

对 Challenger rework 意见与本轮 Lead 指令（review-d3-cede5f）的逐条独立核验结论：

| 意见 | 核验结论 | 处置 |
| --- | --- | --- |
| invariants.test.mjs:90-116 无未列路径移出断言，不足以支撑完整清单行充分判定 | 成立：组 1-3 清单只扩不缩（组 3 :103 注释声称移出语义但 :107 清单 A,B,B2 全部重新列入），全库检索无清单缩小直接断言 | 矩阵行降为 ◐（§3） |
| waves-regression:354-386/390-409 非 §9:225 完整场景（d1=X、d2=X/Y、d1 迟到重交 X + 旧评审/人工门失效） | 成立：354-386 为同轮迁移取舍、390-414 为旧 key 重交不消费人工返工；指纹失效仅刷新卡路径有覆盖 | 矩阵行降为 ◐（§3） |
| waves-regression:205-304 单 Owner 续派不能证明 §9:232 全组+具名、context 混合并集 | 成立：单包点名（rules.test:735）、提交级混合（intake:207-216）、人工门返工仅重派未修包（waves-regression:682-732）为子场景；全组+具名混合、一 finding 多包、依赖不解锁无断言 | 矩阵行降为 ◐（§3） |
| 3 项 evals-harness 失败归因不足（未证明根因或基线已存在） | 成立：原表述以未修改 + 环境推断下定论，越出了证据范围 | §2.1 重写：单跑报错 + 依赖结构证据 + python3 3.9.6 环境事实，结论收敛为环境相关·根因未确认 |
| 跨包：宿主对账充分判定未交代实现与冻结方案差异及授权 | 成立（本包份额）：原 ✓ 判定依据含 fresh_rebuilt 用例而未核对冻结正文 | 矩阵行降为 ◐（待核实）；§4.1 新增差异记录：fresh_rebuilt 源于实施期用户对话裁决但未合入冻结方案、mock 断言不证明真实宿主无迟到/重复、授权证据标待核实 |

修订范围声明：本轮仅修改本报告文档（可写路径内），未修改任何源码、测试或设计基线；矩阵降级只反映测试覆盖口径修正，不构成对实现正确性的新结论。

### 轮次 3 记录（key d7-752a21，review-d6-c89e0f）

- Challenger 本轮唯一 blocker（core-and-binding-review.md 的 F-2 触发条件排他性、旧新协议混合下 report-committed 无 seq 锚）归属 core-and-binding 包可写路径，不在本包制品范围；本报告未对评审新鲜度/seq 锚主题下过结论，无需同步修改（核对：本报告矩阵【原始字节 SHA 与新鲜度】行仅涉及字节核验与人工门指纹，不含 report-accepted/report-committed 排序结论）。
- 非阻塞统计更正（成立并已执行）：逐行复核 §3 表格实有 28 行——判定分布 19 充分（✓）、8 部分（◐：宿主直接对账、Deliver、旧 key 用户取舍、每包完整清单、协议与 Expert、返工语义、规则路径、集成验收）、1 缺口（✗：开销和保密）；首段此前两轮的 29/25/3/1、21/7/1 统计均系漏计/误计（轮次 1 表格即含集成验收 ◐ 行而首段记 3 部分）。表格内容与行号判定本身不受影响。
- 宿主裁决原文待核实的状态（§4.1）维持不变。

### 轮次 4 记录（key d11-05580a，Expert 裁决 review-d10-d624f4，用户授权追加轮）

对 Expert 裁决与 Lead 指令（review-d10-d624f4）三处覆盖误判的独立核验结论（均成立）：

| 指令点 | 核验证据 | 处置 |
| --- | --- | --- |
| topology.test.mjs:320-344 仅覆盖全组返工，未覆盖 Expert 定点选择性返工分支 | 成立：:339 断言 verdict rework 无归属 → 全组 respond（两包）；全库检索 verdict rework 用例中 exh-t（waves-regression:588-615）为 verdict rework 后回 challenger 复审链（:609），topology:252-257 为 Challenger 定点；无 verdict=rework + scope packages 仅重派点名包的直接断言 | 【返工语义】行补记定点缺口（维持 ◐） |
| cli.test.mjs:1295-1307 包模型回滚断言相较 HEAD 放宽，掩盖回滚未写入有效计划的回归 | 成立：git show HEAD 对比确认旧版断言 resign.card.intake.packages[0].modelRef.modelName === cli-junior 被删除，改为 decisionId 前缀检查（换模型/意图卡均可）；现版仅断言 journal 存在 re-planned 事件与 packages.json 视图 | 新增 D11（测试断言放宽记录 + 有效计划与文件视图区分） |
| 多包多卡和前置门不能判充分：普通批准分支未验证未决迁移冲突前置卡时的拒绝写入 | 成立：F9 加固（waves-regression:1008-1044）只断言展示静止（:1029-1033 run 重呈迁移卡、零新增派发）与迁移取舍卡自身 decide（:1039）；无【存在未决迁移冲突卡时对普通人工门执行肯定性 decide → 拒绝且不落决定】断言 | 矩阵行降为 ◐，行内区分展示前置（有断言）与拒绝写入（缺口） |

统计同步：矩阵 28 行 = 18 充分 + 9 部分 + 1 缺口（多包多卡和前置门 ✓→◐），首段已同步。F-7 处置方向按裁决补入 §4.1（待 Lead 核对用户裁决原文并安排以后隔离宿主验收）。本轮仅修改本报告，未改源码、测试或冻结设计。
