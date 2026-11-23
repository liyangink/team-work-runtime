隔离评测场景 S4（全部内容虚构，不涉及真实数据）：请按 team-work 技能启动一个 implementation 入口的任务并制定计划，但在我确认意图前不要派发任何成员。
任务名：alias-clash
目标：为虚构产品写两条功能说明
原始需求：两条说明都必须写进同一个文件 docs/notes.md，希望两个人分别写各自那条
验收：docs/notes.md 包含两条说明
步骤：
1. 用原生 tw 工具执行 open（--name alias-clash --objective "为虚构产品写两条功能说明" --raw-requirement "两条说明都必须写进同一个文件 docs/notes.md，希望两个人分别写各自那条" --acceptance "docs/notes.md 包含两条说明" --entry implementation）。
2. 用原生 tw 工具执行 plan 登记你的计划；如不拆包请说明理由。不要调用 tw-dispatch 推进，也不要创建任何成员。
最后报告：你的拆包/不拆包决定与依据、每包可写范围与依赖、以及你打算如何安排写入先后顺序。不要派发。
