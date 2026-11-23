# 双包合成审查：sample-register

本案只处理虚构登记页。仅访问当前隔离项目文件与已加载的 TWR 技能；不读 HOME、环境变量、密钥、真实仓库，不联网检索，不改配置、插件或任务内部文件，不申请更宽沙箱。只用原生 skill、read、write、tw、tw-dispatch，角色不能互代。不得用 shell、脚本、edit 或别的工具代写、代读、代派发；原生写入是完整文件，每件用下文「」中的一行准确文字加一个 LF 换行，不加标题、空格或其它行。每次审查须用本角色的 read 成功读完当前列出的每件，不能用派单摘要或旧轮读取替代；有拒绝就保留原回执、不补造。

评审提交前先用原生 `tw help` 查公开契约，不调用 `tw review --help`。原生 `tw` 的 `args` 是参数数组：每个 flag 的值占一个元素；`--findings` 的值是完整 JSON 数组字符串，`scope.ids` 必须是真实数组而不是带引号的数组文本。finding 仅有 `severity`（`info|risk|blocker`）、`statement`（非空原文）、`disposition`（`must-fix|context`）和 `scope`；本案点名包用 `{"kind":"packages","ids":["alpha"]}` 或对应乙包，非必改上下文用 `severity: "info"`。

局部形状示例：`[{"severity":"blocker","statement":"此处写本轮实际发现的原文","disposition":"must-fix","scope":{"kind":"packages","ids":["alpha"]}}]`。Expert 每次 `review` 同时给 `--verdict`（如 `{"outcome":"rework","rationale":"说明实际裁决依据","confidence":"high","recommendedAction":"说明下一步"}`）和 `--findings`（需要返工必须有上述结构化 `must-fix`，不把 finding 塞进 verdict；最终没有新发现可给 `[]`）。示例只说明字段，不当作审查原文或读取依据。

- 两个独立包并行首派。甲包 alpha 首次交 artifacts/alpha/main.md（含一行「状态：待复核」）与 artifacts/alpha/legacy.md（含「旧版交接」，后续即使移出也保留此文件、禁止改写）；乙包 beta 首次交 artifacts/beta/main.md（含「乙包已核验」）。每位 Owner 只在本包目录落制品，每次 deliver 列整份完整有效清单。
- 第一次 Challenger 用 read 完整读甲主文档、旧页和乙文档这三件，看见旧版交接页后提交 rework，并仅用 scope={kind:"packages",ids:["alpha"]} 的 must-fix 要求甲包把旧版交接页替换为新增索引、磁盘不删除旧文件；finding 的自然中文原文含标记 CH-ALPHA-INDEX，summary 不复述标记或原文。不要求乙包改。
- 甲包收到正式返工派单后，才新增 artifacts/alpha/index.md（含「索引已复核」）并交 main.md 与 index.md，不再登记 legacy.md。保持 main.md 内容不变，保留 legacy.md 的磁盘字节。检查返工回执应恰好新增 index.md、移出 legacy.md；不要重交改造结果来掩盖错误。
- 第二次 Challenger 用 read 完整读当前清单（甲主文档、索引、乙文档）后 accept；同时写两条 disposition=context、severity=info 的独立非必改上下文：甲包范围一条含 CTX-ALPHA，乙包范围一条含 CTX-BETA；summary 不复述标记。首次 Expert 用 read 完整读同一组三件并实看甲包状态，recommendation=accept、verdict.outcome=rework，仅给甲包 must-fix 要求把甲主文档的状态改成「状态：归档就绪」，finding 原文含标记 EX-ALPHA-READY，summary/verdict 的 rationale 不复述该标记和原文。该测点要求尝试合法的不同双结论，不是要求到人工门后再返工。
- 甲包只完成裁决定点；检查本次派单含本包 Expert 必改原文及本包 Challenger context，不得含乙包 context；必须先用 read 查看原主文档「状态：待复核」，再用 write 将该文件全文改为「状态：归档就绪」，交 main.md 与 index.md（路径集合未变化）。重新 Challenger accept、Expert accept（verdict.outcome=accept），两者各自重新 read 完整读新版甲主文档、索引、乙文档这三件。乙包只首交一次，参与该波适用的组合核验。最后按合成文本不涉及可部署应用的实际依据显式 route e2e=skip，不冒充真实应用 E2E 已执行。
- Lead 只推进及呈现；首卡和最终人工门都等待操作者明确回复当前决定 ID 和选项，不自答、不轮询。正常波次接单后自然结束回合等待宿主成员通知；有结算通知/新用户输入再推进，不能用睡眠反复查询或另起成员弥补已登记会话。
