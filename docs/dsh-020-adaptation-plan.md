# DSH 0.2.0-rc.2 适配方案

状态：适配版本 `1.0.9`，适配、统一自动验证、诊断返工验证与独立代码复核已完成。用户已授权提交、推送和本地打包安装；市场发布不在本次范围。真实 LLM、跨进程续聊与最终页面视觉待用户验收。

本次下线 `tw-tool-subagent`，普通委派统一使用 DSH 原生工具；`tw-dispatch` 保留工作流推进、模型选择、防重复创建和续聊登记。同步适配新版插件配置与会话持久化接口，不改工作流、门禁和团队拓扑。

## 1 工具职责

| 使用场景 | 调用方式 | 谁负责会话登记 |
| --- | --- | --- |
| 推进 team-work 任务，派发或续派正式成员 | `tw-dispatch` | 工具自动登记 |
| 信息收集、普通委派、成员内部只读助手、用户指定模型或档位 | 原生 `subagent`；需要继承历史时用原生 `subagent_fork` | 通常不需要任务登记 |
| 主动追问已有子会话 | 原生 `send_message` | 使用已有会话 ID |
| 开任务、交付、评审、决定、查状态或补登记 | `tw` | 仅补登记时使用 `agent-map` |

删除旧工具的注册、参数定义和引导，不保留同名别名。工作流是否存在不是唯一判据：成员在任务期间开只读助手，仍用原生工具，不能让助手进入正式成员波次。

原生工具在可续聊的后台模式中返回 `{ kind: "continuable", subagentId }`。这个 ID 就是子会话 ID，可以立即登记或续聊，无需等子 Agent 完成。一次性后台模式的 `jobId` 和前台模式的 `runId` 不是同一种身份。插件不修改原生工具的后台模式设置，也不替用户打开选模权限。

## 2 保留档位输入，改用原生委派

`junior`、`senior`、`expert` 三档候选池继续保留。它们表达成本和能力策略，不再意味着要调用 TWR 自己的委派工具。

`@junior`、`@senior`、`@expert` 候选继续提供。选中时仍只写入可见的委派意图；提交时读取当前已保存的档位映射，把第一候选的 provider、model 和可选 effort 写成原生委派指引。档位未配置时明确说明缺什么，不暗示可以继承默认模型来满足指定档位。自然语言选档使用相同规则，通过动态系统指引或 `tw models` 获取映射。

原生调用参数叫 `reasoning_effort`，TWR 配置字段仍叫 `effort`；只有跨到原生工具时转换名称。候选池的同波模型家族分散策略仍用于正式成员派发，普通委派不新增另一套轮换算法。

原生精准选模受 DSH 的选模开关和允许模型列表约束。普通委派先查看原生 `list_subagent_models` 提供的路由；枚举目录只供参考，未列出模型不等于禁止使用。档位模型未列出时，以 provider+model 精确查询，再区分权限拒绝、解析失败与可用模型，不换成其他档位或默认模型。DSH 将选模权限保存在会话中，改变全局允许列表不意味着旧会话立即获得新权限，使用指引必须说明可能需要新建会话。

`tw-dispatch` 的模型由用户配置的 tiers 和已记录派单决定，不由 Lead 自由指定；继续由 TWR 的 tiers 管理这一通道，不把普通委派的允许列表另复制成 TWR 配置，也不自动改写该列表。两者区别在配置页说明：DSH 列表限制普通委派的自主选模，TWR tiers 配置正式团队派发策略。

## 3 插件配置改用新版原生页面

### 3.1 配置源和作用域

宿主入口导出纯声明式 `Config` schema：根为普通 object，tiers 为可热更新字段，允许空对象或完整三档对象。候选对象与候选数组、非空字符串、未知字段拒绝都用 schema 的声明式结构表达，不在表单 schema 内携带自定义函数，保证宿主投影及跨 JSON 往返后仍能读取和校验。插件每次开始操作时读取 `config.tiers.get()`，不再注册旧 settings 区段，不再读取 `settings.yaml`。

配置由 DSH 的 profile 配置编辑器保存，页面使用 `configForms.get(entryId)`。市场包名仍是 `team-work-runtime`，配置 entry ID 保持 `team-work-dsh`，避免无必要地改变迁移目标。

已批准的作用域变化：旧配置是 DSH home 下的一份文件，新版原生表单写入当前 profile。同一 profile 内所有项目共用一份 tiers，不保留项目覆盖，不自行同步多个 profile。DSH 有应用于多个 profile 的 home patch，但原生表单写入当前 profile 的行为不等于跨 profile 共享；本次不伪称仍是全机唯一配置。

