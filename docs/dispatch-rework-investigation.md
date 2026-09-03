# tw-dispatch 返工调研与修复方案（供审查·终版）

> **修订记录**：初稿经两视角交叉审查（E：宿主事实/判定链闭环性；F：完整性/系统咬合），合并 10 条必改全部吸收——判定链终版与废弃/接管声明见 §二·A，升档指纹扩字段见 §二·B，重建三源口径见 §二·E，fake 宿主契约 5 条见 §三。
>
> **实施状态（2026-09-07）**：§四 全部五项已实施（任务 run-dispatch-split 轮次 4）——A/C② 先行、B/D/E 随后、声明修正收尾；实施细节与验收矩阵见 docs/dsh-dispatch-tool-plan.md §9。
>
> **轮次 6 用户终裁修订（2026-09-07）**：① §二·E 快照读取容错——损坏快照按缺失进 degraded（含损坏文件路径与处置建议），重建不抛错；②③ 判定链五态简化为四态（活→等待永不重投；「活+未收单」经宿主 submitMaterialized 失败即完全回滚不存在；冷归属一致→冷唤醒+判收单定增量或全量，轻量续行提示废弃）——本节早期描述的五态与 nudge 语义已被取代，以 docs/dsh-dispatch-tool-plan.md §9.1 四态为准。

## 一、宿主事实（全部源码实证，两轮审查抽查 16 处全部核实）

| 事实 | 原语/证据 | 对修复的意义 |
|---|---|---|
| **冷持久会话可判定** | `sessionPersistence.listSnapshots()`（轻量，仅 header+revision；宿主 startContinuable 判重就用它）；header 含 parentSession 可校验归属 | 防双发的「冷存在」判定有了权威原语 |
| **未落盘的崩溃壳等价于不存在** | 持久层 lazy 物化：created-but-never-appended 不出现在 listSnapshots——宿主判重也不认它 | 崩溃在最早期窗口 → 同 ID 重建合法且不会被拒 |
| **跨会话接续 = followup 冷唤醒** | followup 对冷会话：inspect 读回 → 鉴权（须精确直接父）→ 重建 Agent → 消息入队（实测+源码双证） | 断链/中断的接续不需要重建 |
| **「已收到派单」的可靠信号** | 子会话事件 own-suffix 中存在 inserted 非空的 `agent/inbox/spliced`；注意：inbox 接受即**同步进内存事件流**，盘上可见需 flush（write-behind ≤200ms；创建核心的 flush 确认保证创建返回时已落盘） | 三态判定的收单信号（活会话读内存流、冷会话 readRaw 读回） |
| **重复 ID 拒绝** | DUPLICATE_CHILD；查活注册表+活会话，显式 childId 才加查持久快照 | 「同 ID 重建」仅在活/持久都不存在时执行则永不触雷 |
| **跨进程无 CAS** | 文件层 link() 原子发布是最后防线，后到方静默持久化失败（仅日志） | 单写者前提声明；最坏后果=报错可 retire 恢复（不会双成员） |

## 二、逐问题：case → 现在怎么坏 → 修复 → 修后流程

### 问题 A（防双发）——判定链终版

**case**：补派时进程崩溃（或登记失败）后重试；或宿主重启后重试；或 Lead 会话更替后接管任务。
**现在怎么坏**：`sessions.get` 只查活会话——冷持久会话被判「不存在」→ 同 ID 重建被宿主拒绝 → 重试永远失败；descriptor-only 会话被误判「已收单」→ 永久等待；现行 empty→drain→同 ID 重建路径与持久判重冲突。
**修复（终版判定链，判定原语与宿主判重标准一致）**：

```
登记本取确定性 sessionId
├─ sessions.get 有（活）→ 只读内存事件流（禁止盘读——盘读有 write-behind 双投窗口）：
│    own-suffix 有 inbox/spliced(inserted 非空) → 已收单 → 等待
│    无（descriptor-only）→ followup 补发派单正文（入队即收单）
└─ sessions.get 无 → sessionPersistence.listSnapshots 匹配 id：
     有且 header.parentSession ≠ 当前调用方会话 → 接管冲突卡（指 tw retire --wave
         或由原会话继续；不做 followup/重建——两路必被鉴权/判重双拒）
     有且归属一致 → followup 冷唤醒（readRaw 判收单决定消息内容）：
         未收单 → 消息=派单正文（补发）
         已收单 → 消息=轻量续行提示（「继续当前工作并报告状态」，附派单 key 供对照；
                  不重发正文防重复执行；成员有会话上下文可自辨进度）
     无（含未物化崩溃壳）→ 同 ID 重建
```

**修后流程重放**（收窄声明）：同一 Lead 会话存续期内的任意崩溃时点收敛到同一会话或补发正文，不再造第二个成员；Lead 会话更替由接管冲突支显式处置（不作废则由原会话继续）。
**废弃声明**：现行 empty→drain→同 ID 重建路径废弃（与宿主持久判重/backend 记账冲突）；活会话收件箱异常一律 followup 补发。
**实现落点**：dsh/tw-dispatch.js sessionAlive 与 dsh/tw-tool-subagent.js 创建核心对账两处同步换原语；own-suffix 判定处理 header.seedLength 切分。

### 问题 B（升档审批卡）

