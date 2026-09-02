# Runtime v3 模块说明：intake（`runtime-v3/intake.mjs`）

> 交付物：code-review 阶段 intake 包模块说明文档。
> 本文档仅说明 `intake` 模块；store 模块见 store 包文档，两模块协作总览见 overview 包文档。
> 基于源码事实撰写，行数 220。不修改任何实现。

---

## 一、职责

`intake` 是 **deliver / review 的调用内同步总检查与登记层**（P2：一次查完全部欠账，当场返回，禁止异步拒绝 / 第二层对模型不可见的校验）。它承担：

1. **派单身份寻址**：用 `dispatchKey`（run 派发时生成、写进派单文本；成员从派单照抄，是寻址不是簿记，符合 P4）定位 journal 中的派单合同，核验角色。
2. **参数形状校验**：对 payload 做逐一检查（deliver 的 outcome/summary/paths/checks/unresolved；review 的 summary/recommendation/findings/verdict），不通过即返回结构化 `INTAKE_REJECTED` + 全量 reasons。
3. **可写范围与路径安全校验**：`paths ⊆ 派单可写集`（精确条目或尾斜杠目录条目，见 `domain/writable.mjs`）；交付路径必须项目内相对路径（复用 `persistence/file-artifact-repository` 的 `readStableArtifact` 稳定读取：符号链接拒绝、读中变化检测、realpath 防逃逸，I1）。
4. **登记 + 快照 + 审计**：把交付物登记进 `artifacts.json`、写入 `snapshots/<digest>.json`、落盘 `reports/<reportId>.json`、追加 `journal` 的 `report-accepted` 事件。
5. **幂等与并发安全**：同 key 同 payload 重提交返回幂等接受不追加事件；读-算-写整体在任务锁内，并发 deliver/review 不丢登记（E2E-10/复核修复）。
6. **为门禁与波次提供证据**：写入 review 报告的 `taskSha`（与 gate 的 `artifactsFingerprint` 同公式）与 `reviewedPackages`（评审时各包最新轮次，P4），供 gate/waves 精确判定“评审是否覆盖某包某交付”。

## 二、关键函数

| 函数 | 作用 | 关键行为 / 失败码 |
| --- | --- | --- |
| `reject(reasons)` | 构造 `INTAKE_REJECTED` 错误 | 携带 `reasons[]` |
| `normalizeRelative(value)` | 规整交付路径为项目内相对路径 | 拒绝绝对路径 / `./` / 空段 / `..`，返回 null |
| `findDispatch(journal, dispatchKey)` | journal 中检索派单合同 | 匹配 `type=dispatched && detail.key` |
| `freshState(task)` | 执行时从磁盘重读最新 journal/artifacts/reports | 并发提交与跨进程重试以此为准 |
| `parseJournal(raw)` | journal 行解析 | — |
| `readStable(projectRoot, relativePath)` | 稳定读取 + 计算 digest | 包装 `ARTIFACT_MISSING`/`ARTIFACT_PATH_ESCAPE`/`ARTIFACT_UNSTABLE` 为带指引的 `INTAKE_REJECTED` |
| `registerDelivery(...)` | **Owner 交卷入口** | 任务锁包裹 → `deliverLocked` |
| `deliverLocked(...)` | deliver 全量校验 + 落盘 | 见 §四 |
| `registerReview(...)` | **评审入口** | 任务锁包裹 → `reviewLocked` |
| `reviewLocked(...)` | review 全量校验 + 落盘 | 见 §五 |
| `currentStageOf(journal, scope)` | 从 journal 尾部推导当前阶段 | 无 stage-advanced 事件时退回 scope.entry |

## 三、数据流总览

```
CLI deliver/review
  └─> loadTask()（store 前置装载）
       └─> registerDelivery / registerReview
            ├─ withOwnerLock(locks/task.lock) 进入任务锁
            ├─ freshState() 重读磁盘最新事实（并发/跨进程以磁盘为准）
            ├─ findDispatch() 定位派单合同 + 角色校验
            ├─ 事件层幂等判定（同 key 同 payload → 幂等接受）
            ├─ payload 形状 / 可写集 / 稳定读取 校验（不通过 → INTAKE_REJECTED 全量 reasons）
            ├─ 原子落盘：snapshots/**、reports/<id>.json、artifacts.json、journal 追加
            └─ 返回 accepted / 拒绝文本（含修复指引）
之后 CLI run → derive → gate/waves 消费新报告与制品
```

intake 复用 store 导出的 `readJson` 与持久层 `atomicJson/atomicWrite/withOwnerLock`，以及 persistence 的 `readStableArtifact` / `digestValue`。

## 四、deliver（Owner 交卷）流程

