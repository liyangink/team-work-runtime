# CoreRuntime Interface 1.0

本契约定义 Workflow、Team-work 和 PlatformPlugin 共同使用的稳定 CLI + JSON Interface。CoreRuntime 不理解模型、成本、团队拓扑或平台原生工具。

## 1. 命令面

```text
team-work init|doctor|version|migrate
team-work task create --entry-stage <stage>
team-work task bind|show|team|spec|await|resume|complete|cancel|archive
team-work context register|list|render|rebuild
team-work flow status|check|advance|rollback --to <stage>|decide
team-work work create|start|submit|accept|rework|block|cancel
team-work event list|record
```

所有命令支持 `--project` 和 `--json`；读取任务的命令支持 `--task`、`--platform`、`--session`；写命令支持 `--expected-revision` 和 `--dry-run`。调用方只能根据 JSON 字段和退出码判断结果，不得解析人类文本。

## 2. 任务与阶段介入

`task create --entry-stage` 接受 Workflow 中任意已声明阶段。`entryStage` 保存首次介入点，`stage` 保存当前位置；历史阶段不会被伪造为已经执行，也不要求补跑。

任务创建时从 `config.yaml` 解析 Workflow，并把 `id/version/path/digest` 固定到 task。被任务引用的 Workflow 版本必须保留；加载时 digest 不匹配即返回 `STATE_CORRUPT`，禁止悄悄使用新配置。SPEC 的 `type/skill/root` 只存在于 Project Config；task 只保存执行状态、产物引用和配置 digest，不复制路由。

`task team --mode <solo|team> --reason <reason>` 持久化当前阶段的组团决策。每次阶段推进或回退后重置为 `undecided`，避免沿用上一阶段的成本判断。`task spec --status <in-progress|completed|blocked|disabled> [--artifacts <paths>]` 只更新任务内 SPEC 执行状态与制品引用，不修改 Project Config 路由；`completed` 至少需要一个已存在制品。SPEC 返工可从 `completed|blocked|disabled` 回到 `in-progress`。

阶段门禁只检查当前阶段声明的最低必需输入。历史需求、设计、SPEC、测试和 Review 制品只有在当前阶段的 `requiredInputs` 中出现时才阻塞；其他缺失只产生 warning。默认工程 Workflow 中，`code-review` 只要求：

- 至少一个 `source`；
- 至少一个 `review-scope`。

因此只有代码和明确审查范围时即可从 `code-review` 创建任务。设计、SPEC 和测试结果可作为补充上下文，但默认不是该阶段硬门禁。

## 3. 状态与流转

Task 业务状态为：

```text
active | awaiting-user | completed | cancelled
```

合法生命周期：`active -> awaiting-user|completed|cancelled`，`awaiting-user -> active|cancelled`；completed/cancelled 为终态。`task await` 写入待用户决策，`task resume` 恢复 active。awaiting-user 仍参与活动任务解析；终态禁止新增 flow/work 写入。完成必须处于当前 Workflow 的 terminal stage；work-items document 及其每个 item 必须属于当前 task、阶段属于固定 Workflow，所有非 cancelled item 已带有效证据 accepted，并写入同样引用有效证据的任务级 acceptance。

`task complete|cancel|archive` 语义不同：complete/cancel 改变业务状态，archive 只移动已结束任务的存储位置，不能代替完成或取消。

`flow advance --outcome <pass|rework|fail>` 只能走 Workflow 明确声明的边。Workflow 以 stages 数组定义规范顺序；`flow rollback --to` 只能从 active task 回到顺序更早的阶段，必须提供 reason 和 evidence。回退事务将目标阶段之后的 gate 重置为 pending，并把相关 evidence 标记为 invalidated，记录 revision 与原因。不存在的阶段、向前“回退”、终态任务或缺少理由/证据都必须拒绝。

`flow check` 保持只读，返回：

- 当前阶段已满足和缺失的必需输入；
- 未验收 work item；
- 确定性、语义和人工门禁决策及证据；
- warning、blocker 和最小修复动作。

语义/人工门禁由 Lead 或用户通过 `flow decide` 写入结论。CoreRuntime 只校验决策、理由和证据是否完整，不生成语义结论。override 必须保留原 blocker 与原因，不能形成无法人工恢复的死门。

task.json 中的 gates 与 evidence 是门禁、override 和 rollback 恢复的权威状态；events 只做审计。每个 overridden gate 必须同时保留 blocker、decision、decidedBy、reason 和 evidenceRefs。当前阶段之后的 gate 只能保持 pending，未来阶段 evidence 只能以 invalidated 状态保留回滚审计，禁止预写可用结论。

## 4. Work item 与策略返回

Work item 只表达 Owner、阶段、范围、完成条件、产物、依赖、attempt 和验收状态。成本档位、挑战者、团队拓扑和三轮收敛属于 Team-work Policy，不进入 Runtime schema。

`work-items.json` 使用带 taskId/revision 的 document envelope，而不是裸数组；workItemId 必须唯一，依赖必须引用同一 document 中的既有 ID，禁止自依赖。

