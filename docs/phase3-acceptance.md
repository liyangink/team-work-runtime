# Phase 3 插件验收证据（F-1..F-12 状态快照，2026-08-24）

自动验证全部通过（当前 116/116 测试 + 构建链 + 冒烟 + C1 实机 boot 链 + 隔离 web 实例）。逐项证据：

| # | 功能 | 状态 | 验证实体 |
| --- | --- | --- | --- |
| F-1 安装（装载） | ✅ 自动 | tests/dsh-plugin-e2e.test.mjs（真实 cordis 装载层）+ scripts/e2e-c1.mjs（实机 dsh boot 链：bundle→patch→loader，dump-config 装配树断言）。**rc.7 修正（2026-08-25）**：原 patch 写法 `- id + plugin:` 在 rc.7 的 applyEntryPatches 语义下是无 insert 的 override 行→warn 后静默跳过，插件从未装载；当年 C1 断言合并 stdout+stderr 把 "entry not found" warn 误判为命中。已改规范 insert 行（`- insert:` 子行 `{id, name:包名}`），断言改纯 stdout 判 id+name 双命中 |  |
| F-2 安装后生效（三注册） | ✅ 自动 | 同上（apply 三注册真调用 + inject 恰三服务断言——F1 类 blocker 永久防线） |  |
| F-3 默认配置零配置 | ✅ 自动 | tests/e2e-b-matrix.test.mjs F-3（无 dsh.json 无插件全流程） |  |
| F-4 自定义配置 | ✅ 自动 | 同上 F-6/F-4（自定义池首选生效） |  |
| F-5 注入（指定派发） | ⏳ 待用户实机 | 注入链纯函数 + 真文件补写（dsh-plugin-e2e 第二测）+ E2E-B agents.json 层；真实 LLM 注入断言需带凭据会话（README 实机验证节步骤 1-2） |  |
| F-6 数据隔离 | ✅ 自动 | E2E-B F-6/F-4（双任务 modelHints 按 childId 分键不串） |  |
| F-7 effort 链路 | ⏳ 待用户实机 | effort→reasoningEffort 映射链全测；进 request header 与否待实机（已知边界：不进也无损） |  |
| F-8 tw 原生工具 | ✅ 自动 | E2E-A 形状断言（parameters/output.render）+ 冒烟 S4（spawn 真调 open→卡片）+ F4 修复（timeoutMs/__exit 剥离） |  |
| F-9 升档审批卡 | ✅ 自动 | E2E-B F-9+F-10（触发/只列升档包/批准后 expert 生效） |  |
| F-10 八视角全流程 | ✅ 自动 | 同上（三视角并行→组合评审→裁决→汇总包解锁→completed） |  |
| F-11 e2eTemplate | ✅ 自动 | E2E-B F-11（run 路由→e2e 阶段→path-design/execution 依赖串行） |  |
| F-12 徽标 | ⏳ 自动行为已绿，待用户实机过目 | 6 项 I4 行为测试覆盖 DSH 工厂与席位释放、`result.value.current` 解包、父会话原生选择器隔离、运行状态刷新、addressed RPC 真拒绝时从真实 requestConfig 降级显示；注册到模型选择器相邻的 `conversation.input.right`。安装后的位置与样式仍需真实 web 会话过目 |  |

实施过程审查链：方案双轴评审（16 findings 含 2 blocker 全处置）→ 交叉审查①（8 findings 含 1 blocker 全修复 0fba810）→ 交叉审查③：全量版中断但中间发现已消化（C1 脚本脱节修复 72a8474）；轻量版完成核验——**诚实性判定：无夸大无贬低、划分如实；断言强度三抽全强（升档卡 tier 真断言/依赖锁时序证明/inject deepEqual 主防线）；遗漏 1 major（charter §8 漏同步）已修**。C1 实机挖出并修复 bundle 装载协议缺失（eba7480）；§4 写边界声明遗漏自查补上（6fec6d3）。
