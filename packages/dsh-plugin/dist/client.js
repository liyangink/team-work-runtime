// 由 build.mjs 生成——勿手改。工厂式 CJS（dsh client 插件装载约定）
var factory = function (module, exports) {
  // badge.js — client 插件：子代理模型席位徽标
  // CJS 工厂形状（build.mjs 零转换包装）；组件为 React 函数组件（slot 渲染器把注册组件直接挂进宿主 React 树——
  // 平台事实：原生 ModelSelect 同一形态 slots.register(spec, Component)；react 经 factory 的 require 解析自宿主模块空间）。
  var SLOT = "conversation.input.model"

  var inject = ["slots", "sessions", "logger"]

  function apply(ctx) {
    var React
    try { React = require("react") } catch (e) {
      ctx.logger?.warn?.("team-work-dsh(badge): react 不可解析，徽标停用")
      return
    }
    try {
      var sessions = ctx.sessions
      ctx.slots.inject(SLOT, function () {
        ctx.slots.register({
          name: SLOT,
          id: "tw-subagent-model-badge",
          order: 20,
          locale: "zh-CN",
          inject: function (sessionId) {
            // 仅 addressed 子代理会话提供徽标 props；父会话返回 null（原生 ModelSelect 正常渲染）
            return sessions && sessions.subagentAddress && sessions.subagentAddress(sessionId) !== undefined
              ? { sessionId: sessionId }
              : null
          },
        }, SubagentModelBadge)
      })
    } catch (error) {
      ctx.logger?.warn?.("team-work-dsh(badge): 徽标注册失败：" + String(error?.message ?? error))
    }

    function SubagentModelBadge(props) {
      var h = React.createElement
      var current = useSessionModel(ctx, props && props.sessionId)
      if (!current) return null
      var label = current.provider + "/" + current.model + (current.reasoningEffort ? " · 推理 " + current.reasoningEffort : "")
      return h("span", {
        "data-tw-badge": "subagent-model",
        title: label,
        style: { fontSize: "12px", opacity: 0.75, padding: "0 4px" },
      }, label)
    }
  }

  // 最小数据钩子：挂载时拉一次 sessions.models RPC（失败静默→徽标不渲染）
  function useSessionModel(ctx, sessionId) {
    var React = require("react")
    var state = React.useState(null)
    var value = state[0]; var setValue = state[1]
    React.useEffect(function () {
      if (!sessionId) return
      var cancelled = false
      try {
        var api = ctx.get && ctx.get("connection") && ctx.get("connection").api
        if (!api || !api.sessions || !api.sessions.models) return
        api.sessions.models({ sessionId: sessionId }).then(function (res) {
          if (cancelled) return
          var cur = res && (res.result || res)
          setValue((cur && cur.current) || null)
        }).catch(function () { /* RPC 失败静默 */ })
      } catch (e) { /* 同步失败静默 */ }
      return function () { cancelled = true }
    }, [sessionId])
    return value
  }

  module.exports = { apply: apply, inject: inject }

};
var api = (typeof window !== 'undefined' ? window : globalThis).__ModuleLoader__;
if (api && api.load) {
  var m = { exports: {} };
  api.load({ id: "team-work-runtime-dsh", factory: factory });
}