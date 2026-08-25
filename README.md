# team-work-runtime

平台无关的多智能体研发 Harness：任务目录即状态，工具调用即检查点，门只在阶段流转。

> **v3（工具中心重写）** 已完成核心实现与真实任务验证；v2 及 OpenCode 插件已于 2026-08-21 删除（Git 历史可查）。验收规约：[`docs/runtime-v3-charter.md`](docs/runtime-v3-charter.md)，进度：[`docs/runtime-roadmap.md`](docs/runtime-roadmap.md)。

## 核心概念

- **房间与门**：成员在派单内自由工作（派单全文内嵌上下文），检查只发生在两处——交付工具调用内（单一、同步、全量）与阶段门（产出物在场 + 检查通过 + 非作者评审在场 + 核心场景 Expert 裁决 + 人工门凭证）。
- **任务目录即状态**：`.team-work/tasks/<name>/` 下的 intent/scope/reports/decisions/gates/snapshots/journal 是事实源，一切判定可纯函数重推导。
- **CLI 即接口**：模型通过 shell 调用 `tw`；`--help` 即完整 meta，拒绝输出自带修复指引。
- **制品两分法**：阶段产出物显式登记（路径即身份、digest 快照）；输入上下文由 objective 自然语言承载，不登记不检查。

## QuickStart

```bash
# Lead：开任务（名字寻址；重名拒绝）→ 推进（每次一步，返回卡片/派单）
tw open --name audit-q3 --objective "审查 X，重点安全" --entry code-review
tw run  --task audit-q3 --writable CODE_REVIEW.md:code-review   # 派单文本内嵌全部上下文

# 成员（Owner 交卷 / Challenger·Expert 阅卷）
tw deliver --task audit-q3 --key <派单key> --outcome delivered --summary "..." --paths CODE_REVIEW.md
tw review  --task audit-q3 --key <派单key> --recommendation accept --summary "..."

# 决定、路由、归档
tw decide  --task audit-q3 --choice 1
tw route   --task audit-q3 --route e2e --decision skip --basis "纯静态改动"
tw archive --task audit-q3
```

`awaiting-user` 是静止状态：门签发后任务停止推进，只由新的用户输入恢复；完成后重复 `run` 幂等返回同一卡片。

## 平台绑定

- **DSH（进行中）**：唯一 skill（`skills/team-work-v3/`，含拓扑/成本/场景指导）+ `tw` CLI + 后台 subagent 派发；真实任务 E2E 已验证（含人工门返工轮，五次成员交互零参数拒绝）。插件包（`dsh plugin add` 形态）规划中。
- **OpenCode**：v2 插件已删除；待核心稳定后按规约 §4 seam 另起薄适配器。
- OpenSpec Provider 保留，作为门禁路由检查范本。

## 开发

```bash
npm test          # 38 项：v3 核心/intake/CLI/不变量 + 仓库契约
```

实现：`runtime-v3/`（waves/gate/derive/store/intake/cli，约 1k 行）+`bin/tw.mjs`；复用件：`runtime-v3/persistence`（原子写/锁/稳定读取）、`workflow/definitions`、`team-work/policies`、`spec-providers/openspec`。零 npm 运行时依赖。
