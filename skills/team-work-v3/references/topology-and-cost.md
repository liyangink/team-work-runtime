# 拓扑与成本（v3）

## 角色与档位（两个正交体系，先分清再谈选择）

| | 角色 role | 档位 tier |
| --- | --- | --- |
| 是什么 | 波次类型：owner 交付 / challenger 挑战 / expert 裁决 | 模型预算：junior / senior / expert |
| 由谁定 | 波次机；**每轮每角色恰好一个成员**（结构事实，非用量限制） | 派发点：场景默认档 + 包 tier 覆盖 + risk 兜底 |
| 对应工具 | deliver / review / review --verdict | DSH 全局 `team-work-dsh.tiers` 候选池（同波家族去重挑选） |

映射事实（policy 默认）：owner 波用场景默认档（junior 居多），包 tier 可覆盖（高于默认触发升档审批卡）；challenger 波固定 challengerTier（默认 senior——挑战是质量闸门，不随包降档）；裁决波固定 expert 档（核心场景最后一道闸）。

由此：**expert 档的 owner 完全正常**——架构决策、安全审查类包定 tier: expert（升档卡授权后生效），多个 expert 档 owner 并行也正常。需要第二专业意见时用只读子派单采集（结论由发起成员整合，不进收敛），正式裁决链仍是单裁决者。

## 定档原则（预算语义，非能力证书）

默认 junior + 按失败成本升档。junior 档胜任绝大多数常规作业（代码调研、检索、信息搜集、总结、翻译、非复杂技术文档、常规实现与测试）——不是"只能机械作业"。升档不看"任务听起来难"，看做错的代价：审查链本来就会揪错，错误可发现、返工便宜就留默认档。

| 升到 | 判据（失败成本 × 可发现性） | 示例 |
| --- | --- | --- |
| senior | 错误难发现或返工贵，仍在可审范围 | 跨文件重构、并发敏感实现、疑难调试、外部接口对接 |
| expert | 不可逆 / 极难发现 / 安全敏感 | 架构决策、安全审查、数据迁移、协议正确性、核心算法 |

- 不确定就缺省（junior + 审查链兜底），值得升才升；
- risk = 任务级风险敏感度（用户 `--risk` 显式给）：仅对未定 tier 的包兜底抬档且免审批；包显式 tier 优先——risk 任务里的外围机械包保持默认档；
- 档位不匹配的客观信号：同包连续 2 轮被同类打回 → Lead re-plan 升档（走升档卡）。unresolved 上抛（成员自述力有不逮）是兜底，不作设计依赖；选模数据归平台侧积累，不进任务循环。

## 角色（与 tw 工具的对应）

- **Lead**：流程与完整性核对，不做技术裁决；`tw open/plan/run/decide/intent/route` 的调用者，派单的转发者。
- **Owner**：唯一范围与制品负责人；`tw deliver` 交付，回应轮 = 同路径原地修订或证据反驳。
- **Challenger**：非作者攻击事实/推理/边界/失败路径；只出 findings 与 recommendation，不改制品；组合评审的 findings 标包归属。
- **Expert（裁决者）**：核心场景技术裁决；`tw review --verdict`；制品变化强制重新裁决（新鲜度）。

## 并发与多样性事实

- 哪些场景有裁决波由 policy `core: true` 决定（design/spec/design-review/spec-review/code-review/e2e）；
- 并行成员数 = 当波包数，受 policy `concurrencySoftLimit`（4）约束；拆包多于该值时波次机自动分波推进；
- 每档候选池来自全局 `team-work-dsh.tiers`：兼容单对象或数组，provider/model 必填，family 与 effort 可选；同波多 owner 自动家族去重选模（候选池序 + diversityWithinTier）。项目 `dsh.json` 已废弃，`agents.json` 只保留子代理映射与已派发快照；
- 非 core 场景遇高风险事实冲突：用 risk/包 tier 升 owner 档 + 只读子派单采第二意见，不虚构"临时加裁决者"路径。

## 三轮收敛

每轮都有挑战者：Owner 产出 → Challenger 可验证问题 → Owner 独立核验修订 → 核心场景 Expert 裁决。第三轮只验证关闭条件与残余风险，不重新发散。三轮未收敛 `tw run` 会给出 [追加一轮 / 结束任务] 卡片，由用户决定；追加必须目标明确。
