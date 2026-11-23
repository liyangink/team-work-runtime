# 评测脚本（v3 安全门）

- setup-isolation.sh：构造隔离 HOME/DSH_HOME/profile/项目根。只创建全新根；拒绝已存在目标、软链、仓库内/HOME 内路径；拒绝输入包与依赖软链；复制后对插件/依赖树做全树软链扫描，发现即拒绝且不删除；删除前确认目标非软链；不读取或复制任何凭据；可选用 EXPECTED_SKILL_SHA256 校验加载副本。
- run-headless.sh：以独立 DSH CLI 顶层会话运行任务；多轮用 --session-id 续聊。对 HOME/DSH_HOME/project/evidence 逐级校验非软链且物理路径在根内；TAG 限单段；输出已存在即拒绝；TASKFILE/DSH_BIN/ELECTRON_BIN 在 cd 前绝对化；cd 失败即退出；unset 继承的 DSH 运行变量；凭据只从调用方环境变量读取。
- test-safety-guards.sh：可重复安全夹具（新建 /tmp 根 + 无副作用桩），覆盖预存根/软链根/仓库/HOME/包/依赖/evidence/TAG/相对路径/输出软链等 22 个用例；不启动真实 DSH、不使用凭据。
- extract-skill-return.mjs：从会话日志的 tool/result 提取 skill 正文并计算哈希。
- parse-session.mjs：从 --json 事件流与压缩会话日志提取模型请求头、工具轨迹与用量。
- workspace-fingerprint.sh：记录真实工作区只读指纹（4 个文件哈希、git 状态、.team-work 元数据摘要）；元数据不等于内容级未变。

环境要求：可用的 DSH 宿主 CLI（本测试 0.2.2-rc.3）、调用方提供的 provider 凭据环境变量；本机嵌套会话需要 DSH_PERMISSION_MODE=danger-full-access 才能让成员写测试根，外层仍应有文件沙箱约束。安全门已验证项与未覆盖项见 ../results/script-safety-tests.md；隔离缺口见 ../results/isolation-evidence.md。v3 未在真实 DSH 会话上复测（本轮不启动新演练）。
- 注意：run-headless.sh 要求 TAG 每次唯一（输出文件已存在即拒绝），重跑同一场景请换 TAG 或新建根。
