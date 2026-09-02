# 可写范围目录授权与 blocked 恢复闭环方案（retrospective）

> **文档性质声明**：本方案为**回溯性文档（retro）**——所描述的改动已于 2026-09-01 实施完成（除下述例外均为工作区未提交改动，`git diff` 可见事实），方案文档后补。**例外（r3 修正）**：`docs/file-inventory.json` 中 `runtime-v3/domain/writable.mjs` 的登记行已随 8795af0（tw-dispatch 方案提交捎带）进入 HEAD，该文件工作区当前无未提交改动。文中所有对代码的引用均基于实施后的实际代码；批准语义是**追认实施结果**而非授权实施。流程违例的如实记录见 §6。
>
> 除标注【回溯权衡】（文档作者后补的设计权衡梳理，非代码显式记录）、【建议】（未实施的拟议内容）与【r2 修订】（Expert 裁决返工后的语义修正，r1 原表述随之作废）外，其余均为已实施事实。本版为 r2 返工后的定稿，实现内容以 §7 清单指纹钉住。

## 0. 批准与修订记录

| 日期 | 事项 | 结果 |
| --- | --- | --- |
| 2026-09-01 | 实施（先于方案批准——流程违例，见 §6） | 已完成 |
| 2026-09-01 | Challenger 非作者挑战（r1） | accept，附 3 条 findings（1 risk：roadmap 回归口径错误；2 info：D7 表述精化、§5 补 F5 恢复路径） |
| 2026-09-01 | Expert 技术裁决（r1，confidence: high） | **rework**——四项阻断：①writablePathsOverlap 同名/祖先组件误判不重叠；②artifactFingerprints 精确匹配漏目录制品；③有效 blocked 墙钟因果同毫秒/回拨误判；④produceBlocked 遮蔽 F5 且旧绑定 blocked 二次触发 |
| 2026-09-01 | 返工实施（r2，respond 轮次 2） | 四项阻断全部修复 + findings 处置；全量 218 tests / 217 pass / 0 fail / 1 skip（返工新增回归 5 项）；各节（r2 修订）标注 + §7 实现内容清单 |
| 2026-09-01 | 文档事实修正（r3，respond 轮次 3，Challenger r2 复核通过后指定） | 两条 risk："未提交"声明补注 file-inventory.json 登记行已随 8795af0 进入 HEAD（§3/§5.5/§7）；日期虚构修正（全部 2026-09-09 → 2026-09-01）。两条 info：cli.mjs 互斥注释/拒绝文案按 r2 祖先组件语义改写、lastOwnerBlockedSummary 注释明确展示层墙钟口径与 effectiveBlockedSet seq 口径的分界；§7 清单重算 cli.mjs 与 roadmap 哈希。不改逻辑，全量复跑 218/217/0/1 |
| 2026-09-01 | 边界修复（r4，respond 轮次 4，Expert 重裁决 review-d8-08f940 指定，用户批准追加一轮） | 1 项边界阻断：让位检查提升到**所有** converge-user 返回之前（r2 只覆盖 produceBlocked 标记；exhausted 轮次耗尽分支无标记，先出「追加一轮」卡再出 F5 卡双重处理）+ 回归 1 项（两包耗尽×人工门 rework×blocked 交叉全链路）；文档小错：writable.mjs 行数 20→21、§6"全部改动未提交"残留对齐 8795af0 例外表述；D7/§5 同步 r4 语义；§7 重算 derive.mjs 与 waves-regression 哈希并补并行注（工作区混入无关的"汇报呈现注入"并行改动，cli.mjs 哈希钉在 r3 时点）。全量 220/219/0/1（含并行 1 项；本变更自身 219/218） |
| （待填） | design-approval 人工门（用户追认，绑定本版制品指纹） | 待批准 |

## 1. 背景与缺陷复现

用户在真实使用中反馈了两个推进缺陷。用朴实语言复现如下。

### 缺陷一：可写范围写目录没用，交付具体文件必被拒

Lead 派单时用 `--writable <路径>:<kind>` 声明成员的可写范围。当 Lead 预估产出是一个目录下的若干文件、把可写条目写成目录或包路径（例如 `docs/`）时，Owner 实际交付其下的具体文件（例如 `docs/plan.md`）会被 `tw deliver` 拒绝：

- 旧实现（本次 diff 前的 `runtime-v3/intake.mjs`）：`const allowed = new Set(writable.map((w) => w.path))` + `allowed.has(rel)`——**精确字符串匹配**，目录条目永远匹配不上它下面的文件路径。
- 后果是 Lead 只能逐文件穷举可写路径；预估漏一个文件就多一轮"被拒 → 重派"的空转。

