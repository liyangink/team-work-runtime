# 隔离证据与未证实边界（第 3 版）

> 结论：**预检不足以证明“完全隔离”**，该结论继续撤回。可证实的是进程级工作目录、HOME/DSH_HOME 与技能工具返回内容；不可证实的是“真实工作区的写入会被拒绝”。已发生的模型轨迹降级为**受隔离缺口限制的观察**，不据此复跑，也不再启动新的真实模型/成员会话。

## 1. 可证实的事实（附原始证据）

| 事实 | 证据 |
| --- | --- |
| 4 个顶层 Lead 会话 cwd = `/private/tmp/twr-glm53-eval/project` | `results/raw/session-model-records.jsonl` 的 `cwd`；`results/raw/session-logs/*.jsonl.zstd` |
| 10 个成员子会话 cwd 同上，parentSession 指向对应 Lead | 同文件 `origin=subagent`、`parentSession` |
| 每个会话的 provider/model/effort | 同文件的 `requestHeader.header.config`（原始 request/header 行的提取；已核对 19 个请求头与压缩日志一致） |
| 技能工具返回的完整正文（不是截断前缀） | 6 份会话日志（4 个场景会话 + 2 个预检会话）中 `tool/result`（seq=18 或 23）的 `<skill_instructions>` 正文均为 **14,175 字节**，SHA-256 均为 `22bf19c0…18bae`，与仓库文件一致；提取脚本与逐条清单见 `results/raw/skill-loaded/tool-return-hashes.jsonl` 及 `code/extract-skill-return.mjs` |
| 技能从隔离 profile 加载 | base directory = `/private/tmp/.../profiles/headless/node_modules/team-work-runtime/skills/team-work-v3` |
| 真实工作区 4 个文件哈希在场景前后一致 | `results/raw/workspace-fingerprint-before.txt` / `after.txt` |
| 真实 `.team-work` 文件数 620、元数据摘要 `fc26ce0c…` 前后一致 | 同上（仅元数据，见 §2） |

**区分**：技能工具返回正文已可复算并哈希一致；“模型内部如何使用这段正文”无法从日志直接证明（也不宣称）。`--json` 事件流中的 skill 结果是 8192 字节截断（`truncated=true`），这是**事件流通道**的限制，不代表会话日志中的工具返回被截断。

## 2. 未证实 / 不能据此下的结论

1. **没有写入拒绝哨兵**：没有让成员尝试写真实工作区并被拒绝的记录；“文件沙箱与用户工作区完全隔离”未被证明。
2. **内层沙箱是 danger-full-access**：headless 会话内部不施加写限制；外层 workspace-write 是否真正阻止写穿、哪些路径被拒，未做拒绝探针，不能凭名称断言。
3. **指纹只覆盖元数据与 4 个文件**：`.team-work` 只比较了文件名/大小/mtime 摘要，未做内容哈希；不能证明内容级未变。
4. **v1/v2 运行器未清理继承的宿主变量**：实际运行继承了 `DSH_PROFILE_DIR`、`DSH_SESSION_ID` 等；未观察到实际影响（会话内技能/规则路径均为隔离路径），但未验证为无害。v3 已显式 unset；**v3 未在真实会话复测**。
5. **v3 脚本安全门已覆盖目录/软链/TAG/相对路径等用例，但未覆盖 TOCTOU 竞态、硬链接替换与恶意外部环境**（见 `script-safety-tests.md`）。
6. **无凭据泄漏的形式化证明**：只做交付目录的有限模式扫描，未覆盖进程内存、临时进程环境、系统日志或已删除文件的恢复；不宣称“未泄露”。

## 3. 处理决定

- 不启动新的真实模型/成员会话，不重跑已完成场景。
- 既有轨迹标为“受隔离缺口限制的观察”；S1/S3 的行为观察也带此限制。
- 要补齐隔离证明，需要用户/Lead 明确授权的新演练：写拒绝哨兵、真实工作区内容哈希、宿主变量清理后的复测。
