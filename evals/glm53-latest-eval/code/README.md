# GLM-5.3 最新版评测脚本

本目录只包含本次评测的隔离脚本、确定性与真实场景输入；不修改 Runtime、技能源码或旧评测材料。

## 脚本

- `setup-isolation.sh`：在全新临时根内构造隔离 HOME/DSH_HOME/profile/project/evidence，把**当前工作区源码**（package.json、bin、dsh、runtime-v3、policy、workflow、spec-providers、team-work、skills）复制成 profile 内的 `team-work-runtime`，并复制最小依赖（`@deepseek-ai/schemastery`、`@deepseek-ai/cosmokit`、`@standard-schema/spec`）。拒绝已存在目标、软链、仓库内/HOME 内路径；复制后做全树软链扫描；不读取或复制凭据；输出源码树与加载树 SHA-256（逐文件排序摘要）与技能哈希。
- `run-headless.sh`：**已按安全缺省禁用**，只输出拒绝说明并 exit 2；不启动 DSH、不读取凭据、不写工作区。原因：本机外层沙箱对真实仓库可写，无法证明既有文件/子目录与用户数据受保护；历史轨迹是旧版脚本产生的受限观察。没有自动放行路径。
- `preflight-cli.mjs`：确定性 CLI 预检（23 项），不启动模型：首卡完整字段、首次推进不派发、缺/错 decision-id 拒绝、相同计划不重签、确认后局部修改的增量 diff、旧卡 ID 拒绝、计划非数组拒绝且无字符遍历噪声、评审 finding 包名精确校验。**安全**：要求带 setup 标记、位于真实 repo/HOME 之外的隔离根；`cli-preflight` 与各任务目录非递归独占创建，已存在目录/软链即拒绝；夹具以 `wx` 独占写入。
- `record-session-facts.mjs`：从隔离 DSH_HOME 的 zstd 会话日志提取逐会话事实（模型配置、cwd、权限、技能正文哈希、工具调用、用量），并对比仓库技能文件。
- `export-evidence.mjs`：把事件流、会话日志、任务输入、事实 JSON 复制到 `results/raw/`，逐文件 SHA-256 生成 `index.json`。
- `repro-finding-package-field.sh`：确定性复现 F-N1（rework finding 使用未定义字段 `packages` 时被当作未点名，全部已交付包返工）。只接受带 setup 标记、位于 repo/HOME 之外的 `EVAL_ROOT`；项目目录必须尚不存在（拒绝已有目录/软链），用非递归 `mkdir` 独占创建；不做 `rm -rf`。
- `analyze-scenarios.mjs`：从事件流与会话事实生成场景时间线与成员摘要（报告表格素材）。
- `write-probe.sh`：外层文件沙箱与网络边界探针。所有探针用 `mktemp` 独占随机文件名，只删除本次创建的文件，不触碰既有路径；写仓库/HOME/隔离根、子进程继承、网络可达、嵌套 sandbox-exec。

## 任务输入（预定义模拟用户剧本）

`tasks/` 下为逐字输入；历史运行时由旧版 `run-headless.sh` 从 stdin 投递（新入口已禁用），副本与哈希进入证据：

- `p1.md`：预检（cwd/HOME、原生 tw、技能加载、越界写入）。
- `s1a.md` / `s1b.md` / `s1c.md`：S1 三轮（首卡展示 → 确认首卡并请求局部修改 → 确认增量卡并逐波推进）。
- `s3a.md` / `s3b.md`：S3 两轮（首卡展示 → 确认并逐波推进到门）。
- `s4a.md`：S4 单轮（只计划、不派发）。

## 环境要求

DSH App 0.2.2-rc.3 可用（`ELECTRON_BIN` 为 App 可执行文件，`DSH_BIN` 为 asar 内 `@deepseek-ai/dsh/lib/bin.js`），调用方提供 `ZAI_CODING_CN_API_KEY`（不落盘）；隔离根放在 `/tmp`。**不要**在仓库或用户 HOME 内创建隔离根。

示例（在仓库根执行）：

```bash
EVAL_ROOT=/tmp/glm53-latest-eval-$(date +%s) REPO=$PWD \
PROVIDER=zai-coding-cn PROVIDER_ENV=ZAI_CODING_CN_API_KEY MODEL=glm-5.3 EFFORT=max \
  ./evals/glm53-latest-eval/code/setup-isolation.sh

export ZAI_CODING_CN_API_KEY=$(ruby -ryaml -e 'print YAML.load_file(ARGV[0])["refs"]["ZAI_CODING_CN_API_KEY"]' ~/.dsh/.credentials.yaml)
export DSH_BIN="$HOME/.dsh/.../asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
export ELECTRON_BIN="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
./evals/glm53-latest-eval/code/run-headless.sh "$EVAL_ROOT" p1 - evals/glm53-latest-eval/code/tasks/p1.md ZAI_CODING_CN_API_KEY
# 最后一步会固定拒绝：真实演练入口已禁用；历史轨迹不可用新脚本重跑。
```

## 安全前置与受限观察

- 本机外层沙箱对用户 HOME 拒写，但对真实仓库可写；**按本轮约束，这属于“缺少可证明安全边界”，不应发生新的真实模型演练。**
- `run-headless.sh` 已改为固定拒绝的存根：没有自动放行门，也没有用路径替换或根目录试建来自证安全的路径；历史轨迹是旧版脚本产生的受限观察，不要用本目录脚本重跑。
- 历史轨迹使用的是旧版 `danger-full-access`；本机嵌套 `sandbox-exec` 不可用，因此即使将来有外层证明，也需要宿主提供有效内层隔离。

## 已知限制

- 嵌套 `sandbox-exec` 在本机不可用；即使外层边界证明通过，内层也需宿主支持才能运行。
- 成员模型沿用旧基线设置（三角色均为 GLM-5.3/max）；跨模型家族行为未覆盖。
- 模拟用户答复不是真实用户批准；人工门未签。
