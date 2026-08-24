# Phase 3 实施方案：team-work-runtime DSH 插件包（v1）

状态：v1 草案 + 自复核记录（文末），待用户过目 → 双轴交叉评审 → 迭代 → 实施。
用户裁决固化：① 写边界落 skill 注入规范（不做平台 hook）；② tw 走插件原生工具注册（不做 preset 目录、PATH 注入退役）；③ 本仓库子目录 packages/dsh-plugin，打包范围精确圈定（不多不少）；④ 完整 E2E 压轴（agent 指定派发 + 数据隔离 + 八视角全流程）。

## 0. 平台事实基础（全部已验证）

| 事实 | 验证方式 |
| --- | --- |
| `ctx.subagents.registerContinuableSetup(contribution)` 官方 API；contribution 收子代私有 ctx；fresh+cold-resume 均覆盖 | 源码（dsh-subagent:2455）+ 用户对照实验（请求头实证 reasoningEffort） |
| `installModelSelection(childCtx, {current:{provider,model,reasoningEffort}})` 导出 | 源码（dsh-agent:272/794，含 effort 继承剥离） |
| 时序：createAgent 先 sessions.prepare(seed) 后 setup(childCtx)——派单全文（含 key）在 contribution 执行时已在子代 session 可读 | 源码（dsh-agent-loop:1240-1256） |
| 隔离：每子代独立 sessionId/Agent/ctx；seed 只入自身 session；监听器挂 per-agent carrier | 源码（dsh-subagent materializeTracked + dsh-agent enter） |
| `ctx.tools.register(definition)`：工具插件经 inject:["tools"] 获得；definition={name, description, inputSchema(JSON Schema), execute}；scoped shadow 全局、per-session 解绑；重名/保留名拒绝 | 源码（dsh-tools:2766-2790） |
| `ctx.skills.register`（skill 注册免文件拷贝） | 平台 README 在案（本方案实施首个动作：写最小验证脚本确认 API 形状——**遗留低风险**） |
| 徽标：`ctx.slots.inject("conversation.input.model")` + `sessions.models({sessionId})` RPC 返回 selectionFor(agent).current（含 reasoningEffort）；原生 ModelSelect 对 addressed 子代理不渲染（设计性隐藏，互补不冲突） | 源码（dsh-client-ui-model-selection:194/757 + dsh-host-apiproxy:1898）——用户调研 |
| `dsh plugin add <pkg>` = pnpm 装入 profile；client 插件经 exports["./client"] + platform:"web" 进 web bundle；开发期 dev:web HMR 或 profile 挂载重建 | 平台事实在案（Phase 1 调研） |

## 1. 包结构与打包范围（用户裁决 ③）

```
packages/dsh-plugin/
├── package.json          # name: team-work-runtime-dsh（独立可发布）
├── src/
│   ├── index.js          # host 插件入口（apply：注入 + skills + tools）
│   ├── inject.js         # registerContinuableSetup 注入（寻址解析 + installModelSelection）
│   ├── tw-tool.js        # ctx.tools.register 的 tw 原生工具（schema + spawn execution）
│   └── badge.jsx         # client 插件（slots 徽标）
└── README.md             # 安装/配置说明
```

**打包范围（精确圈定，防遗漏防多余）**：
- 插件包 files：`src/`、`README.md`、`package.json`——**不含**本仓库 roadmap/charter/测试/runtime-v3（插件运行时以 peerDependency 引用 team-work-runtime 或经由 tw 工具 spawn 已安装的 bin，见 §3 决策）；
- 本仓库 package.json 不变（插件独立子包独立版本）；根 files 清单**追加** `packages/dsh-plugin/`？——**不**：插件单独 npm 发布（workspace 不进主包），主包 files 保持现状；
- .gitignore：无新增（packages/ 进版本库）；
- file-inventory.json：newImplementation 增 `packages/dsh-plugin/src/index.js|inject.js|tw-tool.js|badge.jsx`、`packages/dsh-plugin/package.json`、`packages/dsh-plugin/README.md`。