空 tiers 是首次安装的未配置状态，不阻塞宿主启动；需要选模的派发明确返回 unresolved 和配置入口。开始配置后，三档必须齐全；兼容单候选对象和候选数组，provider/model 必填，effort/family 可选。不恢复已废弃的 `injectionEnabled`、`projectRoots`、`twBin` 或项目 `dsh.json`。

### 3.2 页面和校验

删除 `settingsScope`、`settings.plugin.item` 和旧卡片外壳。配置内容接入 `plugins.bundle.config`，由 DSH 提供插件页面和标题；需要行摘要时使用 `plugins.row.config`。自定义 tiers 编辑器通过新版 `settings.configure({ auto: false })` 关闭该 entry 的重复自动表单，只保留一份配置页面。Config schema 和原生 profile 配置编辑能力始终保留，关闭自动页面不等于删除配置；不承诺没有客户端时自动切回另一套 UI。只保留 tiers 编辑内容，不再画一套与原生页面竞争的插件折叠按钮。字段字体、按钮尺寸、间距、明暗主题沿用宿主现有控件或样式，并以原生插件页面作视觉对照。

保留三档说明、候选增删、provider/model 联动选择和可选 effort。保存前检查 provider 是否可用，并按已读取的模型目录核验候选与 effort；目录无法读取时不谎报配置有效。未广告模型不等于不存在或不允许；新版客户端没有精确只读校验 RPC，此时保留草稿并提示通过原生 `list_subagent_models` 按 provider+model 精确查询，不冒充已完成校验。宿主 schema 检查结构完整性，正式成员创建前再用 `llm.resolveCallConfig` 核验实际可用性，覆盖保存后 provider 停用或模型变化的情况。

整份 tiers 一次提交，绑定编辑开始时的 revision。保存失败或其他页面先修改了配置时，保留本地草稿并提示重新核对，不覆盖新配置；读回宿主确认后才显示成功。三档变更只影响之后生成的派单，已有派单沿用 journal 中的精确模型快照。

客户端按服务在场情况分别注册配置内容、`@` 候选和模型徽标；缺少可选 UI 服务只影响对应功能，不让整个客户端等待已删除的服务。注册与订阅都随插件释放。

### 3.3 旧配置处理

DSH 自带迁移会将旧 `settings.yaml` 改名为 `settings.yaml.imported`，再尝试把区段写入对应 entry。该首次导入没有“目标为空才导入”的保护，旧 tiers 可能覆盖当前 profile 的同名配置；升级前应备份两份配置，并测试新旧配置同时存在的情况。保持 `team-work-dsh` ID 和兼容 tiers 形状，使尚未迁移的配置可以接受宿主迁移，并测试这一流程。

已经改名但导入失败的文件不会被 DSH 自动再次导入。提供明确恢复说明：从旧文件只取 tiers，核对模型后通过新页面保存。不后台偷偷重导，不用旧文件兜底，不覆盖当前 profile 已保存的配置，也不删除用户旧文件。

## 4 打通插件配置与 tw 子进程

旧版 `tw-dispatch` 通过子进程执行 CLI，而 CLI 自己读旧 YAML；本次将页面与子进程读取链一并切换。

宿主在一次操作开始时取 tiers 快照连同来源传给子进程，格式为 `TW_DSH_CONFIG` JSON `{tiers,entryId:"team-work-dsh",profile:<宿主来源或 unresolved>}`，不传 provider 密钥；`tw` 和 `tw-dispatch` 采用同一方式，操作中的子进程共用这一快照。这个变量是本次调用输入，不落盘、不构成第二份权威配置；配置更新后，下次操作重新取快照。解析来源统一为 `dsh-plugin-config`，输出实际 entryId/profile，不伪造配置文件路径。

`runtime-v3/dsh-map.mjs` 保留候选规范化、家族分散和模型选择，删除旧 settings 文件定位、专用 YAML 解析和 `DSH_SETTINGS` 回退。`tw models` 与派发卡展示实际 entry/profile 来源，不再显示不存在的全局 YAML。损坏输入、缺档和缺快照均明确 unresolved，不猜测默认值。

无宿主的终端不能凭当前目录推断使用哪个 DSH profile。本次采用显式配置快照输入：终端编排调用方通过相同 JSON 输入传入 tiers，缺失时选模相关命令提示配置来源未提供；开任务、交付、评审、查状态等平台无关命令仍正常使用。文档提供脱敏的输入格式，不生成长期缓存，不要求模型转录配置。

