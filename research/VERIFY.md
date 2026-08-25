# VERIFY — 注入链验证

宿主契约（dsh-subagent SetupRegistry.apply 源码实证）：contribution(childCtx) 同步调用，返回值【直接存为 disposer，不 await】——async contribution = Promise 被当 disposer + 同步段在首个 await 让出，install 真正执行可能晚于子代首请求（监听器迟到）。故本实现为同步函数。