合法生命周期：`queued -> running|cancelled`，`running -> submitted|blocked|cancelled`，`submitted -> accepted|rework`，`rework|blocked -> running|cancelled`；accepted/cancelled 为终态。submitted/rework/accepted 必须保留本轮 submission；accepted/rework 必须保留带有效 evidence 的 Lead acceptance 决策。`work block` 只记录基础设施失败的 code、reason、refs、Owner 和时间，不代替任务返工。返工或基础设施阻塞重新进入 running 前，把上一 attempt 的 submission/acceptance 或 blockage 移入 `attemptHistory` 并递增 attempt；仅 blocked→start 可通过 `--owner` 在同一 work item 内受限换 Owner。blocked→cancelled 保留当前 blockage，确保最终错误仍可追溯。历史必须完整覆盖 `1..attempt-1`，任务验收历史只能以 rework 结束。每项 assignment 至少声明一个产物路径。

Team-work 场景完成时通过 work submission 返回以下通用语义：

```text
scenario / stageRef / scopeRefs
outcome: pass | rework | blocked | degraded
artifactRefs / evidenceRefs / summary
```

Workflow 消费 outcome 后决定流转；Team-work 不直接修改阶段。SPEC Skill 同样返回 `status / artifactRefs / validationEvidence / openQuestions / recommendedNextStage`，由 Workflow 注册并检查门禁。

## 5. 会话绑定与恢复

会话绑定是可重建索引，存放在：

```text
.team-work/bindings/<platform>/<session-key>.json
```

绑定只保存规范化 platform、安全 sessionKey、taskId、revision 和时间，不保存平台完整会话、消息或模型状态。PlatformPlugin 必须把原 session ID 确定性编码为 `[A-Za-z0-9._-]` sessionKey，禁止把原始值直接拼入路径。rebind 在绑定锁内检查 expected revision 并原子替换；指向终态/归档任务的 binding 不参与活动解析，由 doctor 清理。跨 CLI 或新会话恢复以稳定 taskId 和项目制品为准，然后建立新绑定；不承诺恢复原 subagent/teammate 进程。

活动任务按以下顺序解析：

1. 显式 `--task` 或 `TEAM_WORK_TASK_ROOT`；
2. 当前 `<platform>/<session-key>` 绑定；
3. 项目唯一 active task。

存在多个候选时返回歧义错误，禁止猜测。

## 6. Platform Profile

Platform Profile 是 Team-work 读取平台能力的唯一 Interface，必须给出 ID 唯一的 Agent 档位、requested/resolved model、成本权重、受管派发模式、spawn/assign/resume/status/stop/message 操作映射、并发限制、session/UI 能力和已知降级。共享 schema 允许平台声明 background 或 blocking；OpenCode Adapter 及其 fixture 单独强制 background + reject/rewrite，不能把 OpenCode 限制扩大成所有平台规则。

## 7. JSON envelope

成功/失败结构由 [`response.schema.json`](../schemas/response.schema.json) 机器校验。任务尚未解析时允许省略 taskId/revision；一旦定位任务就必须返回二者。成功：

```json
{
  "ok": true,
  "apiVersion": "1.0",
  "taskId": "review-existing-code",
  "revision": 3,
  "data": {},
  "warnings": []
}
```

失败：

```json
{
  "ok": false,
  "apiVersion": "1.0",
  "taskId": "review-existing-code",
  "revision": 3,
  "error": {
    "code": "GATE_BLOCKED",
    "message": "code-review 缺少 review-scope",
    "retryable": false,
    "blockers": [{
      "code": "MISSING_INPUT",
      "kind": "review-scope",
      "path": "code-review",
      "message": "缺少当前阶段必需的 review-scope",
      "expected": 1,
      "actual": 0
    }],
    "remediation": ["注册明确的 commit、diff 或工作区审查范围"]
  }
}
```

稳定错误码：

| code | 含义 |
| --- | --- |
| `INVALID_ARGUMENT` | 参数或 JSON 不符合契约 |
| `SCHEMA_VERSION_UNSUPPORTED` | schema/API 版本低于最低支持或无法读取 |
| `TASK_NOT_FOUND` | 无法找到指定任务 |
| `TASK_AMBIGUOUS` | 存在多个活动任务，调用方必须显式选择 |
| `REVISION_CONFLICT` | expected revision 与当前状态不一致 |
| `ILLEGAL_TRANSITION` | 阶段边或回退目标非法 |
| `GATE_BLOCKED` | 当前阶段最低输入或决策门禁不满足 |
| `WORK_ITEM_CONFLICT` | Owner、attempt 或生命周期冲突 |
| `STATE_CORRUPT` | 控制文件损坏，需 doctor/restore |
| `LOCK_UNAVAILABLE` | 无法安全获得写锁，可稍后重试 |
| `PLATFORM_UNAVAILABLE` | PlatformPlugin 能力不可用；CoreRuntime 状态保持不变 |
| `INTERNAL_ERROR` | 未分类内部错误，必须保留诊断 ID |

退出码：`0` 成功，`2` 参数/契约错误，`3` revision/lock 冲突，`4` 门禁/非法流转，`5` 平台暂不可用，`70` 内部或损坏状态。

## 8. 并发与写入保证

每次写操作必须在任务锁内校验 `expected-revision`，使用同目录临时文件和原子 rename 更新权威文件，并在成功后递增 revision。失败不得留下部分成功的业务状态。首版事件日志是审计记录，不是权威状态；若状态写成功而事件追加失败，`doctor` 可以补记，不回滚已提交状态。

所有项目路径必须是 project-relative，schema 拒绝绝对路径、反斜杠和 `..` segment。Runtime 写入前还必须以 realpath 校验目标及其已存在父目录仍位于项目根内，防止 symlink 越界；仅靠字符串校验不能授权文件访问。