### 缺陷二：Owner 报 blocked 后任务无限空转，且原因丢失

Owner 在可写范围内确实无法完成任务时（例如必须改一个范围外的文件），唯一出路是以 `--outcome blocked` 交付（paths 留空、summary 写原因）。但旧实现中这份 blocked 报告**没有任何消费方**：

- 轮次计算（F2 轮次唯一算法）只数"已交付报告"（`effectiveDelivers`），blocked 不算交付 → 该包轮次恒为 0 → 轮次上限永不触发；
- 于是 `tw run` 每次 produce/respond 分支都会重派**同形状派单**（同样的可写范围、同样的轮次），无限循环；
- 新派单不知道上一轮 blocked 的原因（Owner 可能是新会话），上下文丢失，只会再次 blocked；
- 没有任何卡片引导 Lead/用户恢复。

两个缺陷合起来：可写范围预估失准的代价被放大成"反复被拒或无限空转"，且系统不提供出路。

## 2. 修复设计（关键决策点与被否备选）

### D1 目录授权采用显式尾斜杠语法【已实施】

【已实施】可写条目路径以 `/` 结尾即声明为**目录授权**，授权其下任意相对路径；无尾斜杠仍是精确文件匹配。`runtime-v3/domain/writable.mjs`（本次新增，21 行，r2 修订后行数）文件头注释明确记录了选择理由：

> 显式语法保证既有派单（全文件条目）授权面不变——目录授权必须显式声明，不静默扩大（可写互斥是并行前提）。

【回溯权衡】被否备选：
- **隐式目录判断**（条目路径在文件系统上恰好是目录就按目录授权）：授权面随文件系统状态漂移，同一派单前后行为可能不同；且静默扩大授权面破坏可写互斥这一并行前提。否决。
- **glob 语法**（如 `docs/**`）：表达力强但引入转义/匹配规则的第二套语义，与"路径即身份"的既有约定（制品路径 = 相对路径身份）冲突，CLI 帮助文案与拒绝提示也要解释 glob 规则。对"授权一个目录"这个唯一高频需求而言过重。否决。

### D2 前缀判定的边界语义【已实施】

【已实施】`writableMatch(writable, rel)`：目录条目按字符串前缀 `rel.startsWith(p)` 判定（p 以 `/` 结尾，因此 `review/` 不会误覆盖 `review-x/`——前缀以分隔符为界）；精确条目按 `rel === p` 判定。空串与 `"/"` 条目跳过。

【r2 修订】互斥判定 `writablePathsOverlap(a, b)` 升级为**祖先组件语义**（Expert 阻断 ①）：两条目归一为"目录形"（无尾斜杠补 `/`）后按前缀判定——路径相等、或互为祖先路径组件即重叠。同一路径只一个 inode：`docs` 与 `docs/`、`docs` 与 `docs/x` 均判重叠（r1 版"同名文件/目录不判重叠"是错的——文件系统层面同名互斥）；兄弟前缀（`docs/` 与 `docs-x/`）不重叠。

### D3 artifactKind 继承条目声明【已实施】

【已实施】交付登记的 kind 由匹配到的条目继承：`kindOf = (rel) => writableMatch(writable, rel)?.artifactKind ?? "misc"`（`runtime-v3/intake.mjs`）。旧实现是 `Map(writable.map((w) => [w.path, w.artifactKind]))` 精确查表；目录条目下交付的文件因此继承目录条目声明的 artifactKind（如 `review/:code-review` 下交付的文件登记为 code-review）。

### D4 匹配逻辑收敛为共享纯函数，三处共用【已实施】

【已实施】新增 `runtime-v3/domain/writable.mjs` 导出 `writableMatch` 与 `writablePathsOverlap` 两个纯函数，替换三处原本各自为政的匹配逻辑：

1. **intake 交付校验**（`intake.mjs` `deliverLocked`）：`Set.has` 精确匹配 → `writableMatch`；
2. **plan 包间互斥**（`cli.mjs` `cmdPlan`）：`paths[i].path === paths[j].path` → `writablePathsOverlap`；
3. **组合评审清单**（`cli.mjs` `NLART`）：`w.split(':')[0] === it.path` → `writableMatch`（条目解析与 `parseWritableEntry` 同口径：lastIndexOf 冒号，路径可含冒号）。

三处语义漂移（清单看得见、交付却拒绝之类的错位）由共享函数根除。目录授权若只改 intake 不改 plan 互斥，会出现"两个包的目录/文件授权实际重叠却通过机械验收"的并行前提破坏——这是必须三处同步的原因。

