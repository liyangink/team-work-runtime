# 必要请求原样重发：urgent-retry-sample

本案只验证隔离 DSH 对真实成员消息的恢复。只读当前 SCENARIO.md，不递归列目录，不读 .team-work 内部状态、HOME、环境、密钥或真实仓库。只用宿主原生工具，禁止 shell、外部网络、普通委派或修改配置。成员只按派单写合成的 artifacts/review.md。

- Owner：未交卷前必须先解决甲乙两份基准相冲突的阻塞。第一次 send_message 发给 lead 的 message 严格为「A-EXACT-RETRY 甲乙基准冲突，请 Lead 选定唯一口径；收到答复前不能继续。」如果首发回「未发送」，在模型看到提示的**后一 Step**用同收件人、同一整句原样重发一次；不要用其他消息消耗机会，不在同一工具批次内重试，不提前交卷。确认收到 Lead 的「A-LEAD-ANSWER」选择甲，才用原生 write 写整行「重发核验：已收到甲口径。」加换行，并用 tw deliver 登记；没有回答，就短等一次原生 wait_agent 或先停止受影响工作，不猜口径。不发其他进展或最终摘要。
- Lead：首派给 Owner 后自然等待，不先发任何协调消息；在实际收到 A-EXACT-RETRY 后用 list_agents 查真实名称，发送「A-LEAD-ANSWER 选甲口径，请登记后结束。」收到正式结项时检查原生 tw run，不再派下一波，结束本次隔离样本。不要把文字摘要或 inactive 状态当已交卷。
