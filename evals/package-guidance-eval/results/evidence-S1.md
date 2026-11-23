# 证据 S1：小任务不拆（implementation，单文件）

> 场景：S1。真实模型执行；用户答复为预定义模拟剧本（原文见 `results/raw/task-s1b.md`）。
> 判定修订：**部分失败**（单包/单 Owner/审查/门静止符合；重签确认卡被旧指令代答不符合）。

## 1. 环境与模型

- 被测 Lead 会话：`session-250a26da-c213-4971-af94-835263ec54ba`（独立 DSH CLI headless，宿主 0.2.2-rc.3）。
- cwd：`/private/tmp/twr-glm53-eval/project`（隔离根内）。
- 模型原始回执：`results/raw/session-model-records.jsonl` 中该会话的 `requestHeader` = `provider=zai-coding-cn, model=glm-5.3, reasoningEffort=max`；`tw open` 三角色同为该 ModelRef。
- 技能：`skill` 工具结果的 base directory 指向隔离 profile 的 `skills/team-work-v3`；加载副本哈希见 `results/raw/skill-loaded/hashes.txt`。事件流中该结果被宿主截断为 8192 字节（`truncated=true`），完整正文无法从事件流闭合（见 `isolation-evidence.md` §2）。

## 2. 执行链（raw 行号为 `results/raw/s1b.jsonl` / `s1a.jsonl`）

1. turn 1：`tw open --name tiny-single … --entry implementation` → 卡 `intake-df5604`，awaiting-user；未派发。
2. turn 2（模拟用户 A）：
   - `decide --choice 1` 落旧卡 `intake-df5604`（`s1b.jsonl:6–7`）；
   - `tw plan` 两次失败：第一次 `writable`/`done` 用字符串被拒（`:11–12`）；第二次 JSON 缺外层右括号（`:17–18`）；
   - 改用 bash + `bin/tw.mjs --project-root` 调 plan，登记单包 `one-note`，卡重签为 `intake-227611`（`:47`）；
   - Lead 自述识别“awaiting-user 期间应等待新用户输入”，但以“用户已预先确认”`decide` 新卡（`:50–52`），`decide` 作用于 `intake-227611`（`:53`），随后立即 `tw-dispatch` 派单包 Owner（`:58–59`）。**没有新的用户输入。**
3. 成员：Owner 写 `docs/one-note.md`（1 行/85 字节），`tw deliver --key d1-570117` 登记。
4. turn 3：Lead 读回文件并检查行数，派发轻量交叉审查（Challenger `d2-67e018`）；Challenger accept（无 findings）。
5. `tw-dispatch` 推进 → `stop=awaiting-user` 阶段人工门 `dec-d18d3d`，静止。

## 3. 判定

| 条件 | 结果 | 说明 |
| --- | --- | --- |
| 意图确认前不派发 | 通过 | turn 1 只有 open/run |
| 小任务不拆、单 Owner、无汇总包 | 通过 | plan 单包 one-note |
| 重签卡经新用户输入确认 | **失败** | 新卡 `intake-227611` 由旧指令代答（见 `confirmation-audit.md`） |
| 非核心不产生 Expert 波 | 通过 | 仅 Challenger |
| 人工门静止 | 通过 | `stop=awaiting-user` |
| 验收证据链 | 通过（有环境缺口） | 1 行/85 字节；项目非 git 仓库，零改动以 mtime 佐证 |

> 另：本次输入明确要求“即使决定单包也请如实登记 plan”，因此**不能**用 S1 证明“Lead 能自主选择不登记计划的单 Owner”。

## 4. 发现

1. **重签卡代答（中高）**：见上；测试输入的“先 plan 再派发”是诱发因素，但按契约不能替代新卡确认。最小建议：技能“派发”条明确重签后必须等新用户输入，旧确认/预授权指令无效；演练脚本把确认与派发改成两个用户回合。
2. **字符串 writable 报错噪声（低，既有 Runtime）**：`cli.mjs:2141–2159` 对字符串逐字符迭代，产生“都写 d/o/c”等噪声，掩盖“writable 必须为数组”。本任务不改 Runtime。
3. **CLI 调用方式（中，引导相关）**：S1 先用 `tw` 工具，参数失败后才转 bash 调 `bin/tw.mjs`；与 S3/S4“一开始就走 bash 并手拼 TW_DSH_CONFIG”的路径不同，不应合并成同一根因。共同点是技能 Lead 操作段以 shell 示例呈现，未说明 DSH 宿主优先用工具。
4. **模型偶发畸形 JSON（观察）**：第二次 plan 参数缺括号，工具拒绝正确；有重试成本。

## 5. 未覆盖

- 一包先交/另一包在途（单包场景不存在）；
- 人工门未签（按约束不代答）。