【r2 修订】新增第四处消费点（Expert 阻断 ②）：`gate.mjs` 的 `artifactFingerprints`（F5 每包制品指纹，gate 判定 / cmdDecide 落盘 / derive 僵局检测三处共用的同一公式）原为 `paths.has(item.path)` 精确匹配——目录条目下交付的制品归不进任何包的指纹，人工门双指纹（F5/F6）漏检、僵局检测（消费规则 3）误判。改为按条目数组构造 `{path}` 后用 `writableMatch` 归属（条目解析与 `parseWritableEntry` 同口径 lastIndexOf 冒号），目录条目下制品正确进入所属包指纹，兄弟前缀（`review-x`）不误归。

### D5 plan 互斥判定前缀感知【已实施，r2 修订祖先组件】

【已实施】互斥判定升级为前缀重叠，拒绝文案补充重叠说明并点出两个冲突条目。不相关目录（如 `src/` 与 `docs/`）不判重叠。【r2 修订】按 D2 的祖先组件语义执行：`docs` 与 `docs/`、`docs` 与 `docs/x.md` 的拆分会被拒绝（同一路径/祖先组件只属一个包），`docs/` 与 `docs-x/` 通过。

### D6 有效 blocked 判定：seq 因果（r2 修订，Expert 阻断 ③）【已实施】

【r2 修订前形态】r1 实现用墙钟比较：最新 blocked 报告 `at` 严格大于该包最近 owner 派发/重拆的 `at`。Expert 阻断：同毫秒事件 `>` 误判无效、时钟回拨误静止——与 `gate.mjs` `reviewChainFingerprint` 已确立的"journal seq 第一全序"做法不一致。

【r2 修订后形态】判定提取为 `waves.mjs` 导出纯函数 `effectiveBlockedSet({ journal, reports, packages })`，因果锚 = 该包最新 owner 报告（blocked）所属派发（dispatchKey → dispatched 事件）的 **journal seq**；锚之后不存在**同包 owner dispatched** 与**任意 packages-planned/re-planned** = 有效 blocked。报告全序（"最新 owner 报告"的选取）同样以 report-accepted 事件的 seq 为第一全序、at 次级破平、ver 再破平——与 `reviewChainFingerprint` 比较器同口径。返回 Map<pkg, 报告>（键即有效 blocked 包集合，值供静止卡文案与 F5 判定共用）；`nextWave` 与 `derive.mjs`（F5 消费规则 2 与让位检查）消费同一函数，不存在双源分叉。锚找不到（旧形状无 dispatchKey / journal 缺派发事件）时退化为 -1：任何范围承诺事件都解除该 blocked（保守方向：宁可多派一轮，不误静止）。

语义注释（实施时记录）："blocked 只对『当前范围承诺』有效；Lead 扩权重派（新 dispatched）或重拆（新范围承诺）后给派发机会，旧 blocked 降级为派单卡上下文"。消费动机："blocked 不入投影轮（F2）→ roundOf 恒 0 → 轮次上限永不触发，历史上会无限重派同形状派单"。

派发侧两处同步过滤：respond 分支（返工重派）与 produce 分支（新交付派发）都排除有效 blocked 包——有效 blocked 包**不再自动重派**。

【回溯权衡】被否备选：
- **把 blocked 计入投影轮**（让轮次上限自然触发）：blocked 不是交付，占用轮次预算语义错误；且轮次上限触发后的收敛卡是"追加轮次/结束"语义，而 blocked 的正确出路是"扩权重派"或"重拆"，两者的问题空间不同。否决。
- **落盘 blocked 状态位**（在任务目录记一个 blocked 标记）：违反 P1（状态从事实源推导，不存在平行权威状态文件）。seq 因果比较完全由 journal + reports 现有事实重算，无需任何新落盘字段。否决。

### D7 blocked 静止卡：converge-user + produceBlocked 标记（非 decision 卡）【已实施，r2 修订让位规则】

【已实施】当评审（review）、返工（respond）、新派发（produce）均无可派波、且活跃包中存在有效 blocked 包时，`nextWave` 新分支 5 返回 `{ kind: "converge-user", reason, produceBlocked: blockedActive }`（原"活跃集空 → 门"顺延为分支 6）。reason 内嵌每包 blocked 摘要（summary 截断 160 字符）与恢复指引全文。

`derive.mjs` 把 `produceBlocked` 透传进 `next`；`cli.mjs` `runTransition` 的 await-decision 分支据此返回 `{ status: "awaiting-user", next: "re-scope", blocked, question, note }`——**不签发 decision-issued**（无 decide 语义），重复 run 幂等返回同一卡片。

