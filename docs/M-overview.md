# runtime-v3 · overview：store 与 intake 模块总览与协作边界

> 交付物：code-review 阶段 overview 包总览文档。
> 整合依据：store 包文档（docs/M-store.md）与 intake 包文档（docs/M-intake.md）已收敛的结论。
> 本文档同时给出两模块各自的职责/关键函数/数据流/失败模式要点，并显式划定 store 与 intake 的协作边界与整体架构定位。

---

## 1. 一句话定位

"store" 是任务目录 I/O 层（唯一写入通道，保证目录读写正确、原子、带锁、路径安全）；"intake" 是 deliver/review 调用内同步总检查与登记层（P2：一次查完全部欠账，只有通过全量校验的交付才原子落盘，并为门禁/波次提供证据）。两者都不推导状态、不做门禁判定：推导与推进是 derive/gate/waves/CLI 的职责。

---

## 2. store 模块（详见 docs/M-store.md）

### 2.1 职责
任务目录（.team-work/tasks/<name>/）的唯一写入通道：初始化、读取、登记、原子落盘任务状态文件。不推导状态、不做门禁、不做交付/评审校验业务。复用 v2 保留的 persistence 原语：atomicWrite/atomicJson（临时文件 + rename + 目录 fsync，失败回收临时文件）与 withOwnerLock（任务锁，含孤儿锁回收），使读-算-写整体串行化。

### 2.2 关键函数
- validName(name)：任务名白名单校验（^[a-z0-9][a-z0-9-]{0,63}$），路径拼接前拒绝（防路径注入）。
- controlRoot/taskRoot/archiveRoot：路径解析，taskRoot/archiveRoot 内再校验名字，否则 TASK_NAME_INVALID。
- taskExists(name)：以 scope.json 是否存在判定（目录即状态）。
- initTask(...)：建目录骨架 + 原子写 project/intent/scope/artifacts + journal 首条 task-opened；重复 open 抛 TASK_EXISTS。
- loadTask(...)：并行读取全部事实返回任务对象；支持 I3 索引重建（artifacts 缺失/损坏时从不可变事实 reports+snapshots 重建再原子写回）。
- rebuildArtifacts：索引重建实现；重建条目的 kind 字段硬编码为 "misc"（见失败模式/边界，是关键取舍）。
- appendDecision/listDecisions：决定单文件数组读写。
- 导出 atomicWrite/atomicJson/withOwnerLock/readJson 供 intake、dsh-map 复用。

### 2.3 数据流（store 侧）
initTask（open）→ 建目录+初始事实 → loadTask（run/deliver/review/dispatch-plan 前置）→ 解析事实（含 I3 重建）→ 交给 deriveTask 纯函数 →（intake 在锁内写盘）→ 再次 loadTask 读到新事实 → derive/gate 重算。闭环：store 读事实 → 纯函数推导 → 派发 →（intake 写盘）→ store 再读。

### 2.4 失败模式
TASK_NAME_INVALID / TASK_EXISTS / TASK_NOT_FOUND / STATE_CORRUPT（readJson 捕获 SyntaxError） / LOCK_UNAVAILABLE（孤儿锁回收优先） / 并发写竞态（判定与写入同在锁内） / artifacts.json 缺失损坏（I3 重建再原子写回）。

---

## 3. intake 模块（详见 docs/M-intake.md）

### 3.1 职责
deliver/review 的调用内同步总检查与登记层（P2）。承担：派单身份寻址（dispatchKey，P4）、参数形状校验、可写范围与路径安全校验（复用 readStableArtifact：符号链接拒绝/读中变化检测/realpath 防逃逸，I1）、登记+快照+审计、幂等与并发安全、为门禁与波次提供证据（taskSha 与 reviewedPackages）。

### 3.2 关键函数
reject / normalizeRelative / findDispatch / freshState（执行时重读磁盘） / parseJournal / readStable / registerDelivery→deliverLocked（Owner 交卷）/ registerReview→reviewLocked（Challenger/Expert 阅卷）/ currentStageOf。

