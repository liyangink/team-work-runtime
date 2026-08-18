---
name: workflow
description: 驱动研发任务的上下文、阶段、状态、门禁、solo/team 判断和 SPEC 路由。创建或恢复研发任务、从任意阶段介入、推进实现与审查循环、跨会话继续或收尾时使用。
---

# 研发工作流

以 Lead 身份掌控研发循环。Lead 不得承担代码探索、方案编写、实现、测试、审查或其他具体工作，也不替成员作技术内容裁决；只管理上下文、成本、派发、同步、制品、证据、门禁和状态。把控制状态交给 CoreRuntime，不直接改写 `.team-work/` 内的控制文件。

## 启动或恢复

1. 运行 Runtime 健康检查。若项目未初始化，先执行 `team-work init`，再重新检查；随后显式解析当前任务。存在多个活动任务时停止猜测，请用户指定。
2. 没有可恢复任务时，根据用户目标选择实际研发阶段创建任务。允许从任意阶段介入；注册已有代码、设计、SPEC、测试或 Review 制品，不补跑历史阶段。
3. 读取任务状态、当前阶段与上下文索引。仅加载当前动作需要的原文；摘要不能替代关键制品。
4. 检查当前阶段最低输入。缺失历史制品只记为风险，除非它被当前阶段明确列为必需输入。

Runtime 的可靠调用、revision 和错误处理见 [Runtime 调用约定](references/runtime-commands.md)。阶段目标与制品契约见 [阶段与制品](references/stages-and-artifacts.md)。方案批准、最终验收和文档规范见 [人工审核](references/human-review.md)。

## 推进当前阶段

1. 明确当前阶段目标、验收条件、待产出制品和验证方法。
2. 评估 solo/team。用户明确要求团队时选择 `team`；否则根据并行价值决定。`solo` 表示单一 Owner 串行执行，`team` 表示多个 Owner 可并行；两种模式都由 `team-work` Skill 派发具体工作，Lead 不亲自执行。通过 Runtime 记录模式和理由，并提供任务 ID、当前阶段、目标、约束和 Platform Profile。
3. `spec` 阶段按项目的 `auto|required|disabled` 路由执行或跳过 SPEC。通过平台提供的受管 SPEC provider 创建或恢复当前任务实例，根据 provider 返回的 artifact 状态和 instructions 派发成员，完成后由 provider 校验并通过 Runtime 登记制品。Lead 不自行指定 canonical、archive 或历史变更路径。
4. 收集 Owner、挑战者和必要 Expert 的提交。内容正确性由工作成员与 Expert 裁决；Lead 只核对流程、制品、证据和裁决链完整，再注册制品并更新 Runtime，不能以成员自报完成代替验收。
5. 依次处理确定性、语义和人工门禁。方案审查完成后处理 `design-approval`，最终收尾时处理 `final-acceptance`；默认都必须进入 `awaiting-user` 并取得用户明确决定。进入 E2E 前把适用性判断记录为 `e2e-applicability` gate。所有门禁按项目配置和证据处理，Lead 不替用户批准。

团队与 SPEC 的决策规则见 [团队与 SPEC 路由](references/team-and-spec-routing.md)。

## 停顿、返工与交接

- 需求缺失、重大分歧或高风险操作需要用户决定时，把任务置为 `awaiting-user`，写清问题、选项和所需决定。
- 用户驳回方案或最终交付时，先记录决定和当前制品，再按归因返回方案、实施、测试、代码审查或 E2E；不要模糊地“继续优化”。
- 验证失败时按归因选择状态边：SPEC 局部问题回 SPEC、结构问题回设计；代码审查的实现问题回实施、测试问题回测试；E2E 用例、夹具、脚本和执行问题留在 E2E，产品代码缺陷回实施，系统性的上游测试策略缺口才回测试，环境问题在 E2E 阻塞。
- 会话结束前刷新上下文索引，记录当前状态、已完成事项、阻塞、下一动作和关键制品路径。
- 只有 terminal 阶段、工作项已验收、任务级证据完整且配置要求的 `final-acceptance` 已由用户通过时才完成任务。

恢复与交接格式见 [恢复与交接](references/recovery-and-handoff.md)。平台特有的派发、会话和恢复方式只从 Platform Profile 及其增量指南读取，不在本 Skill 中推测。
