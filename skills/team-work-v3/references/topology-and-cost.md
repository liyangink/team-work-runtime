# 拓扑与成本（v3）

## 角色与档位（两个正交体系，先分清再谈选择）

| | 角色 role | 档位 tier |
| --- | --- | --- |
| 是什么 | 波次类型：owner 交付 / challenger 挑战 / expert 裁决 | 模型预算：junior / senior / expert |
| 由谁定 | 波次机；Owner 按包派发，组合挑战与核心裁决沿用单成员链 | 派发点：场景默认档 + 包 tier 覆盖 + risk 兜底 |
| 对应工具 | deliver / review / review --verdict | 当前 DSH profile 的 `team-work-dsh.tiers` 候选池（同波家族去重挑选） |

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
- 同包连续 2 轮被同类打回时，先核对返工的需求关系、证据和授权；缺少范围依据不等于模型档位不足。确认能力与失败成本确需升档后，Lead re-plan（走升档卡）。unresolved 上抛（成员自述力有不逮）是兜底，不作设计依赖；选模数据归平台侧积累，不进任务循环。

## 角色（与 tw 工具的对应）

- 已收到带角色、范围与交付指令的派单就是成员；不执行 Lead 的开任务、拆包和正式波次派发，不因总目标或八视角目录重建团队。只读助手仅查本职责内的限定小问题，junior、可写为空、不得继续委托，由成员核验整合。
- **Lead**：流程与完整性核对，不做技术裁决；`tw open/plan/dispatch-plan/run 查状态/decide/intent/route` 的调用者，派单的转发者（DSH 内经 tw-dispatch 派发）。
- **Owner**：唯一范围与制品负责人；`tw deliver` 交付，回应轮 = 同路径原地修订或证据反驳。
- **Challenger**：非作者攻击事实/推理/边界/失败路径；只出 findings 与 recommendation，不改制品；组合评审的 findings 标包归属。
- **Expert（裁决者）**：核心场景技术裁决；`tw review --verdict`；制品变化强制重新裁决（新鲜度）。

各角色共享本轮验收基线。Owner 独立核验并可证据反驳；Challenger 的 rework findings 只放本轮关闭依据，其他发现保留在摘要或已有交付物；Expert 区别技术风险与修复授权，扩大需求由 Lead 先请用户决定。详细分流见[场景指导](scenarios.md#验收基线与意见分流)。

审查默认正式轻量交叉：一个 Owner 与非作者 Challenger 从相关互补视角工作，核心 Expert 照旧。交叉视角不要求一视角一包；Lead 仅在范围确需独立交付时拆包。完整八视角由 Lead 按实际复杂度、失败成本与用户要求组织一次，返工先复核变更及关联视角；覆盖选择是语义判断，不是 Runtime 自动选档。

## 并发与多样性事实

- 哪些场景有裁决波由 policy `core: true` 决定（design/spec/design-review/spec-review/code-review/e2e）；
- 并行成员数 = 当波包数，受 policy `concurrencySoftLimit`（4）约束；拆包多于该值时波次机自动分波推进；
- 每档候选池来自当前 profile 的 `team-work-dsh.tiers`：同一 profile 的项目共用，无项目覆盖；兼容单对象或数组，provider/model 必填，family 与 effort 可选。同波多 owner 自动家族去重选模；宿主每次操作取快照，变化只影响后波，已派波次的精确模型快照在 journal。任务 `agents.json` 只保存派单到子会话的 mappings；
- 无宿主终端由调用方通过 `TW_DSH_CONFIG` 显式提供 `{tiers,entryId:"team-work-dsh",profile:<来源或 unresolved>}` JSON，不读旧 YAML 或项目 `dsh.json`；`tw models` 显示来源；
- 普通选档委派、只读助手和 `@` 候选使用原生工具，tiers 的 effort 转为 `reasoning_effort`。枚举目录不等于允许名单，目录未列出时可按 provider+model 精确查询；正式波次由 `tw-dispatch` 创建前交宿主核验精确模型；
- 非 core 场景遇高风险事实冲突：用 risk/包 tier 升 owner 档 + 只读子派单采第二意见，不虚构"临时加裁决者"路径。

## 三轮收敛

明晰表达只用派单/卡片自动带入的同源短段，不增加文案角色或审查轮次；独立技能可单独使用，不要求在 TWR 双调用。短段送达成本与模型档位分开核对，规则装载缺失不产生升档或人工门，见[引导库](guidance.md#明晰规则自动带入)。

每轮都有挑战者：Owner 产出 → Challenger 可验证问题 → Owner 独立核验修订或反驳 → 核心场景 Expert 裁决。复审先查阻塞关闭及修改回归，已关闭事项无新证据不重开；第三轮聚焦关闭条件与残余风险。新重大问题仍可提出，须说明证据与本轮关系，不能以轮次或成本强行接受缺陷。三轮未收敛，`tw-dispatch` / `tw dispatch-plan` 推进会给出 [追加一轮 / 结束任务] 卡片，由用户决定；追加必须目标明确。
