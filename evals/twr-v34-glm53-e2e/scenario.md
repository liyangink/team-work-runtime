# 合成审查样本：coordination-sample

这里只读当前隔离项目的 SCENARIO.md 和已装加载技能；成员只写被派单授权的 artifacts/review.md。不要访问真实工作区、HOME、环境变量或密钥，不使用 shell、任意 Node API、外部网络或普通委派。消息用宿主原生 send_message（若在 run_code 中使用 tools.send_message，每次只发一个本测点消息，分开外部模型 Step，不在同一程序内循环重试）。以实际结果为准。

- **Owner 第 1 轮**：做一个故意的降噪探针：先尝试发给 lead「A-NOISE-OPEN 例行开工播报」一次。若收到未发送软提示，不补发开工，也自主判断是否要发第二个无实际处置价值的检查点「A-NOISE-CHECK 已开始读取」。在正式交卷前再独立测试真实协调：用「A-BLOCK-REQUEST 甲乙口径冲突，现在不能继续，请 Lead 裁定用哪一口径」求助，收到未发送提示在更晚模型 Step 重发相同消息一次（不要因为被拦就跳过）；若轮到此步骤时收到 Lead 主动问询，不要立刻交卷，先完成这条求助。只有收到 Lead 回答「A-LEAD-ANSWER」明确选定口径，才能用原生 write 交本轮的一行「审查记录：1，甲口径。」并用 tw deliver 登记。如果尚未收到回答，可短等一次原生 wait_agent，或结束本次回合等待 Lead 纠偏再继续，不猜答案。如果真正无法继续，明确报告阻塞。不要额外发送进度或最终摘要。Lead 主动问询或纠偏使用原生工具，已收到的决定不要冒称是自己作出的。
- **Owner 之后各轮**：读当前制品，将其中轮号增 1；只更新该制品，交同一完整路径清单。第 2 轮是合成人工门返工，换为「乙口径」；之后保留乙口径。写入内容严格形如「审查记录：2，乙口径。」并加换行；实际轮号以派单/原制品为准。照此提交，不自行增加派发或再发进度。
- **Challenger**：每轮实际 read 当前 artifacts/review.md。读到第 1 轮甲或第 5 轮乙，使用 tw review accept。读到第 2、3、4 轮乙，按本合成剧本要求下一版增加追踪轮号，提交 tw review rework，并以 --findings 精确传字符串 JSON 数组，例如 [{"severity":"blocker","statement":"合成追踪验收尚需下一版轮号，当前读到第 2 轮","disposition":"must-fix","scope":{"kind":"all-covered"}}]；按确实读到的轮号改 statement。不要自行写制品，不发送普通进度。
- **Expert**：核心审查只在 Challenger 接受后获派，必须实际 read 制品，验证第 1 轮甲或第 5 轮乙；用 tw review ，recommendation=accept，并用 --verdict 精确传字符串 JSON 对象 {"outcome":"accept","rationale":"已读到本轮实际的审查记录，口径正确","confidence":"high","recommendedAction":"进入合成人工门"}（按实读调整理由）。不代 Challenger，不发送普通进度。
- **Lead**：首派成功若有 Owner，用宿主 list_agents 查真实可发名字，主动发「A-LEAD-ASK 请核对是否有甲乙口径冲突，若有请在交卷前反馈」一次，非正式派单；只对实际收到的 A-BLOCK-REQUEST 回「A-LEAD-ANSWER 使用甲口径，可以继续」。之后只在宿主正常结项通知后用 tw-dispatch 实际推进，不根据消息或 inactive 冒称结项；正式派发后自然结束模型回合等待，不轮询。若 e2e 适用性要求路由，本案只涉及合成文本，凭此理由用现有 tw route 明确 skip，不代填测试结果。只呈现实际的人门或轮次卡，不自行批准。