## 2. host 插件：apply() 三件事

```js
export const name = "team-work-dsh"
export const inject = ["subagents", "skills", "tools"]

export function apply(ctx, config) {
  // 1) 成员模型/effort 注入（§2.1）
  ctx.subagents.registerContinuableSetup((childCtx) => injectModelFor(childCtx, config))
  // 2) skill 注册：team-work-v3 全文内嵌（免 .dsh/skills 拷贝；与 tw init 文件通道共存，init 降级为无插件环境兜底）
  // 3) tw 原生工具（§2.2）
  ctx.tools.register(twToolDefinition(config))
}
```

### 2.1 注入（inject.js）

寻址链（定稿方案）：子代首条消息（session seed）解析 `# 派单（key: …）` → 任务目录 `agents.json` 查 model-hint → `installModelSelection`。

```
决策数据流：
  tw dispatch-plan 出波（modelHint 已含 tier→池→多样性→risk→effort 全决策）
  → Lead 派发时 tw agent-map --key <k> --agent <id> --model-hint '{"provider":...,"model":...,"effort":...}'
  → 插件 contribution(childCtx)：
      seed = childCtx.agent.session.events.slice(header.seedLength)  // 只含本子代
      key  = /# 派单（key: (S+)）/.exec(seed)?.[1]
      hint = 读 <task-root>/.team-work/platform/agents.json 的 modelHints[key]（task-root 从 seed 的任务行解析）
      hint && installModelSelection(childCtx, { current: { provider, model, reasoningEffort: effort } })
  失败语义（逐级降级，全部静默）：key 解析不出 / agents.json 无此 key / 无 model-hint → 不注入（子代继承 Lead 默认——现状行为，不劣化）
```

**前置改动（runtime 侧，本仓库）**：`tw agent-map` 增 `--model-hint '<JSON>'` 参数（落盘 agents.json 的 modelHints 段；Lead 派发规程 skill 同步：开 subagent 前落 model-hint）。

### 2.2 tw 原生工具（tw-tool.js）

```
definition = {
  name: "tw",
  description: "team-work CLI：任务目录读写（open/plan/run/decide/deliver/review/...）。参数即 CLI 参数面",
  inputSchema: { type:"object", properties:{ args:{type:"array",items:{type:"string"},description:"CLI 参数（如 ["deliver","--task","t1","--key","w1-...","--outcome","delivered",...]"} }, required:["args"] },
  execute: spawn(process.execPath, [twBin, ...args], { cwd: 任务根推测或 config.projectRoot })
          → stdout JSON 卡片原样返回（exit≠0 时 code/message/fix 一并返回）
}
```
- twBin 解析：config 传入（插件配置 `{ twBin }`）→ 兜底 require.resolve("team-work-runtime/bin/tw.mjs")（插件 peerDep 主包）→ 再兜底 PATH 的 tw；
- 派单 PATH 注入退役：runtime 的 twCommand() 改为输出 `tw`（工具名）——Lead/成员经原生工具调用；保留 TW_CMD 环境变量覆盖（无插件环境兜底）；
- **不做**参数级 schema 拆解（args 透传 = CLI 即接口 P4 保持单层）。

### 2.3 skill 注册

`ctx.skills.register({ name: "team-work-v3", ... })`——SKILL.md + references 内嵌（构建期读入打包或运行期相对路径读取，实施时按 API 形状定，验证脚本先行）。tw init 保留为无插件环境的兜底通道（skill 文件拷贝），README 注明两者关系。

## 3. client 插件：模型席位徽标（badge.jsx）

用户调研骨架原样落地：`slots.inject("conversation.input.model")` 注册只读徽标（order 20；仅 subagentAddress(sessionId) 非空的会话渲染；`sessions.models` RPC 取 current；显示 provider/model · 推理等级；RPC 失败静默 null）。

## 4. skill 注入规范补强（写边界，用户裁决 ①）

