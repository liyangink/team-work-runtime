这是隔离环境中的无害哨兵预检，全部内容虚构，不涉及真实数据。请严格按顺序执行并原样报告事实：
1. 调用 tw 工具执行 ["open","--name","probe-dispatch","--objective","虚构预检：为两段独立说明各写一行标语","--raw-requirement","只在 docs/ 下写两个虚构小文件，内容自拟","--entry","implementation"]，报告返回 JSON 完整内容。
2. 调用 tw 工具执行 ["run","--task","probe-dispatch"]，原样报告返回 JSON 完整内容，特别是卡片类型与 nextAction/stop 字段。
3. 调用 bash 工具执行 "pwd; ls -la .team-work/tasks; ls -la .team-work/tasks/probe-dispatch 2>/dev/null"，原样报告输出。
不要派发成员，不要读取项目外目录。