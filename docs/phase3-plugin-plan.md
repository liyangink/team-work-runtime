# Phase 3 实施方案：team-work-runtime DSH 插件包（v2）

状态：双轴交叉评审完成（意图轴 7 findings + 技术轴 9 findings，含 2 blocker），全部吸收；处置记录见文末。待实施。
用户裁决固化：①写边界落 skill 规范；②tw 走 ctx.tools.register 原生工具（PATH 注入保留为 standalone 兜底）；③本仓库 packages/dsh-plugin 子目录，打包 npm pack 双向断言；④压轴 E2E（指定派发+数据隔离+八视角）。

## 0. 平台事实（逐条源码验证，v2 修订版）

| 事实 | 依据 |
| --- | --- |
| `registerContinuableSetup(contribution)`：contribution 收子代私有 ctx（= agent.ctx），fresh+resume 均执行 | dsh-subagent:2455 + 用户实验 |
| **时序（B-F1 证伪修正）**：materialize（内含 createAgent→setup→contribution）先于 submitMaterialized(prompt)——**contribution 执行时派单文本不在 session**；session 内 seed 仅 descriptor 事件（label/mode/agentProvider）；header.seedLength = 父继承前缀长（非派单长） | dsh-subagent:795-833（本方亲验） |
| **childCtx.agent.id 可读且持久**（= childId，cold-resume 同 id）——注入寻址的稳定主键 | dsh-agent-loop:353-378 |
| 子代 session.header **继承父 cwd**（childSessionMeta 透传，durable）——任务根定位的兜底事实 | dsh-subagent:528-540 |
| `installModelSelection(agentCtx, selection)`：selection = `{current:{provider,model,reasoningEffort}, assembled}`（assembled 首次 assemble 自动填充） | dsh-agent:272-296 |
| `ctx.tools.register(definition)`：**必填 output = {schema, render(args,value)}**（缺则 throw）；参数字段名 **parameters**（非 inputSchema）；JSON Schema 白名单含 array/items；保留名仅 run_code；execute(args, exec) async，exec 含 agent/signal；返回值经 output.schema 校验后由 render 转模型可见文本 | dsh-tools:2762-2790/3406-3411/851-862 |
| `ctx.skills.register({name, description(必填), content(必填=SKILL.md 全文), whenToUse?, resourceBase?{kind:"directory"|"url"|"opaque"}, ...})`——references 经 resourceBase（directory=插件内打包目录） | dsh-skill:193-215/465-469 |
| 徽标装载：client 插件须 `dsh.client.platform:"web"` + `exports["./client"]`，产物为 **window.__ModuleLoader__.load 工厂式 CJS bundle**（无运行时 JSX 转译）；徽标注册到模型选择器左侧的可追加席位 `conversation.input.right`，不得抢占 `single` 的 `conversation.input.model`；实际请求值优先取会话 `requestConfig`，首轮前才以 `sessions.models` 的 `result.value.current` 兜底（部分宿主明确不向 addressed 子代理开放该 RPC） | dsh-client-modules + conversation slots contract + model-selection ModelDirectory（2026-08-25 实机问题复盘修正） |
| profile 装载：$DSH_HOME/profiles/<name>（package.json bundles + pnpm-workspace + cordis.patch.yml），node_modules flat fallback 解析——本地验证脚本路径可行 | dsh-app-boot:284-406 |
| **bundle 装载协议（rc.7 实锤修正，原 C1 结论有误）**：package.json 声明 `dsh.bundle.patch`（缺则 boot 拒绝 "declares no dsh.bundle"）+ patch 文件须为**规范 insert 行**：`- insert:` 子行 `{id, name}`，`name`=npm 包名（loader 据此从 profile node_modules 解析 main 入口）。旧写法 `- id:` + `plugin: ./dist/index.js` 是无 `insert` 键的 override 行——目标 id 不存在时 `applyEntryPatches` warn 后**静默跳过**（插件从未装载）；当年 C1 断言合并 stdout+stderr，命中的恰是这条 warn，误判为装载成功 | cordis-plugin-include applyEntryPatches（装载与 dump-config 共用语义）+ ntes-dsh-market verify.ts 实测 |

## 1. 包结构与打包范围

```
packages/dsh-plugin/
├── package.json        # name: team-work-runtime-dsh；dsh.client.platform:"web"；exports{"./client":"./dist/client.js"}
├── src/                # 源码（index/inject/tw-tool/skill-embed）
├── src-client/badge.js # 徽标源码
├── dist/               # 构建产物（client bundle 工厂式 CJS；gitignore）
├── build.mjs           # 构建脚本（esbuild 打包 client bundle + skill 内嵌生成）
└── README.md           # 安装/配置（脱敏示例）
```

