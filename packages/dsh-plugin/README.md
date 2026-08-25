# team-work-runtime-dsh

team-work-runtime 的 DSH 平台绑定插件。

## 功能

- **成员模型/effort 注入**：continuable 子代理（后台 subagent）创建/恢复时，按 `.team-work/platform/agents.json` 的 modelHints（`tw agent-map` 自动落盘）注入 provider/model/reasoningEffort。恢复时已有 hint 会在当前请求前同步生效；新建子代因 ID 在首条 prompt 后才返回，首轮继承默认模型，agent-map 落盘并被补读命中后的下一请求生效；
- **skill 注册**：team-work 判断指引内嵌（与 `tw init` 文件通道同源同版本，后者为无插件环境兜底）；
- **tw 原生工具**：成员直接调用 `tw` 工具（args 透传 CLI），无需 PATH；
- **模型席位徽标**：子代理会话在原生模型选择器旁显示实际执行的 provider/model · 推理等级（优先依据真实请求记录，注入效果肉眼可核）。

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

## 配置（DSH Web 的插件配置页）

启动 DSH Web 后，在“插件配置”页打开 **team-work-dsh**。配置经宿主 settings 服务写入 `$DSH_HOME/settings.yaml`，namespace 为 `team-work-dsh`，保存后会热更新。

首次安装时允许保持空配置（unresolved），以便先打开配置卡。开始保存时，`junior`、`senior`、`expert` 三档必须同时完整；每行都要求非空的 `provider` 与 `model`，`effort` 可省略。

```yaml
team-work-dsh:
  tiers:
    junior:
      - provider: <provider-id>
        model: <model-id>
        effort: <optional-effort-id>
        family: <optional-model-family>
    senior:
      - provider: <provider-id>
        model: <model-id>
    expert:
      - provider: <provider-id>
        model: <model-id>
```

- **档位说明**：junior 用于低成本探索与常规辅助；senior 用于常规实现与复核；expert 用于核心场景与技术裁决。
- **候选池兼容**：每档可读取旧的单个候选对象，也可使用候选数组。Web 卡片统一按“候选行”编辑，下一次保存会写为数组。已有的 `family` 会保留；未填写时由运行时推导，不强制暴露为 UI 字段。
- **目录校验**：卡片读取 `llm.providers` 与 `llm.models`。Provider 与模型均为必填，且 Provider 必须已列出并处于 active。保存前，每个候选 Provider 都必须拥有读取成功的模型目录，且所选模型必须实际列在其中；模型 RPC 整体失败、候选 Provider 的目录失败、缺少该 Provider 目录或模型未列出时，卡片都会阻止保存。模型公开且列出非空 reasoning effort 选项时，填写的 effort 必须属于其选项；没有该元数据时 effort 仍可省略。
- **失败与恢复**：Provider 列表、模型目录或 settings 只读、保存异常都会在卡片中显示。恢复对应服务，或从可验证目录中选择模型后可直接重试；不会清空最后一个有效配置。
- **旧键迁移**：`injectionEnabled`、`projectRoots`、`twBin` 已完全失效，不再由 schema、运行入口、注入链或工具链读取。注册 helper 没有安全的迁移写入句柄，因此插件不会自动改写用户的 settings 文档；如旧键仍留在原始文件中，可在确认后手动删除。
- **工作目录**：模型注入与 `tw` 工具只使用当前子会话的 cwd；没有 cwd 时返回可诊断的 unresolved 卡片，而不会猜测或跨项目寻找目录。

`team-work-dsh.tiers` 是 tier→模型的唯一配置源：每档兼容单个候选对象或数组，运行时按候选顺序并在同波优先不同 family 选择，`effort` 可选。项目 `.team-work/platform/dsh.json` 已完全不再读取或创建；遗留文件不影响运行，可由用户手动删除。项目 `.team-work/platform/agents.json` 仍是运行时事实，保存 dispatchKey→childId 映射和已派发的 modelHint 快照。

## 实机验证（安装后确认注入生效）

1. 安装后重启 dsh 会话；开一个后台 subagent 任务（`tw agent-map --task <名> --key <派单key> --agent <subagentId>` 已登记 modelHints 的）；
2. **注入确认**：子代理会话的原生模型选择器旁显示注入的 provider/model（而非主会话默认）即注入生效——这也覆盖徽标功能确认；
3. **effort 确认**：在 DSH Web“插件配置”页的 `team-work-dsh.tiers` 候选填写 effort 后，席位显示“· 推理 <档位>”；若平台 request header 不落 effort（已知边界），注入仍生效于运行时选择；
4. 多任务并发时各子代理各显示各自注入（隔离确认）。

## 边界

- 注入仅覆盖 continuable 子代理（workflow 一次性子代不可达——恰为只读廉价扇出场景）；
- 注入失败逐级降级为继承默认模型（不阻塞任务），同时在宿主日志记录原因、重试状态与恢复指引；
- 徽标仅在线子代理会话显示。
