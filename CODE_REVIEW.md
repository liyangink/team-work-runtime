# 代码审查：角色/场景公共引导库（guidance-injection-review）

- 审查对象：工作区相对 HEAD 的全部未提交改动（`git diff` + 未跟踪文件）
- 审查范围：`team-work/guidance/`、`runtime-v3/guidance.mjs`、`runtime-v3/cli.mjs` 注入改动、`skills/team-work-v3/`（SKILL.md + references/guidance.md）、`package.json`、`docs/file-inventory.json`、`AGENTS.md`、`docs/runtime-roadmap.md`、`tests/runtime-v3-guidance.test.mjs`
- 验证基线：`npm test` 实测 136 项中 134 过 1 挂（挂项即本报告 P1）；7 项引导回归测试全部通过
- 结论：**不通过（rework）**——存在 1 项阻断（P1）与 1 项中低（P2），其余为低危观察与建议

---

## P1（阻断，必须修复）

### P1-1 AGENTS.md 删行未同步仓库契约测试，`npm test` 全量失败

**证据**：
- 本次改动从 `AGENTS.md` 删除了「开发本仓库时新建 subagent 默认使用 `gpt-5.6-terra`，推理强度统一设为 `max`」一行。
- `tests/repository-contract.test.mjs:61` 仍断言 `assert.match(agents, /subagent 默认使用 \`gpt-5\.6-terra\`/)`——全仓仅剩这一处引用该行。
- 实测 `npm test`：136 项测试 134 过 1 挂，唯一失败即 `repository-contract.test.mjs` 的 "AGENTS.md preserves core collaboration invariants"（`AssertionError: The input did not match the regular expression`）。
- `package.json` 的 `prepublishOnly: npm test` 依赖此套件，套件红会阻断发布。

**定性**：删行方向本身正确——`AGENTS.md` 的「文档与方案脱敏」规则明令禁止引用真实 provider/配置值，该行是存量违例，删除是脱敏修复；但改动未同步维护同一提交内的契约测试，违反「仓库契约测试随变更同步」的仓库纪律（repository-contract 测试存在的目的就是拦住这类不同步）。

**修复建议（二选一，推荐前者）**：
1. 更新 `tests/repository-contract.test.mjs:61`：删除该断言，或替换为本次新增能力的稳定不变量（如 `/角色\/场景公共引导库/`、`/team-work\/guidance/`），并补一条「AGENTS.md 不得引用环境特定模型/配置默认值」的脱敏断言，防止违例回潮；
2. 或在 `AGENTS.md` 恢复该行（不推荐：继续违反仓库自身脱敏规则）。

---

## P2（中低，建议修复）

### P2-1 相对 `projectRoot` 时项目覆盖层被静默跳过，与文档承诺不一致

**证据**：
- `runtime-v3/guidance.mjs:37` 用 `if (projectRoot && path.isAbsolute(projectRoot))` 决定是否加载项目根覆盖层。
- `bin/tw.mjs` 的 `--project-root <值>` 与 `TW_PROJECT_ROOT` 环境变量均原样透传，未 `path.resolve`；`tw()` 默认值 `process.cwd()` 虽为绝对路径，但程序化调用或显式传参可传入相对路径（如 `./proj`）。
- 仓库其余所有路径（`store.mjs` 的 `.team-work`、`cli.mjs` 的 `workflow/definitions`、`team-work/policies` 等）都用 `path.join` 直接拼，相对路径正常工作；唯独引导覆盖层在相对路径下被静默跳过——只剩包内基线，无任何报错或提示。
- 与 `AGENTS.md`、`references/guidance.md`「项目根 `team-work/guidance/` 下同名文件逐文件覆盖」的承诺不一致。

**修复建议**：`loadGuidance` 内对非空 `projectRoot` 先 `path.resolve(projectRoot)` 再拼接（或把守卫改为 `projectRoot != null`），并补一条相对路径覆盖层生效的测试。

---

## P3（低危观察与建议，不阻断）

### P3-1 在途重建文本的保真度受引导库热变影响（语义漂移）

- `dispatchedDetail`（cli.mjs:390-402）只向 journal 记录事实（key/kind/role/round/package/continuation/scope/writable/modelHint），不存 prompt——符合 P1「状态从事实源推导」，无平行权威状态，这点是正确的。
- 但 F4 注释承诺在途重建用于「断链后可**原样**转发补派」；重建时（`inflightDispatches`）会重新 `loadGuidance`。若派发后、交付前项目覆盖层引导被修改，重建文本将与成员实收派单不一致。对比 tier 语义「全局配置热变只影响后续波次，已派发波次不重选」（有 agents.json 快照），引导无快照机制。
- 影响很小：引导是纪律提示、非门禁。建议在 `references/guidance.md` 明示「引导修改只影响此后派发与在途重建文本，不追溯已派发文本」，或接受现状。

### P3-2 测试覆盖缺口（非阻断）

