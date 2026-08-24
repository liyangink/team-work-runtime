# runtime-v3 · store 模块说明

> 交付物：code-review 阶段 store 包模块说明文档。
> 对应源码：`runtime-v3/store.mjs`，以及它复用的 `runtime/persistence/transactions.mjs`。
> 本文档仅说明 **store** 模块自身（职责、关键函数、数据流、失败模式）；intake 模块与 store/intake 协作边界属其他包（intake 包、overview 包）分工，不在本文档内。
> 原则锚点：AGENTS 规则 P1（目录即状态）、I3（索引缺失/损坏时从不可变事实重建）、I8（原地修订新快照）。

---

## 1. 职责

`store` 是**任务目录 I/O 层**：它是任务目录（`.team-work/tasks/<name>/`）的**唯一写入通道**，负责初始化、读取、登记与原子落盘任务状态文件。它**不推导状态、不做门禁判定、不做交付/评审校验业务**——它只保证「目录读写正确、原子、带锁、路径安全」。

它复用 v2 保留下来的 persistence 原语（`runtime/persistence/transactions.mjs`）：
- `atomicWrite` / `atomicJson`：写临时文件 + `rename` + 目录 `fsync` 的原子落盘（失败回收临时文件），保证任意时刻目标文件要么是完整旧内容要么是完整新内容；
- `withOwnerLock`：任务目录内 `locks/task.lock` 的互斥锁，含**孤儿锁回收**（超龄损坏锁、持有进程已退出时回收），使读-算-写整体串行化。

---

## 2. 任务目录结构与关键文件

`controlRoot = <projectRoot>/.team-work`；`taskRoot = controlRoot/tasks/<name>`；归档在 `controlRoot/archive/<name>`。

| 路径 | 写入时机 | 内容 |
| --- | --- | --- |
| `project.json` | 首次任务初始化 | 项目版本标记 `{runtimeMajor:3, schema:"v3", createdAt}`（E2E-19；已存在则不动，含 v1 遗留） |
| `intent.json` | `initTask` | 目标/约束/排除/修订/风险档 |
| `scope.json` | `initTask` | entry/completion/stages/workflowDigest/createdAt |
| `artifacts.json` | 初始化 + deliver 登记 + 索引重建 | `{items:[{path,digest,kind,stage,reportRef,snapshotRef}]}`（制品登记索引） |
| `journal.jsonl` | 追加事件 | 事件日志（task-opened / dispatched / report-accepted / stage-advanced / decision-issued / decided / task-completed） |
| `decisions.json` | `appendDecision` | `{items:[决策]}`（单文件数组，避免目录遍历） |
| `reports/<id>.json` | intake 侧写入（store 只读） | 每报告一条，文件名即报告身份 |
| `snapshots/<digest>.json` | intake 侧写入（store 只读） | 制品内容快照（按 digest 命名） |
| `gates/`、`locks/` | 内部 | 门凭证目录 / 任务锁目录 |

> 注：`reports/**` 与 `snapshots/**` 的**写入**由 intake 负责；`store` 在 `loadTask`/`rebuildArtifacts` 中**读取**它们。下表与数据流仅体现 store 自身的职责边界。

---

## 3. 关键函数

- `validName(name)`：任务名白名单校验（`^[a-z0-9][a-z0-9-]{0,63}$`）。非法名在 `taskRoot` 路径拼接前就拒绝（防御路径注入）。
- `controlRoot / taskRoot / archiveRoot`：路径解析；`taskRoot``archiveRoot` 内再次校验名字，否则抛 `TASK_NAME_INVALID`。
- `taskExists(name)`：以 `scope.json` 是否存在判定任务存在（**目录即状态，存在性看事实文件**）。
- `initTask(...)`：创建目录骨架 + 原子写 `project.json`/`intent.json`/`scope.json`/`artifacts.json` + 写 journal 首条 `task-opened`。重复 open 抛 `TASK_EXISTS`。
- `loadTask(...)`：并行读取 scope/intent/artifacts/decisions/journal/reports/packages，返回已解析任务对象（供 derive/gate/waves/intake 消费）。支持 `I3 索引重建`：若 `artifacts.json.items` 非数组（缺失/损坏），从**不可变事实**（reports + snapshots）重建，再原子写回。
- `rebuildArtifacts`：索引重建实现——收集 snapshots 中各路径最新快照，从 deliver 报告的重建 items；**重建产物（kind 字段）一律硬编码为 `"misc"`**（见下「实现细节」）。
- `appendDecision / listDecisions`：决定单文件数组读写（决定数量少，>1 时用锁串行化）。
- 导出 `atomicWrite / atomicJson / withOwnerLock / readJson` 供 intake、dsh-map 等复用。

