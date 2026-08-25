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

- **DSH**：根 `package.json` 产出的 `team-work-runtime` 是唯一市场制品，同时携带 Runtime、`tw` CLI、skill、host 插件与 Web client；不存在第二个插件子包。tier→模型的唯一配置源是 DSH 全局 settings 的 `team-work-dsh.tiers`，可在 DSH Web 的“插件配置”页编辑；候选池支持单对象或数组、同波优先不同模型家族，`effort` 可选。每个候选的 provider/model 必填，Web 保存时 Provider 必须 active，且该 Provider 的模型目录必须可验证并实际列出所选模型；模型 RPC 整体失败、候选 Provider 的目录失败或缺少该 Provider 目录时都会阻止保存并给出恢复指引。模型公开非空 effort 列表时，填写值必须命中该列表。项目 `dsh.json` 已废弃且不会被读取/创建，`agents.json` 仍是项目内 child 映射与模型快照事实。自动装载、隔离与工具契约已验证；真实 LLM 注入和最终 Web 样式仍待用户实机确认。
- **OpenCode**：v2 插件已删除；待核心稳定后按规约 §4 seam 另起薄适配器。
- OpenSpec Provider 保留，作为门禁路由检查范本。

### DSH 安装与配置

从 DSH 市场安装时选择 `team-work-runtime` 并指定目标 profile；源码安装同样以仓库根为入口。根制品通过 `cordis.patch.yml` 注册 `team-work-dsh`，Web client 由根清单的 `./client` 导出装载。卸载包名也是 `team-work-runtime`。

启动 DSH Web 后，在“插件配置”页打开 `team-work-dsh`。首次安装可保持空配置；开始配置后，`junior`、`senior`、`expert` 必须同时完整：

```yaml
team-work-dsh:
  tiers:
    junior: [{ provider: <provider-id>, model: <model-id> }]
    senior: [{ provider: <provider-id>, model: <model-id>, effort: <optional-effort-id> }]
    expert: [{ provider: <provider-id>, model: <model-id> }]
```

`injectionEnabled`、`projectRoots`、`twBin` 已失效；项目 `.team-work/platform/dsh.json` 也不再读取。旧键和旧文件确认无用后可手动删除。

## 开发

```bash
npm test          # v3 核心、插件、E2E 与仓库契约
npm pack --dry-run --ignore-scripts  # 验证唯一根制品清单
```

完整自动套件覆盖 v3 核心、插件、E2E 与仓库契约；宿主提供可解析的 Schemastery 依赖时，另执行对应的 settings schema 回归。实现：`runtime-v3/`（waves/gate/derive/store/intake/cli）+`bin/tw.mjs`；复用件：`runtime-v3/persistence`（原子写/锁/稳定读取）、`workflow/definitions`、`team-work/policies`、`spec-providers/openspec`。零 npm 运行时依赖。