7 项回归测试覆盖了加载、覆盖、注入、缺失跳过四条主线，质量良好；以下路径无直接断言，建议补测：
- `dispatch-plan` 注入路径：`cmdDispatchPlan` 内 `loadGuidance` 的调用与 `waves[].prompt` 含引导无直接测试（目前仅经 `runTransition` 间接覆盖）；
- expert（verdict 波）角色注入无测试（owner/challenger 已覆盖）；
- 多包降档（decline → `cardsD`）路径无测试；
- 项目覆盖在真实派单文本中的端到端断言无测试（现仅断言 `loadGuidance` 返回值）；
- `guidance.mjs` 单文件读失败静默跳过（第 26 行 catch 分支）无测试。

### P3-3 Markdown 标题层级倒置（纯展示）

- 注入段标题为 `## 角色指引（owner）`，而引导文件正文自带 `# Owner 通用指引` H1，形成 H1 嵌 H2 的层级倒置。派单 prompt 无机器解析，不影响功能；建议引导文件正文首行标题降级为 `##` 或删去（派单内已有 `## 角色指引` 标题）。

### P3-4 README 复用件清单未列 guidance（可选同步）

- `README.md` 第 62 行「复用件」列表含 `team-work/policies` 未列 `team-work/guidance`。本改动已同步 AGENTS.md/roadmap/file-inventory/package.json/SKILL.md 五个目标，README 非强制同步点，列为可选补充。
- 轮次 2 扩展（Challenger 补充，已核验）：`docs/runtime-v3-charter.md:176` §6.1 实现文件表同样仅列 `team-work/policies/default.json`、未列 `team-work/guidance/`，如需保持 charter 清单完整可一并补充（同为可选同步点）。

---

## 验证通过项（无问题）

**P1–P4 原则与派单契约**：
- P1：journal 只记事实、prompt 全量重推导，引导库位于 `.team-work/` 之外、非任务状态，不引入平行权威状态；✓
- P2：deliver/review 检查点零改动，引导不参与任何门禁判定，缺失静默跳过且不回退既有行为；✓
- P3：门禁与阶段流转逻辑零改动；✓
- P4：不新增工具参数，不向模型索要 runtime 可推导的簿记，注入纯文本纪律；✓
- 派单契约：卡字段（key/role/tier/round/kind/package/continuation/scope/prompt）形状不变，`# 派单` 标头仍居首，注入段位于 headLine 之后、目标之前；`parts.filter(Boolean).join('\n\n')` 对空引导天然跳过；续派省略目标/约束/排除的既有语义保留，续派重复注入引导为设计决定（测试显式断言）；✓
- 角色覆盖完备：waves.mjs 角色枚举只有 owner/challenger/expert（waves.mjs:33-35），引导库三件齐全，无遗漏角色；✓
- 场景缺失跳过：默认工程 10 个 teamScene（research/design/design-review/spec/spec-review/implementation/test/code-review/e2e/finish），库内仅 implementation/test，其余静默跳过且不阻塞派发，与「引导是增强不是门禁」一致；✓

**分层覆盖与注入正确性**：
- `Object.assign` 顺序正确（包内基线 → 项目根逐文件覆盖），与 AGENTS.md/roadmap/skill 文档描述一致；✓
- `loadGuidance` 目录缺失、文件缺失、单文件读取失败均静默容错；注入仅检索 `wave.role` 与 `stageDef.teamScene` 两个键，无串入其他角色/场景（测试 4/5 断言）；✓
- `run` 与 `dispatch-plan` 同源（`cmdDispatchPlan` 加载并透传 `runTransition`），含续派与在途重建（测试 6 断言）——与 roadmap 描述一致；✓

**文档/清单同步**：
- `docs/file-inventory.json` 新增 9 项（guidance.mjs、team-work/guidance/ 目录 + 5 个 md、references/guidance.md、guidance 测试）全部到位，`repository-contract` 的存在性测试通过；✓
- `package.json` files 增加 `team-work/guidance/`，且 `PACKAGE_ROOT` 解析（runtime-v3/../team-work/guidance）在 npm 打包后相对位置不变，发布形态可用；✓
- SKILL.md 链接与成员操作说明、roadmap 条目（7 项回归测试、run 与 dispatch-plan 同源、含续派与在途重建）与实际实现一致；✓

**脱敏**：
- 5 个引导文件与 references/guidance.md 内容全部通用、无项目名/账号/内网地址/环境默认值；「JUnit 的 @DisplayName」属公开技术概念，符合 AGENTS.md「公开的模型名称可以作为示例借鉴」的同类精神（测试亦显式注释该借用）；✓
- AGENTS.md 删行本身是脱敏修复（移除真实 provider 配置值），方向正确（问题仅在测试未同步，见 P1-1）；✓

**其他**：
- `cli.mjs:238` 的 `,,` 双逗号（稀疏数组洞）为 HEAD 既有代码，非本次改动引入；`filter(Boolean)` 下无害，可顺带清理但不属本次范围；✓
- 全套实测：134/136 通过，7 项引导测试全绿，E2E-07 respond 返工注入回归通过；✓

---

## 结论（轮次 2 更新）