【r2 修订：让位规则（Expert 阻断 ④前半）】converge-user(produceBlocked) 返回前，derive 检查人工门 rework 绑定（`reworkBinding`）：绑定波报告全在场且其中存在"blocked 且仍在有效 blocked 投影（D6 `effectiveBlockedSet`）"的包时，**让位 F5 消费规则 2**——wave 置回 gate 落入 F5 处理，出 reworkBlocked 仲裁卡（decide 语义：重派 respond / 结束任务）。否则才返回 produceBlocked 静止卡。两者的分界由此从"发生时机"（评审链前后）精化为**推导优先级**：只要人工门 rework 绑定的 blocked 仍有效，F5 的 decision 卡优先；produceBlocked 卡只接管无绑定场景（缺陷二的原始场景）。

【r4 修订：让位提升到所有 converge-user（Expert 重裁决边界阻断）】r2 让位检查只在 converge-user 带 produceBlocked 标记时触发；maxRounds exhausted 分支（轮次耗尽）更早返回且无标记——"绑定波含有效 blocked 的包"场景会先出「追加一轮/结束」卡、追加后又出 F5 reworkBlocked 卡，双重用户处理。r4 把让位检查提升到**所有** converge-user 返回之前（让位条件不变：reworkBinding 在场 + 绑定波报告全在场（按报告身份 dispatchKey+最新 ver 匹配）+ some blocked 且在有效投影）；exhausted 场景让位后落入 gate 分支同样由消费规则 2 接管。其余 converge-user（无绑定或绑定波无有效 blocked 的普通轮次耗尽/escalate/produceBlocked 卡）不受影响。

与既有 F5 仲裁卡的边界：F5（人工门返工波 blocked，绑定 `causeDecisionId`）走 converge-user **decision 卡**（可 decide）；本卡的 blocked 无决定可绑定时，恢复是**扩权重派**而非决定，故免签发。两者并存、互不替代（既有 F5 回归测试全部保持通过）。

【回溯权衡】被否备选：
- **出 decision 卡**（选项：扩权 / 重拆 / 结束）：decide 的语义是回答问题；而这里的恢复动作本身（带新 --writable 的 run、plan 重拆）就是完整的 CLI 操作，再套一层"先选选项再执行"只增加状态与失败面，且 decide 签发会触发既有重拆窗口的禁止逻辑（待决卡片禁止重拆），把恢复通道堵死。否决。

### D8 恢复通道：扩权重派与重拆放行【已实施】

【已实施】两条恢复路径，与可写范围的声明通道对齐：

- **单 owner**：`runTransition` 开头新增分支——`state.next?.produceBlocked` 在场、writable 非空非 `'none'`、且任务无 packages 时，直接派新 produce 波（round = 该包投影轮 + 1），落盘新 `dispatched`（晚于 blocked 报告 → D6 判定自然解除），返回 note"已按新可写范围重派 produce（上一轮 blocked 解除）；派单卡内嵌上一轮 blocked 原因"。这符合规则 6："awaiting-user 是静止状态，只能由新的用户输入恢复"——Lead 携新范围重跑 run 即用户重派指示。
- **多包**：`cmdPlan` 重拆窗口对 produceBlocked 卡**放行**（`awaiting-user` 且无 `produceBlocked` 才拒绝重拆）；重拆落 `re-planned`（晚于 blocked 报告 → 判定解除），随后 run 正常派新波。其余待决卡（人工门/路由/升档审批）仍禁止重拆。
- **第三出路**：用户决定结束任务（卡片 note 写明）。

### D9 重派派单内嵌上一轮 blocked 原因【已实施】

【已实施】`cli.mjs` 新增 `lastOwnerBlockedSummary(task, pkg)`：该包最新 owner 报告为 blocked 时，`dispatchCard` 在 produce/respond 波的派单卡注入"## 上一轮 blocked 原因"段（原因全文 + "本轮可写范围已由 Lead 重新声明；若仍无法完成，请再次以 --outcome blocked 交付并在 summary 写明还缺什么"）。重派后的 Owner（可能是新会话）不再丢失上一轮的阻塞上下文。

### D10 范围外拒绝文案补双层恢复边【已实施】

【已实施】intake 范围外拒绝文案升级（无死门，规则 4）：第一层**写法纠正**（"目录条目以 / 结尾才授权其下路径，如 docs/"——针对把目录写成无尾斜杠条目的常见笔误）；第二层**blocked 升级引导**（"若任务确实必须修改范围外路径才能完成：不要改派单外文件——以 --outcome blocked 交付（paths 留空），在 summary/unresolved 写明需要扩权的路径与理由，Lead 将扩大可写范围后重派"）。帮助文案（`fixHint` 的 DISPATCH_INPUT_REQUIRED、`helpCard` 的 run 条目）同步补目录授权写法。

