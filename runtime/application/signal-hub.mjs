export function createSignalHub() {
  const waiters = new Map()

  return Object.freeze({
    publish(taskId) {
      const current = waiters.get(taskId)
      if (!current) return
      waiters.delete(taskId)
      for (const wake of current) wake()
    },

    subscribe(taskId, { signal, timeoutMs }) {
      let settled = false
      let timer
      let abort
      let resolvePromise
      const listeners = waiters.get(taskId) ?? new Set()
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (abort) signal.removeEventListener("abort", abort)
        listeners.delete(finish)
        if (listeners.size === 0) waiters.delete(taskId)
        resolvePromise()
      }
      const promise = new Promise((resolve) => { resolvePromise = resolve })
      listeners.add(finish)
      waiters.set(taskId, listeners)
      if (signal) {
        abort = finish
        if (signal.aborted) finish()
        else signal.addEventListener("abort", abort, { once: true })
      }
      if (!settled) timer = setTimeout(finish, Math.max(0, timeoutMs))
      return { promise, cancel: finish }
    },
  })
}
