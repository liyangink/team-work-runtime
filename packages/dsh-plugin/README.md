# team-work-runtime-dsh

team-work-runtime 的 DSH 平台绑定插件。

## 功能

- **成员模型/effort 注入**：continuable 子代理（后台 subagent）创建/恢复时，按 `.team-work/platform/agents.json` 的 modelHints（`tw agent-map` 自动落盘）注入 provider/model/reasoningEffort——tier→模型映射直达团队成员；
- **skill 注册**：team-work-v3 判断指引内嵌（与 `tw init` 文件通道同源同版本，后者为无插件环境兜底）；
- **tw 原生工具**：成员直接调用 `tw` 工具（args 透传 CLI），无需 PATH；
- **模型席位徽标**：子代理会话显示实际执行的 provider/model · 推理等级（注入效果肉眼可核）。

## 安装（四种方式，前两种推荐）

> **--profile 是什么**：profile 是 dsh 的插件组合配置（`~/.dsh/profiles/<名字>/`），每个 profile 独立装载自己的插件——`--profile web` 意为"装进 web 这套启动形态"，**不是"仅 web 能用"**。本机只有 web（GUI）一个 profile 时它就是你正在用的会话形态；将来建了 headless/tui 等 profile 想用本插件，同一命令换 profile 名各装一份即可。插件包平台无关：host 侧三件功能（注入/skill/tw 工具）任何 profile 可装；徽标是 web 界面专用（`dsh.client.platform: "web"` 声明），装到其他 profile 不报错、仅徽标不出现。

**方式一：压缩包 + dsh plugin add（免发布，pnpm ≥9 在 PATH）——分发/试用首选**
```bash
# 仓库内打包（或从发布渠道获取 .tgz）
node packages/dsh-plugin/build.mjs && (cd packages/dsh-plugin && npm pack --ignore-scripts)
# 安装（dsh 自动完成 pnpm 安装 + 写依赖与 bundles 条目）
dsh plugin --profile web add /绝对路径/team-work-runtime-dsh-x.y.z.tgz
# 卸载
dsh plugin --profile web remove team-work-runtime-dsh
```

**方式二：仓库目录 + dsh plugin add（开发期）**
```bash
node packages/dsh-plugin/build.mjs   # 先构建 dist
dsh plugin --profile web add /绝对路径/team-work-runtime/packages/dsh-plugin
```
注：pnpm 11 对目录参数落的是 `link:` 依赖（node_modules 内符号链接到源目录）——build 后改动即时生效，**无需重新 add**（早先"目录=拷贝"的记录是旧版 pnpm 行为；tgz 通道才是拷贝语义，升级需重新 add）。
另注（与私有 registry 包同 profile 混装时，实测两坑）：
1. **scope 解析**：同装的私有包若是裸包名（无 @scope 前缀），scoped registry 覆盖不到它——需在 `<profile>/.npmrc` 写 `registry=<私有源>`（前提：该源镜像公网包，否则其余依赖全 404）；仅影响该 profile 目录。
2. **release-age 拦截**：pnpm 11 供应链策略拒绝发布未满冷却期（默认约 1 天）的依赖版本。与刚发布的私有包同装时，在子命令前加一次性参数绕过：`dsh plugin --profile <名> --config.minimumReleaseAge=0 add <包>`（仅该条命令生效）。
3. **勿用裸 pnpm add**：`pnpm add` 只写 dependencies 不写 `dsh.profile.bundles`（装载层清单），装完不装载且无报错；必须走 `dsh plugin add`（跑完 pnpm 后 reconcile bundles 条目）。

**方式三：仓库目录 symlink（开发期改动即时生效，免 pnpm）**
```bash
node scripts/install-local.mjs                # symlink 指向 packages/dsh-plugin，build 后即时生效
node scripts/uninstall-local.mjs              # 卸载
```

**方式四：git 源码仓库（市场通道）**
```bash
dsh plugin --profile web add github:<owner>/team-work-runtime
```
**根 package.json 即插件包**（市场按根清单构建安装）：根清单声明 `dsh.bundle`，入口指向 `packages/dsh-plugin/src/`（免构建），根 `cordis.patch.yml` 按**安装包名 `team-work-runtime`** 插入 entry。装的是根包=插件与 runtime 一体（`tw` 自带，无 peer 解析）。注意：本通道与方式一/二（插件单包 `team-work-runtime-dsh`）是**两个安装身份，二选一**——同装会产生重复 entry id 被宿主拒绝。未来多平台绑定基于根清单拓展映射。

**方式五：npm 正式发布后**
```bash
dsh plugin add team-work-runtime-dsh
```