### D11 顺带清理：任务目录骨架不再创建遗留空目录【已实施，与主题弱相关】

【已实施】`store.mjs` `initTask` 不再创建 `decisions/`、`gates/` 空目录（决定在单文件 `decisions.json`、门禁判定不落盘，两者是早期 per-file 设计遗留；存量任务目录里的空目录无害，归档时随目录删除）；`cmdArchive` 的 cleaned 列表同步去掉 `gates/`。此项与主线弱相关，属同批工作区顺手清理，如实单列；由独立回归测试守护（见 §4）。

## 3. 影响面清单

除一处例外，全部改动均为工作区未提交状态（`git diff` + 新增文件 `runtime-v3/domain/writable.mjs`）。例外：`docs/file-inventory.json` 的 writable.mjs 登记行已随 8795af0（dispatch-tool 方案提交捎带）进入 HEAD——该文件当前与 HEAD 一致，本变更对它已无工作区差异；清单中仍列出该行以完整描述本变更的落盘产物。

| 文件 | 改动 |
| --- | --- |
| `runtime-v3/domain/writable.mjs` | **新增**：`writableMatch` / `writablePathsOverlap` 纯函数 |
| `runtime-v3/intake.mjs` | deliver 可写校验改 `writableMatch`；kind 继承；拒绝文案双层恢复边 |
| `runtime-v3/waves.mjs` | 有效 blocked 判定（r2：导出 `effectiveBlockedSet`，seq 因果）；respond/produce 过滤 blocked 包；新分支 5（converge-user + produceBlocked） |
| `runtime-v3/derive.mjs` | converge-user 分支透传 `produceBlocked` 到 next（r2：produceBlocked 让位 F5 检查；F5 消费规则 2 改用统一有效 blocked 投影） |
| `runtime-v3/gate.mjs` | r2：`artifactFingerprints` 归属匹配改 `writableMatch`（目录条目下制品进包指纹） |
| `runtime-v3/cli.mjs` | 扩权重派分支；re-scope 静止卡（免 decision-issued）；plan 重拆放行 + 互斥前缀判定；NLART 目录匹配；派单卡目录标注 + blocked 原因注入；帮助文案 |
| `runtime-v3/store.mjs` | 骨架清理（decisions/、gates/ 不再创建）；archive cleaned 列表同步 |
| `docs/M-intake.md` | 可写范围校验描述补目录语义、kind 继承与 blocked 升级引导 |
| `docs/M-store.md` | 目录表 gates/ 行收敛 |
| `docs/file-inventory.json` | 登记 `runtime-v3/domain/writable.mjs` |
| `docs/runtime-roadmap.md` | 新增 2026-09-01 里程碑条目 |
| `docs/runtime-v3-charter.md` | deliver 工具"调用内检查"描述补目录授权与 blocked 交付说明 |
| `skills/team-work-v3/SKILL.md` | run 帮助补目录授权；成员纪律补"范围不够 → blocked → re-scope"指引 |
| `skills/team-work-v3/references/dsh-orchestration.md` | 拆包节补目录授权、互斥、blocked 重拆放行 |
| `tests/runtime-v3-intake.test.mjs` | +4 项回归（骨架、目录授权 + kind 继承、边界 + 文案、精确不扩张） |
| `tests/runtime-v3-topology.test.mjs` | +3 项回归（单 owner / 多包 / respond blocked 全链路）；既有 plan 互斥测试扩目录断言（r2：再扩同名/祖先组件/兄弟前缀断言） |
| `tests/runtime-v3-core.test.mjs` | r2 +3 项（writablePathsOverlap 祖先组件纯函数、artifactFingerprints 目录归属纯函数、F5 消费规则 2 derive 纯函数） |
| `tests/runtime-v3-waves-regression.test.mjs` | r2 +2 项（effectiveBlockedSet seq 因果纯函数、F5×produceBlocked 交叉 E2E） |

**不受影响**：任务目录数据结构（无 schema 变化、无新落盘字段——`produceBlocked` 是推导值）；F2 轮次算法本身；F5 人工门返工 blocked → 仲裁卡链路（回归测试保持通过）；OpenSpec Provider 与平台绑定层。

## 4. 测试与验证

全量套件实测（r4 返工后重新运行）：**220 tests / 219 pass / 0 fail / 1 skip**（skip 为既有 schemastery 环境预期跳过，见 roadmap 记录，与本次改动无关；其中 1 项"汇报呈现注入"测试来自与本变更无关的并行工作区改动，见 §7 并行注——本变更自身对应 219/218）。r1 新增回归 7 项 + r2 返工新增回归 5 项 + r4 新增回归 1 项 + 既有测试扩展：

