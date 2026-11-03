// store.js — 纯函数任务状态计算层（要求：纯内存同步计算，零 I/O、零定时器副作用）

export function isTaskExpired(task, nowMs) {
  if (!task || typeof task.deadlineMs !== "number") return false
  return nowMs > task.deadlineMs
}

export function partitionTasks(tasks, nowMs) {
  const active = []
  const expired = []
  for (const t of tasks ?? []) {
    if (isTaskExpired(t, nowMs)) expired.push(t)
    else active.push(t)
  }
  return { active, expired }
}