已批准的第二个使用变化：无插件终端不再自动读 home 的旧 YAML。若要求终端自动读取新版配置，应另外指定 profile，并使用 DSH 的配置组合能力；本次不增加默认 profile、扫描猜测或多层 patch 解析。脱敏输入示例见 [README](../README.md#无宿主的终端输入)。

## 5 tw-dispatch 的创建与恢复

### 5.1 保存创建能力，不保存旧工具

从 `dsh/tw-tool-subagent.js` 提取工作流真正需要的创建、会话检查和续聊函数，放到同一平台层的内部文件 `dsh/subagent-session.js`。这是既有 PlatformBinding 的文件整理，不新增架构 Module，不暴露新工具，也不支持普通委派的 tier 参数。

新建成员仍调用原生底层 `subagents.startContinuable`，传入预生成 `childId` 和精确 `agentOptions.provider/model/reasoningEffort`。创建前验证模型与 spawn provider 的可续聊能力；effort 未配置时遵循宿主默认解析，不把“宿主返回默认 effort”当成配置不匹配。配置了 effort 时必须验证其有效性。

删除 `directSelections`、旧 setup 注册、模型安装器解析与重试、`dsh/inject.js`，不再用 hook 重写成员的请求。新版宿主已经把模型与 effort 写入可续聊描述符并用于冷恢复。保留模型徽标展示真实会话选择，不能用 tiers 的意图冒充实际请求。

### 5.2 会话 ID 与防重复创建

保留现有 ID 算法：对 `任务名 + 空字符分隔符 + dispatchKey` 做 SHA-256，取摘要组装成 UUID v4 外观的字符串。同一派单重试得到同一 ID；这是确定性 ID，不是随机 UUID。已有 `agents.json` 映射优先使用，不因升级改 ID。普通委派的随机 ID 由 DSH 原生工具生成，TWR 不介入。

顺序仍是“登记映射，再创建子会话”。登记失败时不创建；创建失败保留映射，同 ID 重试。`agents.json` 仍只保存 dispatchKey 到 childId 的 mappings，不引入平行任务状态。新 key 可以登记到已有成员会话以续派；标签只用于展示。

创建成功后继续通过 `sessions.flush(childSession)` 确认持久化。flush 抛错、返回 false（没有持久化监听器参与），或子会话快速结束导致读取不到活会话，都先归入“已创建但持久化尚未确认”，不能当成初始消息未被接收。可用 stat 确认存储可见性，但不能用存在性冒充 flush 的耐久保证。回执带已有 sessionId，保留映射，不把它谎报成“未创建”，不自动换 ID 重派或删除可能已经开始工作的会话。重试先检查同 ID 的现状。

### 5.3 新版读取和续聊接口

| 原实现 | 新实现 | 必须保持的语义 |
| --- | --- | --- |
| `listSnapshots()` 枚举后找 ID | `sessionPersistence.stat(id)` | 只查询目标 ID，检查 parentSession 归属 |
| `readRaw()` 或 `inspect()` 读会话 | `open(id, "read")`、`handle.read()` | 不抢写权，读取后在 finally 中 close |
| `header.seedLength` 截断继承历史 | `handle.inheritedEventCount` | 只判断子会话自己的事件，不把父历史算成收单 |
| 兼容旧 `followup()` | 新版 `subagents.sendMessage()` | 保持直接父子鉴权、返回 messageId 和冷唤醒 |
| 缺服务或读盘失败当成 none | 返回可恢复错误 | 未知不等于不存在，不据此重建或补投 |

活会话仍先查 `sessions.get(id)`，归属一致则等待，不重发正文；冷会话用 stat 检查存在性和归属。同父会话才允许冷唤醒；异主返回冲突及原 Lead 继续、或作废重派的指引，不尝试接管。

冷会话只检查排除继承前缀后的自身事件，并核对 `agent/inbox/spliced` 消息中是否已包含本轮增量或全量派单的精确文本：本轮已收单时只发续行提醒；只有旧工作上下文时投本轮增量；无工作上下文时投全量正文。日志结构或读取无法判定时报告不确定，不能据此声称恢复成功或自动补投。创建、等待、续派与断链恢复共用内部函数；这能识别已进入日志的本轮正文，仍不承诺接收成功到日志可见之间的中断窗口实现恰好一次投递。

新建请求的 maxDepth 通过 `subagents.resolveMaxDepth()` 取得宿主限制并传入，不硬编码 1，也不绕过宿主上限。DSH 0.2.0-rc.2 的宿主默认上限为 1；要让正式成员再开只读助手，用户需允许至少两层。配置指引说明这一条件，插件不擅自提高上限；助手不得继续委托的纪律保持不变。

防重复创建不等于消息恰好投递一次：原生 sendMessage 没有调用方幂等键，接收成功到派单进入会话日志之间仍有中断窗口。本次不承诺消灭这一窗口，不新增投递账本；回执丢失或读取不确定时明确提示已有会话 ID，不自动另建成员。若要求同一正文跨重启也绝不重复投递，需要宿主提供幂等投递能力，不能只靠换读取接口宣称实现。

## 6 文件修改范围

| 文件或范围 | 修改内容 |
| --- | --- |
| `dsh/index.js`、`dsh/settings.js` | 导出新版 Config，读取热更新 tiers；只注册 tw/tw-dispatch；更新动态工具分工与档位指引；删旧 settings 和注入装配 |
| `dsh/tw-tool-subagent.js`、`dsh/inject.js` | 工作流内部能力提取后删除，不留旧工具或旧宿主兼容分支 |
| `dsh/subagent-session.js` | 保存工作流创建、检查、持久化确认与续聊实现；限定为平台内部文件 |
| `dsh/tw-dispatch.js`、`dsh/tw-tool.js` | 接入内部会话函数与同一配置快照传输；更新错误恢复和工具说明 |
| `dsh/client/badge.js` | 新配置页、configForms 保存与冲突处理、原生委派的 @ 指引、可选服务生命周期；核验真实模型徽标 |
| `runtime-v3/dsh-map.mjs`、`runtime-v3/cli.mjs` | 切换配置输入与来源展示，删除旧 YAML 读取和旧工具恢复提示，不改变波次算法 |
| `skills/team-work-v3/`、`README.md`、`AGENTS.md` | 改工具分工、普通委派和续聊操作、配置作用域、终端输入及升级说明；AGENTS 只改被替代的平台基线 |
| `package.json`、`cordis.patch.yml` | 初次适配只声明已验证的 DSH `0.2.0-rc.2`，不沿用宽泛旧版兼容；声明直接使用的 Schemastery 依赖，删除不再直接使用的 agent peer；保持唯一市场制品和 entry ID |
| `tests/dsh-plugin*.test.mjs`、`tests/dsh-dispatch.test.mjs` | 按新版真实接口改夹具，覆盖加载、配置、派发和恢复 |
| `tests/dsh-tw-tool-subagent.test.mjs` 及标签注入旧用例 | 删除旧工具测试；有价值的创建/恢复用例迁到 `tests/dsh-subagent-session.test.mjs`，保留标签纯展示与映射隔离的有效回归 |
| `tests/runtime-v3-dsh.test.mjs`、CLI/拓扑/波次/E2E 夹具 | 从旧 YAML 切到调用级快照，确保核心回归不是靠旧读取链通过 |
| `docs/runtime-roadmap.md`、相关旧方案与验收说明、`docs/file-inventory.json` | 更新实施与验收状态；旧方案标明被替代而非继续指导调用，清单同步增删 |

不改用户正在使用的 DSH profile、不重装插件、不升级宿主、不删除配置和任务目录。方案批准后的开发测试使用隔离 profile；提交、发布和真实凭据调用另行授权。

## 7 实施顺序和验收

先完成配置源与内部会话函数，保证 tw-dispatch 在新版宿主上可创建和恢复；随后移除旧工具和注入链，切换原生普通委派引导与新配置页。最后统一清理夹具、文档和打包残留。三个步骤属于一次适配交付，不分别发布中间态，也不扩展到 roadmap 的其他功能。

| 验收范围 | 必须通过 |
| --- | --- |
| 工具边界 | 只注册 tw/tw-dispatch；所有活动引导不再要求旧工具；任务成员与成员内部助手不会混用通道 |
| 配置 | 空配置可启动；三档结构、provider/model、可选 effort 校验；保存失败、revision 冲突、热更新与旧配置迁移 |
| 配置读取 | Web 保存后 tw models 与下一波使用同一快照；已派发波次不重选；旧 YAML 不再被读；终端缺输入有明确指引 |
| 普通委派 | 精准模型和 effort 由原生工具处理；选模关闭、路由不允许、旧会话权限等场景解释准确；可续聊模式返回 ID 并能 send_message |
| 防重复创建 | 同 key 连点、重试以及登记后/创建后中断保持同 ID；DUPLICATE_CHILD 不触发另造 ID；多项部分成功不会回滚已运行成员 |
| 恢复 | 活会话等待、同父冷恢复、异主拒绝、确实不存在才同 ID 重建；stat/open/read/flush 错误、取消和 handle 释放覆盖；继承前缀不误判 |
| 续派 | 原成员修订、挑战者复审和 Expert 重裁；断链用全量上下文；正文补发与轻提示场景分别验证，不把消息级幂等列为已实现 |
| UI 与打包 | 隔离 Web 启动无 pending/without inject；新插件页与原生视觉对照；真实模型/effort 徽标正确；pack 不携带已下线实现 |

假宿主用例必须按 0.2.0-rc.2 的返回形态构造，不能通过补回 listSnapshots/readRaw/旧 setup 让测试变绿。自动测试之外，隔离宿主集成验证不用真实凭据；真实模型调用和重启续聊另列用户验收，未验证不得宣称通过。

本方案已获批准。统一自动验证由主代理在精确 `0.2.0-rc.2` 隔离宿主环境运行完成，结果如下；真实模型调用、跨进程续聊及最终页面视觉仍由用户实机验收。隔离验证阶段未修改用户实际使用的 profile 或宿主；提交、推送和本地安装已另获用户授权。

| 验证 | 结果与边界 |
| --- | --- |
| 全套 `npm test` | `1.0.9` 全套 260 项通过，0 失败、0 跳过；包含诊断修正回归，使用隔离宿主依赖，未调用真实 LLM |
| 隔离 Web | 插件运行正常，三档 ConfigForms 表单 ready；已修复 namespace guard 与 schema 跨 JSON 问题。可见页面填写三档广告候选并保存，宿主确认保存成功；仅修改临时 profile，未调用真实 LLM |
| 官方 ConfigForms 往返 | 空配置与完整三档往返通过 |
| `npm pack --dry-run` | 通过，共 44 个 entries，制品不包含已下线委派工具或注入实现；根包仍为唯一市场制品，未提高版本或发布 |
| 独立代码复核 | Spec 与 Standards 均接受；Standards 的错误诊断问题已修复并确认关闭，保留原始原因与恢复提示。修正后专项 4 项通过，主代理另核新增用例通过 |
| 用户实机 | 真实 LLM、跨进程续聊、最终页面与徽标视觉未验，不以自动测试代替 |

隔离验收服务与浏览器已停止或关闭，临时验收截图保留；用户实际运行环境未更改。

## 8 源码依据

以下均来自 npm 的 `0.2.0-rc.2` 发布源码；路径和行号是包内位置，不引用本地运行环境。方案中的拟议文件、变量和行为以上文为准，并非声称宿主已有这些实现。

| 已确认行为 | 发布源码位置 |
| --- | --- |
| 原生工具精准选模、允许列表、会话权限记录及后台返回 subagentId | `dsh-tool-subagent/lib/index.js`：79 起、252 起、495 起、525 起、589 起；`lib/model-selection-settings.js`：Config 与 current |
| 底层接受显式 childId，用 stat 判重；模型 effort 原生持久化和冷恢复；默认深度上限 1；sendMessage 接收时点与直接父子鉴权 | `dsh-subagent/lib/index.js`：436 起、1671 起、1711 起、1915 起、2822 起、2863 起、2882 起 |
| 新配置由 Config 的 volatile 字段投影并写 profile；旧 settings 文件一次性导入；自定义表单可关闭自动生成 | `dsh-settings/lib/index.js`：324 起、346 起、372 起、411 起、479 起 |
| configForms 按 entryId 获取，原子 mutate 支持 expectedRevision；新版插件配置插槽 | `dsh-client-ui-settings/lib/client.js`：1172 起、1305 起；`dsh-client-ui-plugin-manager/lib/client.js`：2390 起、2522 起 |
| stat/open/read/close 与 inheritedEventCount；sessions.flush 仍返回监听器确认 | `dsh-session-persistence/lib/types/index.d.ts`、`handle.d.ts`；`dsh-session/lib/index.js`：1832 起 |

发布包：[原生委派工具](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-subagent/v/0.2.0-rc.2)、[子代理宿主](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent/v/0.2.0-rc.2)、[插件配置](https://www.npmjs.com/package/@deepseek-ai/dsh-settings/v/0.2.0-rc.2)、[会话持久化](https://www.npmjs.com/package/@deepseek-ai/dsh-session-persistence/v/0.2.0-rc.2)。