| 设计点 | 测试（文件：断言要点） |
| --- | --- |
| D11 骨架清理 | intake：initTask 后目录清单恰为 7 项、无 decisions/ 与 gates/ |
| D1/D3 目录授权 + kind 继承 | intake：`review/` 条目接受交付 `review/findings-defects.md`，登记 kind 继承为 code-review |
| D2 前缀边界 | intake：`review/` **不**覆盖 `review-x/a.md`（拒绝）；拒绝文案含"目录条目以 / 结尾"且含 blocked 升级引导（"--outcome blocked"、"扩大可写范围"） |
| D2 精确不扩张 | intake：无尾斜杠条目 `docs` 拒绝 `docs/a.md` |
| D5 plan 目录互斥（r1） | topology（既有测试扩展）：`src/` 与 `src/foo.js` 拒绝（重叠文案）；`src/` 与 `docs/` 通过 |
| D2/D5 祖先组件互斥（r2） | topology：`docs` 与 `docs/`、`docs` 与 `docs/x.md` 均拒绝；`docs/` 与 `docs-x/` 通过。core 纯函数：writablePathsOverlap 七组边界断言 |
| D4 artifactFingerprints 归属（r2） | core 纯函数：目录条目下制品归入包指纹（非空集）、兄弟前缀不误归、精确条目只归自身 |
| D6 seq 因果（r2） | waves-regression 纯函数：同毫秒不误判（blocked 后无新事件仍有效）、墙钟回拨不误静止（at 更早但 seq 更大的新派发解除）、重拆解除、最新 owner 报告 delivered 覆盖 blocked、多包隔离且值为 blocked 报告 |
| D6/D7 F5 规则 2 防二次触发（r2） | core derive 纯函数：人工门 rework 绑定波 blocked → 扩权重派（非绑定 produce）delivered → 新评审链 → derive 不出 reworkBlocked（回 gateCheck 人工门） |
| D7 让位规则 + F5×produceBlocked 交叉（r2） | waves-regression E2E：人工门 rework 多包一 delivered 一 blocked → 评审链消化 + challenger rework 点名 blocked 包 → 无可派波时出 **F5 reworkBlocked 仲裁卡**（非 re-scope）；decide 重派 → 双包交付 → 评审链 → 回人工门（不再触发 blocked 仲裁）→ accept → completed |
| D7 让位提升：exhausted 不遮蔽 F5（r4） | waves-regression E2E：两包第 3 轮收敛（maxRounds=3）→ 人工门 rework → respond round 4 一 delivered 一 blocked → challenger 对 blocked 包 rework → 直接出 **F5 reworkBlocked 仲裁卡**（question 含"无法完成本次返工"、不含"轮次上限"，不先出「追加一轮」卡）→ decide 重派 → 交付后回人工门不二次触发 → accept → completed |
| D6/D7/D8 单 owner 全链路 | topology：blocked → run 出 re-scope 静止卡（question 含 blocked 摘要与阻塞路径）→ 重复 run 幂等不重派 → 带新 --writable 重跑 run 得新派单（prompt 含"上一轮 blocked 原因"及原文）→ 交付后恢复正常评审链（challenger） |
| D6/D7/D8 多包全链路 | topology：a 交付 + b blocked → 评审波优先消化 a（b 的卡延后）→ expert 裁决 → a 出集后 b 静止卡（含包名与原因）→ plan 重拆放行（扩权）→ run 派 b 新波且内嵌 blocked 原因 |
| D6/D7/D8 respond 波 | topology：返工波 blocked → 静止卡（不再无限重派 respond）→ 扩权重派 produce round 2、内嵌原因 |
| 兼容性 | 既有 F2/F5/F3/F9 等 210 项回归全部保持通过（精确条目授权面不变；F5 仲裁卡链路不变） |

## 5. 风险与回退路径

