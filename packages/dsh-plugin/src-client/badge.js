// badge.js — client 插件：子代理模型席位徽标
// 直接以 CJS 工厂形状书写（build.mjs 仅做包装，零语法转换——规避转义脆弱性）。
// 平台事实：client 插件产物为 window.__ModuleLoader__.load({id, factory}) 工厂式 CJS；
// slot "conversation.input.model" 单席位；原生 ModelSelect 对 addressed 子代理返回 null（互补不冲突）。
var SLOT = "conversation.input.model"

var inject = ["slots", "sessions", "logger"]

function apply(ctx) {
  try {
    ctx.slots.inject(SLOT, function () {
      ctx.slots.register(
        { name: SLOT, id: "tw-subagent-model-badge", order: 20, locale: "zh-CN" },
        SubagentModelBadge,
      )
    })
  } catch (error) {
    ctx.logger?.warn?.("team-work-dsh(badge): 徽标注册失败：" + String(error?.message ?? error))
  }

  // 最小组件：不依赖 JSX/React 运行时——宿主 slot 渲染器接受返回 DOM 节点的工厂。
  // I4 装载验证时按真实 slot 组件约定校正（如需 React.createElement 形态再引入 pragma）。
  function SubagentModelBadge(props) {
    var state = { current: null }
    var el = createHost()
    fetchCurrent(props?.sessionId)
    return el

    function createHost() {
      var node = typeof document !== "undefined" && document.createElement
        ? document.createElement("span")
        : { setAttribute: function () {}, textContent: "" }
      node.setAttribute?.("data-tw-badge", "subagent-model")
      node.style && (node.style.fontSize = "12px", node.style.opacity = "0.75")
      return node
    }

    function render() {
      var c = state.current
      el.textContent = c ? (c.provider + "/" + c.model + (c.reasoningEffort ? " · 推理 " + c.reasoningEffort : "")) : ""
    }

    function fetchCurrent(sessionId) {
      render()
      if (!sessionId) return
      try {
        var api = ctx.get?.("connection")?.api
        if (!api?.sessions?.models) return
        api.sessions.models({ sessionId: sessionId }).then(function (res) {
          state.current = (res && (res.result || res)).current || null
          render()
        }).catch(function () { /* RPC 失败静默：徽标留空 */ })
      } catch { /* 同步失败静默 */ }
    }
  }
}

module.exports = { apply: apply, inject: inject }