### 3.3 数据流（intake 侧）
CLI deliver/review → loadTask（store 装载）→ registerDelivery/registerReview → withOwnerLock 进锁 → freshState 重读 → findDispatch 角色校验 → 事件层幂等 → 形状/可写集/稳定读取校验 → 原子落盘（snapshots/**、reports/<id>.json、artifacts.json、journal 追加）→ 返回 accepted/拒绝文本。之后 CLI run → derive → gate/waves 消费新报告与制品。

### 3.4 失败模式
派单身份无效/角色不符、outcome/summary/paths/checks 非法、recommendation/findings/verdict 格式或归属错误、制品读取失败（缺失/符号链接/越项目根/读中变化）、同 key 重复提交（事件层幂等）、并发写（同锁 + freshState 重读）。

---

## 4. 协作边界与整体架构定位

### 4.1 边界切分（谁写什么）
| 职责 | 归属 | 说明 |
| --- | --- | --- |
| 任务目录唯一写入通道（初始化/读取/登记/原子落盘） | store | 目录读写、锁、路径安全 |
| intent.json/scope.json/project.json/artifacts.json/journal/decisions | store | 状态事实写入/追加 |
| reports/<id>.json 与 snapshots/<digest>.json | intake 写入，store 只读 | intake 侧重写，store 在 loadTask/rebuildArtifacts 读取 |
| deliver/review 全量校验 + 登记 + 快照 + 审计 | intake | P2 一次查完全部欠账 |
| 状态推导 / 门禁 / 波次推进 | derive/gate/waves/CLI | intake 不推导、不改 scope、不推进阶段 |
| 制品内容稳定读取（I1） | persistence 的 readStableArtifact | intake 封装使用，store 不接触 |

### 4.2 协作时序（一次交付的完整闭环）
1. CLI run → store loadTask 装载事实 + 派发（写 journal dispatched）。
2. 成员 deliver → intake registerDelivery 进 store 导出的同锁 → 校验 → 落盘 reports/snapshots/artifacts/journal。
3. 再 run → store 再 loadTask 读到新事实 → derive/gate/waves 重算门禁。

关键点：两模块通过 store 导出的同一把锁（withOwnerLock）与同一份事实文件协作；intake 写盘的快照/报告/索引，正是 store 下一次 loadTask（含 I3 重建）的事实来源。store 是读写落点，intake 是校验+登记守门人，二者都不推导。

### 4.3 协同承担的失败/恢复
- 并发写：判定与写入同在锁内，intake 锁内 freshState 重读，store 锁内重推导——不丢登记、只推进一次。
- 索引损坏：store 的 rebuildArtifacts 从不可变事实（reports+snapshots）重建，且这在 intake 写盘后保持 readback 一致性。
- 幂等：intake 事件层幂等（同 key 同 payload 重交不追加），配合 store 的原子写，重试/重复提交安全。

### 4.4 需在两模块共同显式意识的边界（取舍）
索引重建后 kind 不精确：store 的 rebuildArtifacts 把重建条目 kind 硬编码为 "misc"。原因：deliver 报告只记录 path，kind 的真实来源是派单 writable 的 artifactKind，在不可变事实重建路径上不可得。若下游门禁以 kind 匹配阶段产出物在场（gate 的 stageDef.outputs 按 kind 匹配），重建条目可能无法命中某些 kind 要求。这是需要在文档/测试中显式意识到的边界。此边界横跨 store（重建实现）与 gate（按 kind 判定），与 intake 的登记（正常路径保留精确 kind）无冲突，但一旦索引走重建，精确 kind 信息的入口即在 intake 侧告警。

---

## 5. 结论

store 与 intake 是 runtime-v3 工具中心重写中分工正交的两层：store 管「事实文件怎么安全写/读」（通道与一致性），intake 管「哪个成员事实值得写」（校验与守门）。二者以任务锁 + 不可变事实文件 + 原子写为耦合点，共同支撑「目录即状态」（P1）、工具调用同步检查（P2）、原地修订新快照（I8/I10）与索引可重建（I3），并把状态推导、门禁判定、阶段推进完整让渡给 derive/gate/waves/CLI，遵守「模型只供语义」（P4）与「唯一检查点」（P2）原则。
