// runner.js — 外部调度执行器（只读受保护文件：未经架构师重新授权严禁修改本文件）
import { partitionTasks } from "./store.js"

export function runOnce(tasks, nowMs = Date.now()) {
  return partitionTasks(tasks, nowMs)
}
