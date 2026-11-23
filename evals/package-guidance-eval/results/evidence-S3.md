# 证据 S3：真实依赖 + 汇总包 + 核心场景 Expert 裁决（design）

> 场景：S3（依赖/汇总）叠加 S6（核心裁决）。真实模型执行；用户答复为预定义模拟剧本（`task-s3b.md`）。
> 判定修订：**流程通过**；turn 1 曾误报“非核心”，在首个 Expert 波派发时已主动纠正；wv6 覆盖审 accept 后又预告“直达人工门”，实际续派 wv7 Expert——共**两次**后续波次误判（低–中严重度，最终由 runtime 兜住）。

## 1. 环境与模型

- 被测 Lead 会话：`session-a05a245e-e163-47e5-8abd-45ec4c96b40e`；cwd `/private/tmp/twr-glm53-eval/project`。
- 模型原始回执：`results/raw/session-model-records.jsonl`，`provider=zai-coding-cn, model=glm-5.3, reasoningEffort=max`。
- 5 个成员子会话（`origin=subagent`）全部 cwd 同隔离项目根、模型同；7 次派发映射见 `results/raw/s3-dispatch-map.json`。

## 2. 计划（tide-plan/packages.json）

| 包 | 写范围 | 依赖 | 完成标准 |
| --- | --- | --- | --- |
| interface-analysis | `docs/design/interface-constraints.md:doc` | 无 | 接口/输入输出/错误约定/约束边界 |
| failure-analysis | `docs/design/failure-recovery.md:doc` | 无 | 故障分类/检测/恢复降级/一致性 |
| merge-final | `docs/design/final-plan.md:doc` | 两上游 | 读取两份分析合并，不改上游 |

三包写范围互斥；只有汇总包带真实 dependsOn，done 写明要读取的路径；逐包模型均 `zai-coding-cn/glm-5.3/max`。意图卡 `intake-83f7fc` 由用户在下一轮（S3b turn 2）确认，**不存在重签代答**（`s3a.jsonl:106` 为当前卡，`s3b.jsonl:7` 为 decide 回执）。

## 3. 实际波次（`s3b.jsonl` + dispatch map）

| 波次 | key | 角色/包 | 成员会话 | 结果 |
| --- | --- | --- | --- | --- |
| wv1 | d1-5f8019 | owner@interface-analysis | 037e4ee7 | 交付 234 行 |
| wv1 | d1-43abb6 | owner@failure-analysis | 3213ec79 | 交付 229 行 |
| wv3 | d3-8383ef | challenger 组合审 | 4723ba67 | accept + 9 接缝 findings |
| wv4 | d4-acf388 | expert 裁决两文组合 | 075fbc8a | accept + 7 组强制闭合清单 |
| wv5 | d5-3c807c | owner@merge-final | 6941867d | 交付 470 行 |
| wv6 | d6-178e49 | challenger 覆盖审三文件 | 4723ba67（续派） | accept + 1 risk + 5 info |
| wv7 | d7-62672b | expert 终裁三文件 | 075fbc8a（续派） | accept + 批准前条件 |
| 门 | — | design 人工门 `dec-1d537b` | — | stop=awaiting-user |

**7 次派发、5 个唯一成员会话**（Challenger 与 Expert 各续派一次）。上一版“7 个成员会话”的说法已更正。

## 4. 时间线（本地 +08:00，来自会话日志）

| 事件 | 时间 |
| --- | --- |
| turn 1（open + plan + roles 解析） | 18:03:05 – 18:06:23 |
| turn 2（用户确认 + 7 波推进） | 18:06:55 – 18:34:11 |
| wv1 两 Owner | 18:07:12 – 18:11:48 |
| 组合审 + 首轮 Expert | 18:11:58 – 18:33:45（4723 / 075f 会话跨越后续续派） |
| 汇总交付 | 18:21:21 – 18:27:17 |
| 到达 design 人工门 | 18:34:11 |

## 5. 判定

| 条件 | 结果 | 说明 |
| --- | --- | --- |
| 只给真实等待设 dependsOn、done 写明读取路径 | 通过 | merge-final 依赖两上游 |
| 依赖包写范围仍互斥 | 通过 | 三个不同文件 |
| 汇总包在实际获派后读取上游、独占最终产物 | 通过 | merge 交付 470 行，上游未改（行数/抽查） |
| 组合挑战按实际波次 | 通过 | wv3 两文组合；wv6 三文件新组合 |
| 核心场景非作者 Expert 裁决 | 通过 | wv4/wv7 |
| 汇总后新鲜裁决 | 通过 | wv7 在 wv5 后重新裁决 |
| 人工门静止 | 通过 | stop=awaiting-user |
| 用户面陈述与 policy 一致 | **部分失败** | turn 1 误报非核心；wv4 时主动纠正 |

## 6. 发现

1. **后续波次误判（低–中，引导相关，共两次）**：turn 1 报告称“按非核心场景处理……不自动加 Expert 裁决轮”；实际 policy 中 `design` 的 teamScene 仍是 `design` 且 `scenes.design.core=true`，运行时派出了两轮 Expert。Lead 在首个 Expert 派发时主动纠正（`s3b.jsonl:63`）。第二次在 wv6 覆盖审 accept 后，简报写“accept 则进入 design 阶段门”（`s3b.jsonl:93`），实际运行时续派 wv7 Expert（`s3b.jsonl:101`），随后才到门。两次都是用户预期偏差，均在派发后纠正或由 runtime 兜住。
   - 最小建议：技能“裁决与汇总”条写明“查 workflow 阶段的 teamScene，再查 `scenes[teamScene].core`，不能由 risk 档或包数推断”。
2. **派发 note 与角色不符（低）**：wv4 Expert 的 note 写“推合并波次”，wv5 汇总包写“裁决通过 推合并包”；label 正确但 note 会误读。
3. **正面**：7 次派发/5 个会话的依赖、组合审、两轮裁决、汇总后重审均真实发生；人工门未代答。

## 7. 未覆盖

- Challenger rework 与包级返工（两轮审查均 accept）；
- Expert rework 整组返工；
- 同轮版本变化/已审内容变化；
- 人工门未签。