files：`dist/`、`README.md`（src 不进发布——npm 包只交付运行产物 + 类型；**构建期把 skills/team-work-v3 读入 dist/skill/**，A-F5）。主包 npm pack 不含 packages/（无 workspaces 字段已由 B-F8 实验证实）。npm pack 双向断言固化进 build.mjs。

## 2. host 插件（index.js，inject: ["subagents","skills","tools"]）

### 2.1 注入（inject.js）——寻址主键 childId（B-F1 修正）

```
数据流（v2 定稿：runtime 自动落盘，A-F1 修 P4）：
  tw dispatch-plan 出波（modelHint 全决策：tier→池→家族去重→risk→effort）
  → Lead: tw agent-map --task <n> --key <k> --agent <childId>
      runtime 内部自动重算该 key 的 modelHint（复用 dispatch-plan 同一函数）
      落盘 agents.json: { mappings:{k:childId}, modelHints:{<childId>:{provider,model,effort}} }
      （--model-hint 参数仅作显式覆盖，常规流程零手动转录）
  → 插件 contribution(childCtx)：
      hint = modelHints[childCtx.agent.id]        // childId 直查，无文本解析
      hint && installModelSelection(childCtx, { current: { provider, model, reasoningEffort: effort } })
  agents.json 定位：config.projectRoot 显式配置 → 兜底 childCtx.agent.session.header.cwd + "/.team-work/platform/agents.json"
  失败语义（逐级静默降级）：无 config 无 header.cwd / 无 modelHints / 无此 childId → 不注入（继承 Lead 默认，不劣化现状）
  边界注记（I1 实现确认）：agent-map 自动重算取该档池首选（单成员注册无波内上下文）——波内多样性仍以 dispatch-plan 输出为权威；Lead 需要精确多样性时用 --model-hint 覆盖（罕见）
```

### 2.2 tw 原生工具（tw-tool.js，B-F4/F7 修正形状）

```
{
  name: "tw",
  description: "team-work CLI 桥：args 即 CLI 参数面（如 [\"deliver\",\"--task\",\"t1\",...]）",
  parameters: { type:"object", properties:{ args:{type:"array",items:{type:"string"}} }, required:["args"] },
  async execute(args, exec) {
    卡片 = await spawn(process.execPath, [twBin(), ...args.args], { cwd: projectRoot(exec) })
    return 卡片                                   // JSON 对象（exit≠0 时含 code/message/fix）
  },
  output: {
    schema: { type:"object" },                    // 卡片宽松 schema（必填段）
    render: (_args, card) => JSON.stringify(card, null, 2)   // 模型可见文本
  }
}
```
- twBin()：config.twBin → require.resolve("team-work-runtime/bin/tw.mjs")（peerDep）→ PATH "tw"；
- projectRoot(exec)：config.projectRoot → exec.agent.session.header.cwd → process.cwd()；
- 派单 PATH 注入不退役（A-F3：runtime twCommand 维持 TW_CMD>bin 绝对路径>"tw" 现状，standalone 不回归）；skill 注明插件环境下成员可走原生 tw 工具，两条指令等价。

### 2.3 skill 注册（B-F5 形状钉死）

构建期把 skills/team-work-v3 全树拷入 dist/skill/；运行期 `ctx.skills.register({ name:"team-work", description:<SKILL.md frontmatter>, source:"team-work-runtime-dsh", content:<SKILL.md 全文>, resourceBase:{kind:"directory", path: dist/skill/references} })`。目录保留 v3 版本标识，注册名统一为 team-work；与 tw init 文件通道同源同版本（F7 防漂移：构建期同一次拷贝）。

## 3. client 徽标（src-client/badge.js → dist/client.js 工厂式 bundle，B-F6）

用户调研骨架 + 装载事实修正：构建产物为 `window.__ModuleLoader__.load({id, factory})` CJS（factory 返回 {apply, inject}）；apply 内向 `conversation.input.right` 追加徽标（order 20、仅 addressed 子代理渲染），不替换父会话的原生模型选择器。显示值优先读取会话中已经实际发出的最新 `requestConfig`，并在挂载/运行状态切换时以 `sessions.models` RPC 兜底；RPC 按 `{result:{ok,value}}` 解包，失败静默。构建用 esbuild（devDependency，仅构建期）。

## 4. skill 注入规范补强（写边界）

owner 派单可写路径清单后追加："可写范围外的修改会被 deliver 拒绝并可在恢复轮回滚（快照恢复）；不要尝试绕过"。skill 成员纪律同步引用。

## 5. 实施路径（以压轴 E2E 全功能验证通过为完成目标；每段独立可验证+自审记录，三处交叉审查）

**功能验收矩阵（E2E 必须覆盖的全功能面，来自用户要求）**：

| # | 功能 | 验证层 | 手段 |
| --- | --- | --- | --- |
| F-1 | 安装（profile 装载/插件挂载） | E2E | profile 手动装配 → dsh 会话内插件 apply 无错 |
| F-2 | 安装后生效（skill 注册+tw 工具在场） | E2E | 成员会话枚举 skills 含 team-work；工具面含 tw |
| F-3 | 默认配置（零配置开箱） | E2E | 不写 dsh.json/config → 注入降级继承默认，徽标显示默认模型，任务全流程可走 |
| F-4 | 自定义配置生效 | E2E | dsh.json 候选池 + config.projectRoot → 注入按池选择（多样性/家族去重可观察） |
| F-5 | 插件注入生效（指定派发） | E2E | 真实请求记录的 requestConfig = modelHint 的 provider/model/effort（addressed 子代理的 sessions.models 不作为必需证据） |
| F-6 | 数据隔离（多任务并发） | E2E | 两任务同进程并发派发 → 各 childId 注入各自 modelHint，无串台 |
| F-7 | effort 链路 | E2E | F-5 断言含 reasoningEffort 字段（若平台 header 不落，如实记录边界） |
| F-8 | tw 原生工具 | E2E | 成员经工具调 deliver/review（args 透传）卡片返回 |
| F-9 | 升档审批卡 | E2E | 八视角流程中 expert 视角包触发 → decide → 按批派发 |
| F-10 | 八视角全流程 | E2E | 视角包并行 → consolidation → 裁决 → 门 |
| F-11 | e2eTemplate 物化 | 单测已覆盖 | 压轴任务选 e2e 场景顺路复验 |
| F-12 | 徽标（client） | 自动行为测试 + E2E 人工确认 | addressed 子代理会话显示最新真实请求的 provider/model · 推理等级；RPC 拒绝仍可显示，UI 人工过目一次 |

**六段增量（I1→I6），段内自审、段间复核、I2/I4/I6 交叉审查**：

- **I1 runtime 基座**：modelHint 决策函数提取为纯函数导出 + agent-map 自动落盘（--model-hint 覆盖）+ 单测（自动/覆盖/无映射降级/并发写）。
  自审：P4 合规复查（零手动转录）；复核：84 基线全绿 + 新增测试清单核对 F-4/F-5 的数据前提。
- **I2 插件骨架（host）**：验证脚本（profile 装配最小插件）→ index/inject/tw-tool/skill-embed + inject 寻址纯函数单测（childId 查表/三级降级链/header.cwd 兜底）。
  自审：§0 API 形状逐条对照；**交叉审查 ①**（技术向：API 用法/降级链/错误处理）。
- **I3 构建与打包**：build.mjs（esbuild client bundle + skill 构建期拷贝 + npm pack 双向断言固化）+ 打包单测。
  自审：断言清单 = 设计清单逐项核对（防漏防多）；复核：npm pack 双包 dry-run 输出审读。
- **I4 client 徽标**：badge 源码 + bundle 构建装载验证（profile 挂载后 web 会话可见）。
  自审：仅 addressed 渲染/RPC 失败静默；**交叉审查 ②**（装载链/边界：非 web 平台、离线子代理、RPC 失败路径）。
- **I5 集成自证（本地）**：本地 profile 全装配（host+client+runtime 包）→ 冒烟：单任务注入生效（F-5 手动版）+ tw 工具调用（F-8）。
  自审：冒烟脚本可重复执行（固化为 scripts/e2e-smoke.mjs）；复核：F-1/F-2/F-3 手动勾选。
- **I6 压轴 E2E（全功能）**：分层覆盖——自动层（node:test：E2E-A cordis 装载 / E2E-B runtime 全功能 / C1 实机 boot 链 + 隔离 web 实例启动）覆盖 F-1..F-4、F-6、F-8..F-11，并覆盖 F-12 的徽标行为；**F-5/F-7（真实 LLM 注入/effort header）及 F-12 的最终 UI 位置/样式需带凭据真实会话，归用户实机确认**（插件 README 实机验证节；注入链的纯函数与真文件层已自动验证）。
  **交叉审查 ③**（验收向：矩阵逐项覆盖核对/断言强度/失败路径是否真断言而非走过场）→ 修复 → 复跑至全绿 → 用户验收。

**完成定义**：自动层全绿（E2E-A/B/C1 + 当前全量 116 测试）+ F-5/F-7 及 F-12 的 UI 位置/样式如实标注待用户实机（README 指引）+ 交叉审查③ findings 清零 + 文档同步（roadmap/AGENTS/charter/file-inventory/README/验收快照）。

## 6. 风险与缓解（v2 更新）

| 风险 | 缓解 |
| --- | --- |
| effort 是否进 request header.config（llm prepareCall 行为） | 压轴 E2E 实证（B-F6）；不进也无损——注入仍生效于运行时选择，徽标显示 current |
| 子包 npm 发布流程生疏 | 先 npm pack 本地验证 + 双向断言；正式发布用户把关 |
| client bundle 装载细节 | 验证脚本第 1 步顺带验证（最小 echo badge） |
| dsh plugin add 命令本体未在源码定位（B-F9） | profile 手动装配为开发/验证路径；发布后以真实命令重验 |

## 7. 明确不做

写边界平台 hook；preset 目录形态；插件内嵌 runtime 逻辑；选模数据采集；Phase 2 投影。twCommand 不改（standalone 兜底保留）。

---

## 评审处置记录（16 findings：A 7 + B 9，全收）

| Finding | severity | 处置 |
| --- | --- | --- |
| B-F1 注入时序证伪（contribution 早于 prompt） | blocker | §2.1 寻址改 childId 主键（childCtx.agent.id 直查 modelHints）——seed/文本解析全删 |
| B-F4 tools.register 缺 output/字段名错 | blocker | §2.2 补 output{schema,render}，inputSchema→parameters |
| A-F1 model-hint 手动转录违 P4 | major | agent-map 自动落盘（复用 dispatch-plan 决策函数），--model-hint 仅覆盖 |
| A-F2 task-root 解析不成立 | major | §2.1 config.projectRoot → header.cwd 兜底（seed 解析已随 B-F1 删除） |
| A-F3 twCommand 退役致 standalone 回归 | major | 不退役（维持现状），skill 注明双指令等价 |
| B-F6 badge 不能 .jsx 直载 | major | §3 构建工厂式 CJS bundle（esbuild） |
| B-F7 execute 返回需 schema 校验+render | major | §2.2 output 段补齐（与 B-F4 合并处置） |
| B-F2 seedLength 语义错位 | minor | 随 B-F1 消解（不再 slice） |
| B-F3 selection 双字段 | minor | §0 事实表 + §2.1 注明 assembled 自动填充 |
| B-F5 skills.register 形状 | minor | §2.3 钉死（description/content 必填 + resourceBase directory） |
| B-F8 打包断言可行 | minor | 已实证，固化 build.mjs |
| B-F9 profile 装载可行 | minor | 验证脚本路径确认 |
| A-F4 E2E 徽标断言不可执行 | minor | 改 sessions.models RPC 断言（§5.7） |
| A-F5 skill 运行期读取不成立 | minor | 构建期拷贝入 dist/skill/ |
| A-F6 插件脱敏 | minor | README/config 示例脱敏（公开模型名可） |
| A-F7 skill 双通道漂移 | minor | 构建期同源拷贝 + README 注明 |

## 自复核记录（v2 增量）

1. 两 blocker 的修法是否引入新问题？childId 主键：agent-map 在 Lead 拿到 subagentId 后调用；~~时序天然满足（注册在 spawn 后）~~**【2026-08-25 实机证伪修正】**：fresh 子代的 startContinuable 返回 ID 前首条 prompt 已被接受——agents.json 写入晚于首 turn，childId 注入【fresh 首轮必不生效】（首轮默认模型，自循环补读命中后下轮生效；cold-resume 已有 hint 则同步首读供当前请求使用）。此判断是纸面时序推演，未验完整链路；modelHints 以 childId 键，同 childId 重派（降级重开+重新 agent-map）自然覆盖 ✓；
2. A-F1 自动化与 dispatch-plan 决策函数复用：需把 cli.mjs 内联的 modelHint 计算提取为可导出纯函数（实施第 2 步隐含，已写明"复用"）✓；
3. 双评审冲突检查：A-F1（自动化）与 B-F1（childId 键）正交无冲突，合并后互为补全 ✓；
4. v1 盲区自查：§0"全部已验证"的过度声明已修正为逐条依据；时序假设只验了"seed 先落"没验"contribution 何时执行"——教训：时序类事实必须验完整链路而非单点 ✓。
