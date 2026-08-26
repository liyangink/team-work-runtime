# 派单引导库（guidance）

Runtime 生成派单时按「角色 + 场景」自动注入公共引导，让成员开工前拿到执行纪律与专业要求。引导只做增强：不改变派单边界、可写范围与检查规则，与派单正文冲突时以派单正文为准。

## 检索层级

- 角色引导：`team-work/guidance/roles/<role>.md`，键 = 派单角色（owner | challenger | expert）。注入所有对应角色的派单（含续派与在途重建）。
- 场景引导：`team-work/guidance/scenes/<sceneId>.md`，键 = 阶段声明的 `teamScene`（如 implementation、test）。注入该场景阶段的所有派单——Owner 按此执行，Challenger/Expert 按同样标准审视。
- 缺失的目录/文件静默跳过，不阻塞派发；引导文本是数据不是代码，不参与门禁判定。

## 分层覆盖

包内默认引导为基线；项目根 `team-work/guidance/` 下的同名文件逐文件覆盖，项目只需放置要自定义的条目，其余保留基线。

## 扩展方式

- 修订某角色/场景的引导：直接编辑对应 md 文件，下次派发生效。
- 新增场景引导：在 `scenes/` 下新建与 `teamScene` 同名的 md 文件。
- 新增角色引导：在 `roles/` 下新建与派单角色同名的 md 文件。
- 引导文本用中文、通用、脱敏：不引用特定项目、账号或环境信息；公开的技术概念（如 JUnit 的 @DisplayName）可以借用。
