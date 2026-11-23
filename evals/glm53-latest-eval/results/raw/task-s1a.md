隔离评测场景 S1（全部内容虚构，不涉及真实数据）：请按 team-work 技能启动一个 implementation 入口的任务并推进到首次确认卡。
任务名：tiny-single
目标：只在 docs/one-note.md 写一行虚构说明
原始需求：在 docs/one-note.md 写一行虚构的产品说明，内容自拟
验收：docs/one-note.md 包含一行说明
步骤（请按顺序执行）：
1. 用原生 tw 工具执行 open（--name tiny-single --objective "只在 docs/one-note.md 写一行虚构说明" --raw-requirement "在 docs/one-note.md 写一行虚构的产品说明，内容自拟" --acceptance "docs/one-note.md 包含一行说明" --entry implementation）。如果返回的是内部准备回执而不是确认卡，不要把它当成用户确认卡展示给我。
2. 用原生 tw 工具执行 plan，登记你的完整分包计划（即使决定单包也如实登记；无包时说明单 Owner 与首派可写范围）。
3. 用原生 tw-dispatch 推进一次，取得首次意图确认卡；把这张卡完整呈现给我：原始需求、目标/约束/排除、范围与产出、三角色模型、完整分包计划（或单 Owner 首派可写范围与验收）、卡片标识与选项。
在我看到并确认这张卡之前：不要替我选择、不要 decide、不要创建任何成员、不要用旧指令代替我确认。
