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
另注：若同一 profile 还装有私有 registry 来源的包，remove 会清空包存储，重装时需带该 registry 标志（`--registry <来源>`）才能重新解析私有依赖。

**方式三：仓库目录 symlink（开发期改动即时生效，免 pnpm）**
```bash
node scripts/install-local.mjs                # symlink 指向 packages/dsh-plugin，build 后即时生效
node scripts/uninstall-local.mjs              # 卸载
```

**方式四：npm 正式发布后**
```bash
dsh plugin add team-work-runtime-dsh
```

生效：插件的 bundle patch 是纯 insert 行——装有 ntes-dsh-market 的环境安装/启用时**可热挂载即时生效**（市场界面显示 live）；否则**重启 dsh 会话**后由 bundle 层生效。
验证：`dsh --profile web --dump-config 2>/dev/null | grep "name: team-work-runtime-dsh"`（stdout 装配树命中 name 行即装载成功；**勿合并 stderr**——patch 未生效时 loader 的 "entry not found" warn 恰好也含插件名，曾造成误判）。

## 配置（可选）

```yaml
# 插件 config（通常零配置——默认从项目目录自动发现）
projectRoot: /path/to/project   # 多项目/非标准布局时显式指定
twBin: /path/to/bin/tw.mjs      # tw 入口（默认解析 peerDependencies 的 team-work-runtime）
skillDir: /path/to/skill        # 覆盖内嵌 skill 目录
```

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
