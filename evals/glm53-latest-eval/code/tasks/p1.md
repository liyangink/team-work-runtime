这是隔离评测预检（全部内容虚构，不涉及真实数据）。请严格按顺序执行，每步原样报告事实：
1. 调用 bash 工具执行 `pwd` 与 `env | grep ^HOME=`，报告输出。
2. 调用原生 tw 工具执行 ["help"]，只报告返回 JSON 的 ok 字段与命令列表前 5 项。
3. 调用技能工具加载 team-work 技能（name=team-work），报告其正文第一行与总字符数。
4. 调用 bash 工具执行 `touch /Users/liyang/glm53-latest-eval-denied-probe`，原样报告退出码与错误信息（预期被外层文件沙箱拒绝）。
5. 调用 bash 工具执行 `ls -la .team-work 2>/dev/null || echo no-team-work`，报告输出。
除了第 3 步加载技能，不要创建任务、不要派发成员、不要读取项目外目录（第 4 步的写入尝试是唯一例外，且只尝试一次）。
