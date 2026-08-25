# Phase 3 DSH 根制品验收证据（F-1..F-12）

> **全局配置迁移**：tier→模型的唯一配置源现为 DSH 全局 settings 的 `team-work-dsh.tiers`（DSH Web“插件配置”页）。项目 `.team-work/platform/dsh.json` 不再读取或创建，可手动删除；`.team-work/platform/agents.json` 继续保存 child 映射与 modelHint 快照。`injectionEnabled`、`projectRoots`、`twBin` 已从 schema 与运行链移除，不保留兼容读取。Web 保存同时硬校验：Provider active、每个候选 Provider 的模型目录可验证、模型实际在目录中；模型 RPC 整体失败、候选 Provider 目录失败或缺少目录都会阻止保存并显示恢复指引，公开非空 effort 列表中的填写值也必须命中。

自动层覆盖其可验证范围（完整自动套件 + 根 npm pack 清单 + 根制品 boot 链 + 隔离 Web 实例）。F-5/F-7/F-12 仍需用户在带凭据的真实会话中确认，不能由本快照宣称完成。逐项证据：

| # | 功能 | 状态 | 验证实体 |
| --- | --- | --- | --- |
| F-1 安装（装载） | ✅ 自动 | `tests/dsh-plugin-e2e.test.mjs` 验证真实 Cordis 装载层；`tests/e2e-root.test.mjs` 验证唯一根制品的 bundle→patch→loader 链和 dump-config 装配树；根 `npm pack --dry-run` 验证 Runtime、CLI、skill、host/client 与 patch 同包在场 |  |
| F-2 安装后生效（三注册） | ✅ 自动 | 同上（apply 三注册真调用 + inject 恰三服务断言——F1 类 blocker 永久防线） |  |
| F-3 全局配置基线 | ✅ 自动 | tests/e2e-b-matrix.test.mjs F-3（无项目 dsh.json、无插件；DSH 全局 tiers 完成派发与交付） |  |
| F-4 自定义全局候选池 | ✅ 自动 | 同上 F-6/F-4（`team-work-dsh.tiers` 自定义池首选生效） |  |
| F-5 注入（指定派发） | ⏳ 待用户实机 | 注入链纯函数 + 真文件补写（dsh-plugin-e2e 第二测）+ E2E-B agents.json 层；真实 LLM 注入断言需带凭据会话（根 README 的 DSH 节） |  |
| F-6 数据隔离 | ✅ 自动 | E2E-B F-6/F-4（双任务 modelHints 按 childId 分键不串） |  |
| F-7 effort 链路 | ⏳ 待用户实机 | effort→reasoningEffort 映射链全测；进 request header 与否待实机（已知边界：不进也无损） |  |
| F-8 tw 原生工具 | ✅ 自动 | E2E-A 形状断言（parameters/output.render）+ 冒烟 S4（spawn 真调 open→卡片）+ F4 修复（timeoutMs/__exit 剥离） |  |
| F-9 升档审批卡 | ✅ 自动 | E2E-B F-9+F-10（触发/只列升档包/批准后 expert 生效） |  |
| F-10 八视角全流程 | ✅ 自动 | 同上（三视角并行→组合评审→裁决→汇总包解锁→completed） |  |
| F-11 e2eTemplate | ✅ 自动 | E2E-B F-11（run 路由→e2e 阶段→path-design/execution 依赖串行） |  |
| F-12 徽标 | ⏳ 自动行为已绿，待用户实机过目 | 6 项 I4 行为测试覆盖 DSH 工厂与席位释放、`result.value.current` 解包、父会话原生选择器隔离、运行状态刷新、addressed RPC 真拒绝时从真实 requestConfig 降级显示；注册到模型选择器相邻的 `conversation.input.right`。安装后的位置与样式仍需真实 web 会话过目 |  |