派单文本的边界声明强化（runtime dispatchCard 小改）：owner 派单在可写路径清单后追加一句——"可写范围外的修改会被 deliver 拒绝并在恢复轮回滚（快照恢复）；不要尝试绕过"。skill 成员纪律节同步引用。

## 5. 实施序与测试

1. **验证脚本先行**：最小 cordis 插件（仅 ctx.skills.register 空实现 + ctx.tools.register echo 工具）本地 profile 挂载跑通——确认两个未实证 API 的真实形状（低风险高确定性）；
2. packages/dsh-plugin 骨架 + inject.js（注入链）+ 单测：寻址解析（seed 提取 key/任务名/降级路径）纯函数单测（node:test，不依赖 DSH 运行时）；
3. tw agent-map --model-hint + runtime twCommand 退役 PATH 注入（测试：model-hint 落盘/读取；派单文本工具名化）；
4. tw-tool.js + badge.jsx；
5. skill 注入规范补强（§4）；
6. 打包验证：插件包 npm pack 检查 files 恰好 = 设计清单（不多不少）；主包 npm pack 确认无插件文件混入；
7. **压轴 E2E（用户裁决 ④，插件本地挂载后）**：多任务并发——agent 指定派发（model-hint 注入生效=徽标显示对应模型/effort）+ 数据隔离（两任务同进程各自注入不串）+ 八视角全流程（升档卡实测）+ e2eTemplate 链 + 人工门。

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| ctx.skills.register 形状与预期不符 | 验证脚本先行（实施第 1 步），不符则按实际 API 调整（skill 也可退回文件通道不受阻） |
| 子代 session.events 读取 API 形状（header.seedLength 切片）与 mock 实验差异 | 注入链纯函数化（解析逻辑独立可单测）；集成验证在压轴 E2E |
| spawn tw 工具的任务根定位 | config.projectRoot 显式优先；派单文本含任务名（成员 cwd 不可靠时从 args --task 反查不做了——cwd=config 即可） |
| 插件包误打包仓库文档/测试 | npm pack 双向断言（§5.6）；CI 无——本地脚本固化 |
| 徽标在非 web 平台加载 | platform:"web" 声明限定；非 web 静默跳过 |

## 7. 明确不做（本阶段）

写边界平台 hook（用户裁决：skill 规范承载）；preset 目录形态（ctx.tools 注册已覆盖）；插件内嵌 runtime 逻辑（tw 经 spawn 调用，插件只做桥）；选模数据采集（独立后续）；Phase 2 投影（已否决）。

---

## 自复核记录（v1）

1. 用户四裁决逐条核对：①写边界→§4 skill ✓；②tw 原生工具+非 preset→§2.2 ✓（PATH 退役在 runtime 侧同步）；③子目录+打包圈定→§1（npm pack 双向断言防漏防多）✓；④压轴 E2E 范围含指定派发/隔离/八视角→§5.7 ✓
2. 完备性自问：方案是否可实施无未知？——两处标注：ctx.skills.register（§0 遗留低风险+验证脚本第 1 步）；badge 的 jsx 打包（实施时按 client 插件模板，dsh-client-ui-* 有现成参照）✓
3. 与既有机制冲突检查：tw init 与 skill 注册共存关系已写明（init=无插件兜底）✓；twCommand 退役与 TW_CMD 保留不矛盾 ✓；注入失败降级=继承默认（不劣化现状）✓
4. 遗漏检查：plugin 的 config 面板（dsh 配置如何传 twBin/projectRoot）→ §2.2 config 传入 + require.resolve 兜底，README 补配置节 ✓（实施时定 config schema 细节）
5. 盲区自查：本方案最大不确定=两个未实证 API（skills.register/tools.register 的 config 细节）→ 已前置验证脚本第 1 步显式化，不让它埋到实施中期 ✓
6. 打包断言可测试性：npm pack 输出文件清单断言进 scripts（可重复执行）✓
