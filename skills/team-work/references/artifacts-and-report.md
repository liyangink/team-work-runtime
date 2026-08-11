# 制品与汇报

## 目录建议

把控制状态留给 Runtime，把团队正文放在当前任务的 `artifacts/team/` 下：

```text
.team-work/tasks/<task-id>/artifacts/team/
  plan.md
  members/<work-item-id>.md
  rounds/round-1.md
  rounds/round-2.md
  rounds/round-3.md
  challenge.md
  final-report.md
```

只创建场景实际需要的文件。代码、测试和 SPEC 保持在项目约定位置，通过 context 和 evidence 引用，不复制到团队目录。

## 轮次记录

每轮汇总包含：目标、参与成员与档位、已验证事实、共识、冲突、证据缺口、挑战结论、Expert 裁决、下一轮问题和相关制品路径。Lead 只维护该索引，不复制成员全文或重写技术结论。

## 最终汇报

1. 任务、阶段与团队目标；
2. 拓扑、成员档位、模型和各自范围；
3. 最终结论或交付摘要；
4. 完成条件及逐项证据；
5. 挑战者发现、已关闭项与未关闭项；
6. 验证命令、结果和制品路径；
7. 分歧、残余风险和需要用户决定的事项；
8. 建议的工作流结果：`pass`、`rework`、`fail` 或 `awaiting-user`。

Expert 给出内容建议结果；Lead/Workflow 只核对完成条件并更新阶段。若启用评分，只附评分文件路径，不改变工作流结论。
