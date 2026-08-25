// badge.js — client 插件源文件（自带工厂形态，免构建：本文件即装载产物）
// dsh client 装载协议：宿主按 exports["./client"] 取本文件作为脚本执行，
// __ModuleLoader__.load 注册工厂；react 经工厂内 require 解析自宿主模块空间。
var factory = function (require) {
  // badge.js — client 插件：子代理模型席位徽标
  // CJS 工厂形状（build.mjs 零转换包装）；组件为 React 函数组件（slot 渲染器把注册组件直接挂进宿主 React 树——
  // 平台事实：原生 ModelSelect 同一形态 slots.register(spec, Component)；react 经 factory 的 require 解析自宿主模块空间）。
  // input.right 与原生模型选择器相邻且是 list 席位；不能抢占 single 的 input.model，
  // 否则父会话会失去原生选择器，且条件 inject 返回 null 会触发渲染器退席。
  var SLOT = "conversation.input.right"

  var inject = ["slots", "sessions", "connection"]

  function apply(ctx) {
    var React
    try { React = require("react") } catch (e) {
      ctx.logger?.warn?.("team-work-dsh(badge): react 不可解析，徽标停用")
      return
    }
    try {
      var sessions = ctx.sessions
      ctx.slots.inject(SLOT, function () {
        return ctx.slots.register({
          name: SLOT,
          id: "tw-subagent-model-badge",
          order: 20,
          inject: function (sessionId) {
            // slot inject 必须返回对象；是否显示由组件判断，父会话继续使用原生 ModelSelect。
            return {
              sessionId: sessionId,
              addressed: !!(sessions && sessions.subagentAddress && sessions.subagentAddress(sessionId) !== undefined),
            }
          },
        }, SubagentModelBadge)
      })
    } catch (error) {
      ctx.logger?.warn?.("team-work-dsh(badge): 徽标注册失败：" + String(error?.message ?? error))
    }

    function SubagentModelBadge(props) {
      var h = React.createElement
      var running = props && props.session && props.session.running
      var selected = useSessionModel(ctx, props && props.addressed ? props.sessionId : null, running)
      var current = props && props.addressed ? modelFromSession(props.session) || selected : null
      if (!current) return null
      var label = current.provider + "/" + current.model + (current.reasoningEffort ? " · 推理 " + current.reasoningEffort : "")
      return h("span", {
        "data-tw-badge": "subagent-model",
        title: label,
        style: { fontSize: "12px", opacity: 0.75, padding: "0 4px" },
      }, label)
    }
  }

  // 会话日志里的 requestConfig 是已实际发出的请求事实；addressed 子代理在部分宿主版本
  // 不开放 sessions.models，因此优先从最新 request/assistant 记录取值，RPC 仅作首轮前兜底。
  function modelFromSession(session) {
    if (!session) return null
    try {
      var trajectory = session.views && session.views.get && session.views.get("trajectory")
      var requests = trajectory && trajectory.requests
      var fromRequests = modelFromRows(requests, "assistant")
      if (fromRequests) return fromRequests
    } catch (e) { /* 可选 trajectory view 不可用时回退 chat */ }
    return modelFromRows(session.nodes, "assistant")
  }

  function modelFromRows(rows, expectedKind) {
    if (!Array.isArray(rows)) return null
    for (var index = rows.length - 1; index >= 0; index -= 1) {
      var row = rows[index]
      if (expectedKind && row && row.kind !== expectedKind && row.purpose !== expectedKind) continue
      var config = row && row.requestConfig
      if (config && typeof config.provider === "string" && config.provider && typeof config.model === "string" && config.model) {
        return {
          provider: config.provider,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
        }
      }
    }
    return null
  }

  // RPC 兜底：挂载及运行状态切换时读取当前选择（失败静默，保留日志事实或暂不渲染）。
  function useSessionModel(ctx, sessionId, refreshToken) {
    var React = require("react")
    var state = React.useState(null)
    var value = state[0]; var setValue = state[1]
    React.useEffect(function () {
      if (!sessionId) return
      var cancelled = false
      try {
        var connection = ctx.connection || (ctx.get && ctx.get("connection"))
        var api = connection && connection.api
        if (!api || !api.sessions || !api.sessions.models) return
        api.sessions.models({ sessionId: sessionId }).then(function (res) {
          if (cancelled) return
          var result = res && (res.result || res)
          var value = result && result.ok === true ? result.value : result
          setValue((value && value.current) || null)
        }).catch(function () { /* RPC 失败静默 */ })
      } catch (e) { /* 同步失败静默 */ }
      return function () { cancelled = true }
    }, [sessionId, refreshToken])
    return value
  }

  return { apply: apply, inject: inject }

};
var api = (typeof window !== 'undefined' ? window : globalThis).__ModuleLoader__;
if (api && api.load) {
  // 双身份注册：client bundle 的 graph id = 安装包名（<包名>/client strip 后缀），
  // 根包通道（team-work-runtime，市场 git 源码）与插件单包通道（team-work-runtime-dsh）
  // 各命中各的 id；未命中的注册无消费者，惰性无害。
  api.load({ id: "team-work-runtime-dsh", factory: factory });
  api.load({ id: "team-work-runtime", factory: factory });
}