引导注入机制设计合理、实现干净：分层加载、缺失静默跳过、按 role+teamScene 检索、续派与在途重建同源，全部符合 P1–P4 原则与派单契约；文档与清单同步度高；脱敏达标；7 项回归测试质量良好。

轮次 2（续派 w6-56ba9c）：Challenger 独立实测复核六项 findings 全部属实，并补充两条 info 级新发现；经 Owner 逐条独立核验（读码确认），补充发现同样属实并已纳入本报告（P3-5、P3-6）。被审改动的 P1 阻断仍未修复，**审查结论维持 rework（针对被审改动）**：实现方修复 P1（同步契约测试）并建议一并处理 P2-1、P3-5、P3-6 后放行。

## 轮次 2 处置（回应 Challenger 意见，key w6-56ba9c）

### 意见逐条处置

| # | Challenger 意见 | 处置 | 说明 |
|---|---|---|---|
| 1 | [risk] P1 阻断复现确认 | 确认，维持 P1-1 | Owner 轮次 1 实测同（136 项 134 过 1 挂，唯一失败即该断言）；最小修正一致 |
| 2 | [risk] P2 相对路径静默跳覆盖层 | 确认，维持 P2-1 | 补充证据：`loadDefinitions`（cli.mjs:75-77）对相对路径正常，唯独 guidance 守卫不一致 |
| 3 | [info] P3-1 在途重建热变漂移 | 确认，维持 P3-1 | 建议在 references/guidance.md 明示"引导修改只影响此后派发与在途重建文本" |
| 4 | [info] P3-2 测试缺口 | 确认，维持 P3-2 | 含 dispatch-plan 注入、expert 波、降档 cardsD、readSection catch 分支 |
| 5 | [info] P3-3 H1 嵌 H2 层级倒置 | 确认，维持 P3-3 | 纯展示，建议引导文件正文首行降级为 `##` 或删除 |
| 6 | [info] P3-4 同步点扩展（charter §6.1） | 确认，扩展 P3-4 | 已核验 docs/runtime-v3-charter.md:176 文件表仅列 team-work/policies/default.json，未列 team-work/guidance/ |
| 7 | [info] 新增：引导加载无缓存 | **核验属实，新增 P3-5** | 见下 |
| 8 | [info] 新增：覆盖层损坏无诊断 | **核验属实，新增 P3-6** | 见下 |

### 新增 P3-5 引导加载时机：无条件提前加载，无缓存（Challenger 补充，Owner 已核验）

**证据**：
- `cmdRun`（cli.mjs:300-302）在 `taskExists` 检查之前无条件 `const guidance = await loadGuidance(projectRoot)`；任务不存在（归档卡）、终态幂等完成卡（cli.mjs:309-311 提前返回）、awaiting-user 静止态（runTransition 非派发分支）等不产生派单的路径也付出 readdir + 全量读文件 I/O。
- `cmdDispatchPlan`（cli.mjs:796-797）同理。
- `loadGuidance` 每次调用全量重读包内基线（最多 6 个 md）+ 项目覆盖层，无缓存。

**影响**：性能影响轻微（小文件），属设计瑕疵而非功能缺陷。**不建议**用模块级缓存修复——`references/guidance.md` 承诺"修订引导：直接编辑对应 md 文件，下次派发生效"，缓存会与热变语义冲突（tier 已有"热变只影响后续波次"的既有语义，且 tier 有 agents.json 快照，引导没有）。

**修复建议**：将 `loadGuidance` 调用从 cmdRun/cmdDispatchPlan 顶部下移到 `runTransition` 内仅 dispatch / wait-inflight 分支（惰性加载，两命令天然共用），或保持现状并在文档注明。若惰性化，需同步更新测试（现有 7 项测试不依赖加载时机）。

### 新增 P3-6 项目覆盖层损坏静默吞错，无诊断信号（Challenger 补充，Owner 已核验）

**证据**：`guidance.mjs:13-30` 的 `readSection` 中单文件读取失败被 catch 静默跳过（第 26 行），目录缺失与文件损坏表现完全相同——Lead 与成员均无任何信号区分"没有覆盖文件"与"覆盖文件损坏被忽略"。

**定性**：与 AGENTS.md「错误必须保留最后有效制品，并可诊断、重试和恢复」有轻微张力（引导是增强不是门禁，保留有效制品与静默跳过本身合规；缺的是可诊断性）。包内基线损坏时静默跳过是可接受的（回退 = 无引导，派发不阻塞）；项目覆盖层是用户显式配置，损坏时无提示会误导用户以为覆盖已生效。

**修复建议**：项目覆盖层（第二层）读取失败时向 stderr 输出一次警告（如 `tw: 警告：team-work/guidance/<file> 读取失败，已使用包内基线`），不改变派发行为；包内基线失败可保持静默或同样警告。建议补一条覆盖层损坏 → 警告 + 基线回退的测试。

### 复核结论

Challenger 八条意见（6 项原发现 + 2 新增）全部经 Owner 独立核验属实，无分歧。审查结论维持 rework（针对被审改动）：P1 阻断未修复前不可放行。