1. `registerDelivery` 在任务锁内调用 `deliverLocked`。
2. `freshState` 重读最新事实；`findDispatch` 验证 key 对应**有效 Owner 派单**，否则拒绝（提示从派单文本原样复制 `--key`）。
3. 校验 payload：`outcome` ∈ {delivered, blocked}；`summary` 非空；`paths` 为数组；每路径经 `normalizeRelative` 规范化且**必须 ∈ 派单 writable 集合**（`domain/writable.mjs`：条目精确匹配，尾斜杠 = 目录授权其下全部路径，kind 继承条目 artifactKind；范围外拒绝文案内嵌 blocked 升级引导——任务确需范围外路径时以 blocked 交付说明，由 Lead 扩权重派）；delivered 但无登记路径且 writable 非空时拒绝；`checks` 逐条 name + result∈{pass,fail,not-run}。
4. **事件层幂等**：同 key 同 payload 重交（重试/重复提交）返回同一接受结果，不追加第二条 `report-accepted`（payload 变化才是真实修订，照常覆盖）。
5. 全部通过后一次性落盘（I10）：逐路径 `readStable` 计算 digest → 写 `snapshots/<digest>.json`（原地修订 = 新 digest 新快照，旧快照保留，I8/E2E-16）→ 写 `reports/deliver-<key>.json` → 更新 `artifacts.json`（同路径原地修订覆盖，`reportRef`/`snapshotRef` 指向本报告与快照）→ 追加 journal `report-accepted`。
6. 返回 `{reportId, accepted:true, registered}`。

落盘顺序关键点：**先读全部路径并算 digest（任何路径失败即整体拒绝，不产生部分快照），再逐个写快照/报告/索引/journal**——失败不留半态，单路径失败不留孤儿快照。

## 五、review（Challenger/Expert 阅卷）流程

1. `registerReview` 在任务锁内调用 `reviewLocked`；`findDispatch` 验证 role ∈ {challenger, expert}。
2. 校验 payload：`summary` 非空；`recommendation` ∈ {accept, rework, escalate}，**只评价被审的这版交付**（E2E-09，产品缺陷写 findings）；`findings` 每条 severity∈{info,risk,blocker} + statement；**Expert 必填 `verdict`**（outcome/rationale/confidence/recommendedAction；outcome ∈ accept|rework|choose-option|need-more-evidence|escalate-to-user），Challenger 不得带 verdict。
3. **事件层幂等**：同 key 同 payload 重交返回同一结果。
4. 计算被审指纹 `taskSha = artifactsFingerprint(当前阶段制品 items)`（与 gate 的 `artifactsFingerprint` 同公式），门禁可校验裁决绑定的是当前制品。
5. 推导 `reviewedPackages`：评审时该阶段各包最新 deliver 轮次（P4，runtime 自有事实，不依赖时间戳近似）——波次机据此精确判定“评审是否覆盖某包最新交付”（同包更高轮次 = 未覆盖）。
6. 落盘 `reports/review-<key>.json`（含 `taskSha`/`reviewedPackages`/payload/at）+ 追加 journal `report-accepted`；返回 `{reportId, accepted:true, reviewedDigest:taskSha}`。

## 六、失败模式与处置

| 失败模式 | 触发 | 处置 / 恢复 |
| --- | --- | --- |
| 派单身份无效 / 角色不符 | deliver 非 owner、review 非 challenger|expert | `INTAKE_REJECTED`，提示从派单文本原样复制 `--key` |
| outcome 非法 | deliver 非 delivered|blocked | 拒绝 |
| summary 空 | deliver/review 均必填 | 拒绝 |
| paths 非数组 / 非法路径 / 越可写集 | deliver | 逐条收集 reason；delivered 无可写路径且可写集非空时拒绝（纯反驳需确认派单允许无产出交付） |
| checks 格式错误 | deliver | 需要 name 与 result∈{pass,fail,not-run} |
| recommendation 非法 | review | 只接受 accept|rework|escalate |
| findings 格式错误 | review | 需要 severity∈{info,risk,blocker} 与 statement |
| verdict 归属错误 | review | 仅 expert 可填；非 expert 填则拒绝 |
| 制品读取失败 | deliver 的 readStable | 缺失→提示先创建；符号链接/越项目根/读中变化→带修复指引的 `INTAKE_REJECTED` |
| 同 key 重复提交 | 重试/重复调用 | 事件层幂等，返回同一接受结果，不追加第二条 `report-accepted` |
| 并发 deliver/review | 并发写 | 判定与写入同锁（`withOwnerLock`），锁内 `freshState` 重读，不丢登记 |

## 七、模块边界（一句话）

intake 是“工具调用内同步全量检查”（P2）与“成员事实写入”的守门人：它校验派单身份、载荷、可写集与制品合法性，只有通过全量检查的交付才原子落盘（快照/报告/索引/journal），并为 gate/waves 提供 `taskSha` 与 `reviewedPackages` 证据。**intake 不推导状态、不改写 scope、不推进阶段**——那些是 derive/gate/CLI 的职责。
