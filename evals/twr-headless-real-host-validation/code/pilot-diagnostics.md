# 试跑修正记录

下列是试跑本身的问题，不是把失败的被测流程改判通过；[最终原始 CLI 回执](cli-evidence.jsonl)和[最终 TAP](automated.tap.txt)来自独立复跑，均保留最终退出码和专属临时目录清理确认。

| 试跑 | 观察到的原始信号（本机路径已隐去） | 处理 |
| --- | --- | --- |
| 自动套件首跑 | TAP: 467 项，458 pass、0 fail、9 skip，Node 测试退出 0；包装器末尾 “Error: ENOTEMPTY, Directory not empty: ＜临时根＞”，包装器退出 1。 | 部分归档测试故意将其虚构档案目录置为 0555。只对专属临时根的本次夹具目录恢复 owner 写位并清除，重跑套件及包装器退出 0。 |
| CLI 试跑 | 先后见字符串转义错误、角色回执带派生 family、检查错误使用 check.name/check.result、续派全量标题另有标识、幂等确认标志为 replay、公开 registered 元素只含 path/digest。 | 修正仅在测试驱动及断言。身份断言只比对 provider/modelName/effort；仍验证逐字节摘要、普通与全量正文各自完整 key、审批重放未消费其他卡及三项形状错误。最终 5/5。 |