1. **目录授权放大授权面**：一个目录条目授权整个子树，Lead 拆包粒度过粗会让单成员写入面变大。缓解：互斥判定同步前缀感知（r2 后为祖先组件语义，同名路径/祖先/后代均互斥），目录与其下路径不可能分给两个包；skill 文档已引导"派单前预估产出文件位置，目录授权比逐文件列举更稳"。残余风险是单包内部授权面大于必要——属 Lead 拆包判断，机械验收不覆盖语义粒度。
2. **【r2 修订】有效 blocked 的因果可靠性**：r1 用墙钟 `at` 严格比较，同毫秒误判无效、时钟回拨误静止（Expert 阻断 ③）；r2 已改为 journal seq 全序因果（见 D6），与 `reviewChainFingerprint` 同口径，墙钟不可靠不再影响判定。残余边界只剩"锚找不到"（旧形状无 dispatchKey 的 blocked 报告）——保守退化为任何范围承诺事件均解除（宁可多派一轮，不误静止）。
3. **历史遗留 blocked 报告的行为变化**：改动前可能处于"无限重派"中的任务，改动后重算即得静止卡（最新 blocked 晚于最近派发即有效）。这是缺陷二的目标行为，不是回归；用户可用扩权重派/重拆恢复或决定结束。
4. **扩权重派分支的触发条件**：仅 `produceBlocked` 在场 + writable 非空非 `'none'` + 无 packages 时触发；普通 awaiting-user 卡（人工门/路由）不带 --writable 重跑 run 不受影响；多包任务即使带 --writable 也不会误走该分支（必须 plan 重拆）。**F5 返工 blocked 的恢复路径与 produceBlocked 不同**（r2 精化，info finding 处置）：人工门 rework 绑定波的 blocked 走 F5 reworkBlocked 仲裁卡（decide：重派 respond / 结束任务），扩权重派与 plan 重拆对它不可用（decision 卡禁止重拆）；produceBlocked 静止卡（无绑定场景）才走扩权重派/重拆。两者的分界由 D7 让位规则保证（r4 起覆盖所有 converge-user 返回，含轮次耗尽卡——耗尽与 blocked 同场时不会先出「追加一轮」再出 F5 卡的双重处理）。
5. **回退路径**：除 file-inventory.json 登记行（已随 8795af0 进入 HEAD，见 §3 例外注）外全部改动未提交，`git restore`（+ 删除未跟踪的 `runtime-v3/domain/writable.mjs`）即可整体回退；`git restore` 后需手动移除 `docs/file-inventory.json` 中的幽灵登记行 `"runtime-v3/domain/writable.mjs"`（该行已在 HEAD，restore 不会带走；或 `git checkout` 该文件后重做一次删除登记的提交）；无数据迁移（无 schema 变化、无新落盘字段——`produceBlocked` 与有效 blocked 集均为推导值、旧任务目录零改动——骨架清理对存量任务无影响）。回退后两个用户实测缺陷复现，但不产生数据损坏。

## 6. 流程违例说明

**违例事实**：按仓库规则 17，默认工程 Workflow 在方案审查后设置 `design-approval` 人工门禁（required），方案文档是"需求、范围与实现方向的人机唯一批准基线"——即**先方案批准、后实施**。本次改动相反：2026-09-01 已实施完成并在 roadmap 记录里程碑、全量测试通过，本方案文档为事后补写（本任务 `writable-blocked-retro` 即为此而开）。实施未经方案批准，属于明确的流程违例，不因修复本身有效而豁免记录。

**对批准语义的影响**：本文档的批准是**追认**——用户面对的是已实施的代码事实（git diff）而非拟实施方案。为使追认有效，本文档采取三项约束：① 引用代码处全部来自实施后实际读取的 diff 与源码（含注释原文），不掺入"计划中"的想象；② 未实施的拟议内容一律标注【建议】（如 §6 防再发段）；③ r2 起追认基线由 §7 实现内容清单的逐文件 sha256 钉住，批准即绑定这些内容。

**补偿与善后**：评审链完整保留且已实际运行一轮——非作者 Challenger 挑战（accept + 3 findings）、核心场景 Expert 技术裁决（rework，四项阻断经 Lead 独立核实属实）、respond 返工（r2，本版）均已发生；design-approval 人工门（绑定本版制品指纹）待用户追认。追认不通过时，除 file-inventory.json 登记行（已随 8795af0 进入 HEAD，见 §3 例外注与 §5.5 幽灵行处理）外全部改动未提交、可整体回退，或按评审意见返工后重新追认。评审链在违例发生后实际拦下四项真实缺陷（含两项本方案 r1 版自己写错/漏写的语义——§2 D2 的同名目录判断、§4 缺 gate.mjs 指纹归属），恰是"非作者评审不可省"的实证。

**防再发**【建议】：用户实测缺陷驱动的修复容易滑入"直接动手"。建议 Lead 在接到缺陷复现时，先开最小 design 任务出方案卡（哪怕只有背景 + 修复方向两节），过 design-approval 后再进实施；本回溯文档的撰写成本显著高于事前方案，即为反面教材的量化证据。

## 7. 实现内容清单（r2，追认基线钉住实现）

