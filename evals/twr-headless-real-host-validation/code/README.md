# 离线复跑与证据索引

这里只能运行 Node/TWR CLI 与无模型的仓库自动测试，**不是 DSH 实机启动器或安全隔离实现**。依赖限于仓库内既有依赖，不安装包、不访问真实 profile。过程只在本目录新建临时根；子进程给定虚构 HOME、TMPDIR 和虚构选模快照，不继承用户凭据、实际 DSH profile 或宿主测试开关。测试结束只清理本次临时根。现有受控替身被用于调度、收件日志和故障，不模拟用户实际授权。

从仓库根运行（输出写到终端，不覆盖证据）：

```bash
node evals/twr-headless-real-host-validation/code/run-offline.mjs cli
node evals/twr-headless-real-host-validation/code/run-offline.mjs suite
```

- [驱动](run-offline.mjs)固定范围复制当前源码，逐文件对比 SHA-256，再由 Node 使用副本入口运行；输入和副本试验前后重新核验。套件模式需要仓库内已有包声明的 Schemastery 和传递依赖；找不到则失败，不从其他 profile 取或联网安装。只验证独立夹具正向写入，不作为实机安全证据。
- [CLI 用例](cli-cases.mjs)定义两包闭环、同/跨 key 漏列路径、Expert 全组、刷新卡、按包恢复和规则路径。[首轮回执](cli-evidence.jsonl)和[第二轮回执](cli-round2.jsonl)均为原始运行证据，每行为一个有标识的 JSON 事件，命令参数、状态码、完整公开回执、合成文件字节及断言结果在内。仅把本机绝对根路径换成占位符；无真实角色 ID 或凭据。每次重跑的派单 key/卡 ID 等可变，不要求结果字节相同。
- [自动测试 TAP](automated.tap.txt)保留实际套件名单、逐条断言、跳过原因及计数，原路径换为占位符。旧评测框架与整仓静态契约不在此模式中；DSH 宿主接缝用例未提供宿主，原样跳过。
- [安全原始结果](safety-evidence.md)记录必停判据和无副作用打开探针。[试跑记录](pilot-diagnostics.md)将驱动与测试断言修正同产品行为区分。