生效：安装后**重启 dsh 会话**，由 bundle 层装载（插件的 bundle patch 是纯 insert 行，支持热挂载的宿主环境可免重启即时生效）。
验证：`dsh --profile web --dump-config 2>/dev/null | grep "name: team-work-runtime-dsh"`（stdout 装配树命中 name 行即装载成功；**勿合并 stderr**——patch 未生效时 loader 的 "entry not found" warn 恰好也含插件名，曾造成误判）。

## 配置（全局 settings.yaml）

插件配置已全局化：经宿主 settings 服务（`@deepseek-ai/dsh-settings`）写入 `$DSH_HOME/settings.yaml` 并热生效，无需写插件 config。namespace 为 `team-work-dsh`。

```yaml
# $DSH_HOME/settings.yaml
team-work-dsh:
  # projectRoots：项目根数组，每项一个项目；path 为绝对路径，命中决定注入寻址与 tw 工作目录
  projectRoots:
    - path: /path/to/project-a        # 项目 A 根目录
      # twBin: /path/to/bin/tw.mjs     # 该项目专属 tw 入口（可选，覆盖全局 twBin）
      # injectionEnabled: true         # 该项目是否启用模型注入（可选，默认 true）
    - path: /path/to/project-a/sub     # 可嵌套——cwd 落在多级前缀时取最长前缀命中项
  twBin: /path/to/bin/tw.mjs           # 全局 tw 入口（默认解析 peerDependencies 的 team-work-runtime，再兜底 PATH 的 tw）
  injectionEnabled: true               # 全局注入开关（false 则不注入；消费时刻判定，热生效）
```

- **多项目最长前缀匹配**：子代理的 `cwd` 同时命中多个 `projectRoots[].path` 前缀时，取 path 最长（最深）的那一项，作为该项目的工作目录与 twBin 覆盖来源；无任何前缀命中时不启用项目级覆盖（退回全局 `twBin` 与默认工作目录）。
- **覆盖链（twBin）**：命中项 `twBin` > 全局 `twBin` > `require.resolve('team-work-runtime/bin/tw.mjs')` > PATH 的 `tw`。
- **降级行为**：宿主无 settings 服务（import 失败）时静默跳过区段注册，插件以 entry config 初值照常装载，其余功能不受影响。
- **热生效**：区段注册后注入与 tw 工具在每次子代理创建、每次工具调用时按最新 settings 快照读配置——injectionEnabled / projectRoots / twBin 改动无需重启即生效。entry 仅作初值（base 层）与无服务时的回退。
- **契约要点**：setSource 收到的是「返回当前值的 thunk」（非值），读取方每次现调 source() 取新快照；schema 必须是 schemastery z.object(...) 可调用对象（服务端执行 schema(mergeLayers(base, section))，裸对象会抛 TypeError），故本实现动态 import @deepseek-ai/schemastery 构造真 schema，任一动态 import 失败则整段不注册。
- **开关语义**：injectionEnabled: false 不注销 setup，而是在子代理创建时刻跳过注入（消费时刻判定），关闭/重开均即时生效。twBin 缺省回退到 peer 依赖解析与 PATH；projectRoots 缺省为空数组（不启用项目级覆盖）。matchProjectRoot 统一补尾斜杠做前缀比较，/a/b 不误命中 /a/bc。
- **项目级配置已移除**：原先插件 config 的 `projectRoot` / `twBin` / `injectionEnabled` 不再从项目 config 读取，统一由全局 settings.yaml 承载；`skillDir` 仍属构建项，暂不在 settings 区段暴露。

模型映射数据在项目侧 `.team-work/platform/dsh.json`（档位候选数组，参考主包 README；示例用公开模型名如 deepseek-v4-flash / glm-5.3）。

## 实机验证（安装后确认注入生效）

1. 安装后重启 dsh 会话；开一个后台 subagent 任务（`tw agent-map --task <名> --key <派单key> --agent <subagentId>` 已登记 modelHints 的）；
2. **注入确认**：子代理会话的模型席位显示注入的 provider/model（而非主会话默认）即注入生效——这也覆盖徽标功能确认；
3. **effort 确认**：dsh.json 该档候选带 effort 字段时，席位显示"· 推理 <档位>"；若平台 request header 不落 effort（已知边界），注入仍生效于运行时选择；
4. 多任务并发时各子代理各显示各自注入（隔离确认）。

## 边界

- 注入仅覆盖 continuable 子代理（workflow 一次性子代不可达——恰为只读廉价扇出场景）；
- 注入失败逐级静默降级为继承默认模型（不阻塞任务）；
- 徽标仅在线子代理会话显示。