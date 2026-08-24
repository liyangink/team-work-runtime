# 拓扑与成本（v3）

## 成本原则

- Junior 是默认 Owner 主力：常规探索、实现、测试、第一轮审查起草。
- Senior 承担非作者挑战与复杂边界判断；Challenger 默认 Senior。
- Expert 通常只引入 1 位，用于核心场景裁决（policy `core: true` 的场景门禁强制要求）；第二位 Expert 仅用于不可逆决策、关键证据冲突、反复验证失败或用户明确要求。
- 同档候选优先模型多样性；活跃成员 3–5 人为软上限，人数不能替代清晰边界。

## 角色（与 tw 工具的对应）

- **Lead**：流程与完整性核对，不做技术裁决；`tw open/run/decide/intent/route` 的调用者，派单的转发者。
- **Owner**：唯一范围与制品负责人；`tw deliver` 交付，回应轮=同路径原地修订或证据反驳。
- **Challenger（Senior）**：非作者攻击事实/推理/边界/失败路径；只出 findings 与 recommendation，不改制品。
- **Expert**：核心环节技术裁决；`tw review --verdict`，返工后制品变化会强制重新裁决（新鲜度）。

## 场景 → 最低充分拓扑

| 场景 | 最低拓扑 | 升级条件 |
| --- | --- | --- |
| 调研 | Junior Owner + Senior Challenger | 跨领域或高风险事实冲突加 Expert |
| 方案设计 | Junior 事实位 + Senior Owner/挑战 + Expert | 关键证据冲突加第二 Expert |
| 串行实现 | 一个 Owner + Senior Challenger | 核心/高风险实现加非作者 Expert |
| 并行施工 | 多个互斥可写范围 Owner + Senior Challenger | 复杂核心重构加 Expert 裁决 |
| 测试 | Junior Owner + Senior Challenger | 安全/迁移/并发/反复失败加 Expert |
| 代码审查 | 全视角 Owner + Senior Challenger + Expert | 通用阈值内考虑第二 Expert |

## 三轮收敛

每轮都有挑战者：Owner 产出 → Challenger 可验证问题 → Owner 独立核验修订 → 核心场景 Expert 裁决。第三轮只验证关闭条件与残余风险，不重新发散。三轮未收敛 `tw run` 会给出 [追加一轮 / 结束任务] 卡片，由用户决定；追加必须目标明确。