本节把批准基线与实现内容绑定（Expert 裁决第 5 项）：下列文件即本变更的全部落盘产物（r1 实施 + r2 返工后的状态；除 file-inventory.json 登记行已随 8795af0 进入 HEAD 外均为未提交工作区内容，见 §3 例外注），sha256 为本方案文档本版定稿时计算；批准本方案即批准这些内容。任一文件后续变化（超过本文档自身的批准后修订）须重新走批准。本文档自身不在清单内（自引用），其指纹以 deliver 登记的 digest 为准，即人工门绑定的批准对象。

| 文件 | sha256（sha256sum 同物） |
| --- | --- |
| `runtime-v3/domain/writable.mjs` | d3d03875c946cc1e8b70294619f1f4658c9fe760b0eb29370812d091b2b2563b |
| `runtime-v3/intake.mjs` | cd268d515e0f0e9155feb94fd318f907cde4c2cf811d836167f5b01e095ce7a9 |
| `runtime-v3/waves.mjs` | 7143445569040b5e4c6391fb7ec1d25ab2cad10e6864a1a20ed02d9c034d3209 |
| `runtime-v3/derive.mjs` | a0ad9e4e2f4dce00b9adbacfcea246f740e621c305eb51f40d9171a17eb74f23 |
| `runtime-v3/gate.mjs` | 81d0ad98dff0e9ac6e1b697b57fd444e3573b0f870a0b6c4b02ccdc82b4ceee3 |
| `runtime-v3/cli.mjs` | 08f000863ac4abef914c15783ee076349159b327dc2fa81fec48edca4acbf1b0（r3 定稿时点；见下方并行注） |
| `runtime-v3/store.mjs` | eb82b557acfe7b641794b963a36f5a0f0e9e776805e589e44279814ebc3804b9 |
| `docs/M-intake.md` | 7b1a41e359be2ac9ff8c7bc79c3073e96dee355c5a60bb35936ff56bb204cf2d |
| `docs/M-store.md` | 85acfa5ad44cdab9c058402badb29b23a76a5f7a5362780e9820b287f4e2a048 |
| `docs/file-inventory.json` | 3ef0024c28686470b46a4ef2fbf3f473f0552ed5a1c160efa5af5911aa8428c8 |
| `docs/runtime-roadmap.md` | 7f1e785454ef41db786e3d41a9c0b54b06a2df6b43821ae1ed9d9c0ddde90ced |
| `docs/runtime-v3-charter.md` | d80e383b9a7d767e7ea255e59c18b3673930a66e7f17656c172d482d39908557 |
| `skills/team-work-v3/SKILL.md` | d45c34c255357ba3126b81b7d24cf78c8ded6942e4a87ae4d950f9f40a80e2a8 |
| `skills/team-work-v3/references/dsh-orchestration.md` | 55312d6195076d74663d934c39ec7d031a23124472de87a3797e4f6d34147896 |
| `tests/runtime-v3-intake.test.mjs` | 19fe77df33e221b7fd276b4635dc75a5c1903dcaef4544d324b5484410cfc3f1 |
| `tests/runtime-v3-topology.test.mjs` | 598ef0693a0adb5f2c6ec2fbabdd9af51a2aa5d3ad847f17cacaa4a09ee7d86b |
| `tests/runtime-v3-core.test.mjs` | b691edd1a61edc625ec4484d71b4c452a7604bf5059f547319f2f6204c26bd67 |
| `tests/runtime-v3-waves-regression.test.mjs` | af50efbca2470140b618628381d09658fb4d37fb36eaece4621afdbf36de7368 |

**并行注（r4）**：r4 期间工作区出现了与本变更无关的并行改动（"汇报呈现注入"特性：`runtime-v3/cli.mjs` 的 presentation 注入 + `tests/runtime-v3-cli.test.mjs` 新增 1 项测试 + `skills/team-work-v3/references/scenarios.md` 文案）。本清单 cli.mjs 哈希为 **r3 定稿时点值**（仅含本变更内容）；当前磁盘上的 cli.mjs 已叠加并行特性、哈希必然不同——批准基线仍以本清单哈希描述的本变更内容为准，并行特性的批准归其自身变更流程。derive.mjs 与各测试文件的 r4 哈希在并行改动出现后重算，经 diff 逐 hunk 核对仅含本变更内容。

## 8. 未决事项

无 unresolved。两个非阻塞观察（不要求本次处理）：

- blocked 摘要在静止卡 reason 中截断 160 字符，全文仍在报告文件中可查（Lead 可按报告定位）；若实际使用中截断频繁，可考虑卡片附报告引用。
- `respond` 扩权重派固定走 produce 形状（runTransition 分支构造 `kind: 'produce'` 的波），轮次正确（投影轮 + 1）且测试覆盖；若未来返工语义需要保留 respond 形状标志，可在此分支补 continuation 语义（【建议】，当前无需求）。
