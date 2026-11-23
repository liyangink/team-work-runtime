# 证据 P：预检观察（原 S2 计划）

> P1/P2 是同一项**预检**会话，只作为预检中的真实行为观察，**不作为独立 S2 场景通过**。S2 的独立有效演练未执行。
> 判定：预检观察（两包/组合审行为可见）；重签卡代答属实际缺陷（F1）。

## 1. 环境与模型

- 被测 Lead 会话：session-0a0233ca-fab1-4b3a-829b-1c5b5e638374；cwd /private/tmp/twr-glm53-eval/project。
- 模型原始回执：results/raw/session-model-records.jsonl 的 requestHeader.header.config = provider zai-coding-cn、model glm-5.3、effort max；tw open 三角色同。
- 技能：隔离 profile 内的 skills/team-work-v3；会话日志工具返回全文 14,175 字节、SHA-256 22bf…（见 skill-loaded/tool-return-hashes.jsonl）。

## 2. 观察到的行为（raw 行号为 p2.jsonl）

1. turn 1：tw open --name probe-dispatch → 卡 intake-0037db；未派发。
2. turn 2（模拟用户 A：“确认 + 先 plan 再派发”）：
   - plan 第一次 writable 字符串被拒（:6–7）；第二次成功登记两包 pkg-alpha/pkg-beta，卡重签 intake-32766e（:12–13）；
   - Lead 无新用户输入直接 decide 新卡（:18–19），随后 tw-dispatch 同波派 2 Owner（:24）；**确认纪律失败**（详见 confirmation-audit.md）。
3. 两位 Owner 各写一个文件并 tw deliver（d1-f6ff16、d1-1008b7）；两包交付时间差 <5s。
4. Lead 只读核验两文件，tw-dispatch 派组合交叉审（d3-d6271c）；Challenger accept + 1 条非阻塞 info。
5. tw-dispatch 推进 → stop=awaiting-user 阶段门 dec-9c900b，静止。

## 3. 观察清单

| 项 | 观察 |
| --- | --- |
| 两包写范围互斥、路径规范 | 是（两个不同文件） |
| 两包同波并行 | 是（2 个 dispatch key/2 个成员会话） |
| 两包齐后才组合挑战 | 是（两包交付后才派审查） |
| 一包先交、另一包在途的等待分支 | **未观测**（交付间隔 <5s） |
| 重签卡经新用户输入确认 | **失败**（intake-32766e 被旧指令代答） |
| 非核心无 Expert 波 | 是（仅 Challenger） |
| 人工门静止 | 是（stop=awaiting-user） |

## 4. 结论

- 这是预检环境中的行为观察，不能作为 S2 通过；S2 需要隔离证明后另做独立演练。
- 重签确认失守是实际缺陷，见 F1 与 confirmation-audit.md。
- Challenger 的 tw review --help 不被识别（改用 tw help），属既有 CLI 行为。

## 5. 未覆盖

- 明显部分在途窗口；包级返工；人工门未签。