### 3.1 rebuildArtifacts 实现细节（含已知取舍）

源码实现（`store.mjs`）：
1. 遍历 `snapshots/*.json`，按 `snap.path` 保留**最新 `at`** 的快照，得 `byPath`。
2. 遍历 deliver 报告，构建 `kindByPath`（注释为「最近的 deliver 决定 kind」，但实际写入时 **值为 `null`**）。
3. 再遍历 deliver 报告，对每个 path：若 `byPath` 有对应快照且尚未加入 items，则 push `{path, digest, kind: "misc", stage, reportRef, snapshotRef}`。

**观察/取舍**：重建时 `kind` 字段被**硬编码为 `"misc"`**，并未使用上一步构建的 `kindByPath`（其值恒为 `null`，实际未参与取值）。这是索引重建的一个已知简化：重建的是「哪些路径是已登记的登记制品」，而**产出物 kind 无法从不可变事实无歧义还原**（deliver 报告只记录 path，不记录该路径的 kind；kind 的真实来源是派单 writable 的 artifactKind，重建路径上不可得），故以 `misc` 兜底。这意味着：**索引一旦重建，重建条目的 kind 不再精确对应派单产出物类型**；若下游门禁以 kind 判定阶段产出物在场（gate 的 `stageDef.outputs` 按 kind 匹配），重建条目可能无法命中某些 kind 要求——这是需要在文档/测试中显式意识到的边界，而非文档声称的「推导 kind」。

---

## 4. 数据流（store 侧）

`initTask`（CLI open）→ 创建目录 + 初始事实文件
↓
`loadTask`（CLI run/deliver/review/dispatch-plan 前置）→ 解析全部事实 →（含 I3 索引重建）→ 交给 `deriveTask`（状态推导，derive/gate/waves 纯函数消费）
↓
intake 的 deliver/review 通过 `withOwnerLock`（store 导出的同一把锁）在锁内登记报告/快照/索引
↓
再次 `loadTask` 读到新事实，derive/gate 据此重算

闭环：**store 读取事实 → 纯函数推导 → 派发 →（intake 写盘）→ store 再读**。`store` 自身是读写的落点，不参与推导。

---

## 5. 失败模式与处置

| 失败模式 | 触发 | 处置/恢复 |
| --- | --- | --- |
| `TASK_NAME_INVALID` | 任务名非法 | 在路径拼接前拒绝，改合法名 |
| `TASK_EXISTS` | `open` 重复同名 | 提示换名或用 `run` 继续（幂等） |
| `TASK_NOT_FOUND` | 引用不存在任务 | CLI 提示 open 创建 |
| `STATE_CORRUPT` | 事实文件非 JSON | `readJson` 捕获 `SyntaxError` 抛损坏；索引走 I3 重建 |
| 锁不可用 `LOCK_UNAVAILABLE` | 401 次尝试仍被占 | 孤儿锁回收优先；报锁占用原因 |
| 并发写竞态 | 并发 `run` / deliver | 判定与写入同在锁内，锁内重推导保证只推进一次 |
| `artifacts.json` 缺失/损坏 | 索引不可信 | `loadTask` 从 reports+snapshots 不可变事实重建（I3），再原子写回 |

---

## 6. 边界声明（store 之外，不属本文档展开）

- **制品内容稳定读取**（逐段拒符号链接、读中变化检测、realpath 防逃逸，I1）：由 `runtime/persistence/file-artifact-repository.mjs` 的 `readStableArtifact` 承担，intake 封装使用；store 不接触制品内容稳定读取。
- **交付/评审校验与登记**：属 intake 模块分工。
- **store 与 intake 协作边界、整体架构定位**：属 overview 包分工。
