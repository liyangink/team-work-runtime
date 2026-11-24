# 自主轮次上限：round-sample

这里只处理一份合成记录。所有角色在首次和续派本轮工作前先实际读取 SCENARIO.md；只读本文件和 artifacts/review.md，不读取 .team-work 内部日志、HOME、环境、密钥、真实项目或历史会话。不运行 shell、普通委派或外部网络。Lead 只推进，Owner 只写用例制品，Challenger 与 Expert 只读独立复核。只用宿主公开工具，禁止伪造结果。

| 实际展示轮 | Owner 写入 artifacts/review.md 的唯一一行 | Challenger 实读要求和决定 |
|---|---|---|
| 1 | 审查记录：1，甲口径，符合初次验收。 | 实读全文，accept。 |
| 2 | 审查记录：2，乙口径，缺少新的追踪编号。 | 实读本轮，明确缺追踪编号，rework，要第 3 轮。 |
| 3 | 审查记录：3，乙口径，缺少新的追踪编号。 | 同理实读，rework，要第 4 轮。 |
| 4 | 审查记录：4，乙口径，缺少新的追踪编号。 | 同理实读，rework，要第 5 轮。 |
| 5 | 审查记录：5，乙口径，追踪编号 TRACE-05。 | 实读本轮，accept。 |

- Owner：轮次由正式派单决定；续派先读上版，将表中相应行加 LF 换行完整替换，不跨轮提前添加追踪编号。这是测试驱动有意变化的待验内容，不是自主裁定允许缺件。每轮调用 tw deliver --outcome delivered，登记完整路径 artifacts/review.md；不要把合成缺件设计误当自己阻塞，也不要额外发进度。
- Challenger：每轮重读剧本和实际制品；尤其不能因第 2 轮乙口径正确而 accept，缺追踪编号是合成的本轮阻塞。第 2/3/4 轮据实提交 tw review --recommendation rework，--findings 的参数是一整个 JSON 字符串，例如 [{"severity":"blocker","statement":"实际第 2 轮记录缺少新的追踪编号；下一轮检查是否补齐","disposition":"must-fix","scope":{"kind":"all-covered"}}]；statement 用本轮实读轮号。第 1/5 轮真实符合表中验收时 accept。
- Expert：只有 Challenger 接受后获派，实际复核本轮文件与表中规则。第 1/5 轮符合时调用 tw review --recommendation accept，--verdict 的值为形如 {"outcome":"accept","rationale":"本轮原生 read 的制品符合合成验收要求","confidence":"high","recommendedAction":"进入本阶段人工门"} 的完整 JSON 字符串。不得替 Challenger 修改结论。
- Lead：只有宿主正常结项后用 tw-dispatch 推下一波，不轮询；所有用户决定（首次验收返工、上限、再次验收）只展示当前真实卡并结束回合，发现其他卡也不自答；外部测试驱动在新的原生用户回合选择实际卡 ID 和选项。产物不是应用，不将跳过应用 E2E 冒称已执行。