**case**：升档卡签发后调 run 看状态、再调 dispatch。
**现在怎么坏**（审查修正后的真实机理）：现行重签前已作废旧卡——真正根因是 pending 不进 derive（升档卡期间 run 仍走 dispatch 分支不显示待决）+ 渲染与 decide 两源错位（渲染重算 choices，decide 用账本 pending.choices）。
**修复**：所有未决决定卡（升档/人工门/migrate）统一进 derive 静止态（与 produceBlocked/routeBlocker 的优先级表：pending 卡优先于派发阻塞判定）；签发幂等（存在未决同类卡返回原卡）；一切重渲染直接用账本 pending.choices **与 pending.question**（禁止重算）；**升档指纹扩为完整包配置序列化（id+tier+writable+done+dependsOn）**，签发/落盘/查找/decide 四处同源替换，历史无字段批准视为失效（多问一次优于误授权）。
**修后重放**：签发后 run 显示「等待你的决定」；再调 dispatch 返回同一张卡；卡面=账本=执行结果；改任何包配置后旧批准失效重出卡。

### 问题 C（续派恢复边）

**case**：续派波原代理在/断链。
**现在怎么坏**：在场指引不带派单正文；断链 fresh 发增量单（目标/约束全无）。
**修复**：①在场：指引附完整 prompt 正文 + followup（含冷唤醒——判定链原语复用，冷持久先判收单再补发）；②断链：**runtime 在 waves/inflight 导出层附全量 prompt 变体字段**（objective/constraints/exclusions 内嵌；绑定层不拼装——P4 与 §7.1 评审先例），fresh 创建使用全量变体；③断链且模型信息不可解析 → 指 retire。
**修后重放**：在场→直接可发；断链→新成员拿到全量单正常开工。

### 问题 D（run 只读不彻底）

**case**：锁目录只读时调 run。
**现在怎么坏**：run 取任务锁会创建/写入/删除锁文件 → EACCES（不是只读）；锁外首次读有一致性窗口。
**修复**：run 与 gate 统一无锁只读快照（gate 已无锁，实际只改 cmdRun）；单文件原子写保证不撕裂，跨文件尽力一致（卡面标注所读 journal seq 版本）；自愈写回只在锁内写命令。
**修后重放**：锁目录只读 → run 照常返回状态卡、盘上零变化（含锁文件）。

### 问题 E（损坏账本重建不等价）

**case**：目录授权 docs/:code-review 的 artifacts.json 损坏后重建。
**现在怎么坏**：kind 退化 misc；同内容多报告只恢复一个；字段随 readdir 顺序漂移——重建改变门禁事实。
**修复**：重建算法三源拼接——journal 的 report-accepted 序（全序）+ reports 文件事实（stage/package）+ snapshots（digest）；kind 按「报告 dispatchKey → journal dispatched 的 writable → writableMatch」精确推导（与正常登记 kindOf 同口径含目录继承）；每路径取最新报告完整事实（digest/kind/stage/reportRef）；「保守降级」可测定义=结构校验失败跳过该报告并在结果中列出（不产出错误事实）；agents.json 合法空数组时 agent-map 不假成功。
**修后重放**：损坏 → 重建结果与损坏前等价（等价性断言测试：多轮 ver 同 path、跨 key 重交、同 digest 重交三组矩阵）。

### 声明修正

- 多宿主并发写同任务：声明不支持（单写者前提）；最坏后果=报错可 retire 恢复（宿主文件层防线保证不产生双成员）；
- roadmap「五项完成」改回实况；方案文档删除与目标冲突的旧契约（增量照发/旧并发声明等）。

## 三、测试基线升级（fake 宿主契约）

fake 需模拟的 5 条宿主行为（与源码对齐；write-behind 时延不模拟——宿主契约是接受即同步落盘，模拟的是崩溃截断的静态形态）：
1. sessions.get 只反映活会话；
2. listSnapshots 只列已物化会话（created-but-never-appended 不出现）；
3. followup 对活/冷会话均入队且接受即落盘；
4. events 形态：header.seedLength + seed 事件（descriptor-only）与 own-suffix 的 agent/inbox/spliced(inserted) 粒度；fake 需带 parentSession 字段与 UNAUTHORIZED/DUPLICATE_CHILD 行为（接管冲突支可验证）；
5. readRaw 按需读回（冷支判收单）。
fake 固化的是当前宿主行为快照，宿主升级需复核。

## 四、实施顺序（增量修，无架构回退——审查 F 确认）

A（判定原语层重写，工作量主体）与 C②（runtime 导出全量变体字段）先行；B（derive 静止化+指纹扩字段）、D（cmdRun 去锁）、E（rebuildArtifacts 重写）随后；声明修正收尾。derive 语义翻转涉及波次断言迁移（量级参照 §7.5.5 的 120+），测试影响面清单随实施派单下发。

## 五、两轮交叉审查吸收表

| 来源 | 必改 | 吸收位置 |
|---|---|---|
| E-F1 | 接管冲突第四支（会话更替双拒死角） | §二·A 判定链 |
| E-F2/F3 | 活会话只读内存事件流；write-behind 表述修正 | §一表格 + §二·A |
| E-F4 | 废弃 empty→drain→同 ID 重建路径 | §二·A 废弃声明 |
| F-1 | 冷持久支二分（readRaw 判收单，防双投） | §二·A 判定链 |
| F-2 | 升档指纹扩完整包配置 | §二·B |
| F-3 | 重建三源拼接与 kind 精确推导 | §二·E |
| F-4 | 全量 prompt 投影通道（runtime 导出，绑定层不拼） | §二·C |
| F-5 | 文件级影响面与优先级表 | §二·A 落点 + §四 |
| F-6 | 机理描述修正；question 同钉；fake 契约 5 条 | §二·B + §三 |
| E-F5/F6（建议级） | DRAINING 窗口重试指引；单写者最坏后果 | 声明修正 + 实施派单附带 |
