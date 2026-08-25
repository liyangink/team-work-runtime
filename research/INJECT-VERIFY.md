# 注入寻址验证结论

原 `projectRoots` 最长前缀匹配算法已废弃。`projectRoots`、`injectionEnabled`、`twBin` 均已从插件 schema 与运行链移除，且不保留兼容读取；残留 YAML 可由用户手动删除。

当前注入只以子会话的 cwd 定位项目 `.team-work/platform/agents.json`，从其中读取 childId 对应的 modelHint 快照。`tw` 原生工具同样只使用调用子会话的 cwd，并通过内置解析定位 runtime 入口；缺少 cwd 时返回可恢复的诊断结果，不会跨项目猜测路径。
