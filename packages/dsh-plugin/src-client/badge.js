// badge.js — DSH Web client bundle：子代理模型席位徽标与全局 tiers 配置卡。
// 文件本身是宿主加载的 CJS 工厂产物；React 由宿主模块空间提供。
var factory = function (require) {
  var BADGE_SLOT = "conversation.input.right"
  var SETTINGS_SLOT = "settings.plugin.item"
  var SETTINGS_NS = "team-work-dsh"
  var TIER_ORDER = ["junior", "senior", "expert"]
  var TIER_TEXT = {
    junior: "低成本的只读探索与常规辅助工作。",
    senior: "常规实现、复核与需要稳定判断的工作。",
    expert: "核心场景、技术裁决与高失败成本工作。",
  }
  var inject = ["slots", "sessions", "connection", "settingsScope"]

  function getService(ctx, name) {
    return ctx[name] || (ctx.get && ctx.get(name))
  }

  function warn(ctx, message) {
    ctx.logger?.warn?.("team-work-dsh: " + message)
  }

  function apply(ctx) {
    var React
    try { React = require("react") } catch (error) {
      warn(ctx, "react 不可解析，Web 扩展停用")
      return
    }
    registerBadge(ctx, React)
    registerTierSettings(ctx, React)
  }

  function registerBadge(ctx, React) {
    try {
      var sessions = ctx.sessions
      ctx.slots.inject(BADGE_SLOT, function () {
        return ctx.slots.register({
          name: BADGE_SLOT,
          id: "tw-subagent-model-badge",
          order: 20,
          inject: function (sessionId) {
            return {
              sessionId: sessionId,
              addressed: !!(sessions && sessions.subagentAddress && sessions.subagentAddress(sessionId) !== undefined),
            }
          },
        }, function SubagentModelBadge(props) {
          var h = React.createElement
          var running = props && props.session && props.session.running
          var selected = useSessionModel(React, ctx, props && props.addressed ? props.sessionId : null, running)
          var current = props && props.addressed ? modelFromSession(props.session) || selected : null
          if (!current) return null
          var label = current.provider + "/" + current.model + (current.reasoningEffort ? " · 推理 " + current.reasoningEffort : "")
          return h("span", {
            "data-tw-badge": "subagent-model",
            title: label,
            style: { fontSize: "12px", opacity: 0.75, padding: "0 4px" },
          }, label)
        })
      })
    } catch (error) {
      warn(ctx, "徽标注册失败：" + String(error?.message ?? error))
    }
  }

  function registerTierSettings(ctx, React) {
    var binder = getService(ctx, "settingsScope")
    if (!binder || typeof binder.bind !== "function") {
      warn(ctx, "settingsScope 不可用，跳过全局档位配置卡")
      return
    }
    var scope
    try {
      scope = binder.bind({ namespace: SETTINGS_NS })
    } catch (error) {
      warn(ctx, "全局档位配置绑定失败：" + String(error?.message ?? error))
      return
    }
    try {
      ctx.slots.inject(SETTINGS_SLOT, function () {
        return ctx.slots.register({
          name: SETTINGS_SLOT,
          key: SETTINGS_NS,
          id: "team-work-dsh-tiers",
          order: 10,
          inject: function () { return { scope: scope } },
        }, function TierSettingsCard(props) {
          return renderTierSettingsCard(ctx, React, props)
        })
      })
    } catch (error) {
      warn(ctx, "全局档位配置卡注册失败：" + String(error?.message ?? error))
    }
  }

  function renderTierSettingsCard(ctx, React, props) {
    var h = React.createElement
    var scope = props && props.scope
    var snapshot = useSettingsSnapshot(React, scope)
    var draftState = React.useState(function () {
      return normalizeTiers(snapshot.value && snapshot.value.tiers)
    })
    var draft = draftState[0]
    var setDraft = draftState[1]
    React.useEffect(function () {
      setDraft(normalizeTiers(snapshot.value && snapshot.value.tiers))
    }, [snapshot.revision, snapshot.status, snapshot.value])
    var catalog = useModelCatalog(React, ctx)
    var errorState = React.useState("")
    var error = errorState[0]
    var setError = errorState[1]
    var noticeState = React.useState("")
    var notice = noticeState[0]
    var setNotice = noticeState[1]

    function updateCandidate(tier, index, field, value) {
      setDraft(function (previous) {
        var next = cloneTiers(previous)
        next[tier][index][field] = value
        return next
      })
      setError("")
      setNotice("")
    }

    function addCandidate(tier) {
      setDraft(function (previous) {
        var next = cloneTiers(previous)
        next[tier].push(blankCandidate())
        return next
      })
      setError("")
      setNotice("")
    }

    function removeCandidate(tier, index) {
      setDraft(function (previous) {
        var next = cloneTiers(previous)
        next[tier].splice(index, 1)
        return next
      })
      setError("")
      setNotice("")
    }

    async function save() {
      var serialized = serializeTiers(draft)
      var validationError = validateForSave(serialized, catalog)
      if (validationError) {
        setError(validationError)
        setNotice("")
        return
      }
      if (!scope || typeof scope.set !== "function") {
        setError("设置服务不可用，无法保存。")
        return
      }
      if (snapshot.writable === false) {
        setError("当前 settings 存储为只读，无法保存。")
        return
      }
      try {
        await scope.set("tiers", serialized)
        var confirmed = typeof scope.getSnapshot === "function" ? scope.getSnapshot() : null
        var confirmedTiers = serializeTiers(normalizeTiers(confirmed && confirmed.value && confirmed.value.tiers))
        if (!sameJson(confirmedTiers, serialized)) {
          setNotice("")
          setError("保存未被宿主接受或发生冲突；已恢复到最新配置，请检查后重试。")
          return
        }
        setError("")
        setNotice("已提交保存；宿主确认后会自动热更新。")
      } catch (saveError) {
        setNotice("")
        setError("保存失败：" + String(saveError?.message ?? saveError))
      }
    }

    var status = snapshot.status === "ready" ? null : h("p", {
      role: "status",
      style: { color: "#666" },
    }, snapshot.status === "loading" ? "正在读取全局设置…" : "全局设置当前不可用。")
    var serializedDraft = serializeTiers(draft)
    var saveValidationError = validateForSave(serializedDraft, catalog)
    var catalogStatus = catalog.status === "loading" ? h("p", {
      role: "status",
      style: { color: "#666" },
    }, "正在读取 Provider 列表…") : (catalog.modelStatus === "loading" ? h("p", {
      role: "status",
      style: { color: "#666" },
    }, "正在读取模型目录；目录完成加载后才可验证并保存。") : null)
    var catalogError = catalog.status === "error" ? h("p", {
      role: "alert",
      style: { color: "#b42318" },
    }, "Provider 列表读取失败：" + catalog.error) : (catalog.modelStatus === "error" ? h("p", {
      role: "alert",
      style: { color: "#b42318" },
    }, "模型目录读取失败：" + catalog.modelError + "。请恢复模型目录服务后重试。") : null)
    var failureText = catalog.failures.length > 0 ? h("p", {
      role: "alert",
      style: { color: "#b42318" },
    }, "部分 Provider 的模型目录不可用；选择受影响的 Provider 前请恢复其模型目录后重试。") : null

    return h("section", {
      "data-tw-settings": "tiers",
      style: { display: "grid", gap: "12px" },
    },
    h("h3", null, "团队档位模型"),
    h("p", null, "为 junior、senior、expert 配置候选模型。Provider 必须处于 active；每个候选都必须能在该 Provider 的可验证模型目录中找到。"),
    status,
    catalogStatus,
    catalogError,
    failureText,
    TIER_ORDER.map(function (tier) {
      return renderTier(React, tier, draft[tier], catalog, updateCandidate, addCandidate, removeCandidate)
    }),
    error ? h("p", { role: "alert", style: { color: "#b42318" } }, error) : null,
    notice ? h("p", { role: "status", style: { color: "#067647" } }, notice) : null,
    h("button", {
      type: "button",
      "data-tw-action": "save-tiers",
      onClick: save,
      disabled: snapshot.status !== "ready" || snapshot.writable === false || !!saveValidationError,
    }, "保存配置"))
  }

  function renderTier(React, tier, candidates, catalog, updateCandidate, addCandidate, removeCandidate) {
    var h = React.createElement
    var rows = Array.isArray(candidates) ? candidates : []
    return h("fieldset", {
      key: tier,
      "data-tw-tier": tier,
      style: { border: "1px solid #ddd", padding: "12px" },
    },
    h("legend", null, tier + "：" + TIER_TEXT[tier]),
    rows.map(function (candidate, index) {
      return renderCandidate(React, tier, index, candidate, catalog, updateCandidate, removeCandidate)
    }),
    rows.length === 0 ? h("p", { style: { color: "#8a5b00" } }, "尚无候选；请新增一行。") : null,
    h("button", {
      type: "button",
      "data-tw-action": "add-candidate",
      onClick: function () { addCandidate(tier) },
    }, "新增候选"))
  }

  function renderCandidate(React, tier, index, candidate, catalog, updateCandidate, removeCandidate) {
    var h = React.createElement
    var providerId = listId("providers", tier, index)
    var modelId = listId("models", tier, index)
    var effortId = listId("efforts", tier, index)
    var activeProviders = catalog.providers.filter(function (provider) { return provider.active === true })
    var models = modelsFor(catalog, candidate.provider)
    var efforts = effortsFor(catalog, candidate.provider, candidate.model)
    var warning = candidateValidationError(catalog, candidate, "当前候选")
    return h("div", {
      key: tier + "-" + index,
      "data-tw-candidate": tier + "-" + index,
      style: { display: "grid", gap: "8px", padding: "8px 0" },
    },
    h("label", null, "Provider（active，必填）",
      h("input", {
        value: candidate.provider,
        list: providerId,
        onChange: function (event) { updateCandidate(tier, index, "provider", event.target.value) },
      }),
      h("datalist", { id: providerId }, activeProviders.map(function (provider) {
        return h("option", { key: provider.provider, value: provider.provider }, provider.displayName || provider.provider)
      }))),
    h("label", null, "模型（必填）",
      h("input", {
        value: candidate.model,
        list: modelId,
        onChange: function (event) { updateCandidate(tier, index, "model", event.target.value) },
      }),
      h("datalist", { id: modelId }, models.map(function (model) {
        return h("option", { key: model.id, value: model.id }, model.name || model.id)
      }))),
    h("label", null, "推理等级（可选）",
      h("input", {
        value: candidate.effort,
        list: effortId,
        onChange: function (event) { updateCandidate(tier, index, "effort", event.target.value) },
      }),
      h("datalist", { id: effortId }, efforts.map(function (effort) {
        return h("option", { key: effort.id, value: effort.id }, effort.name || effort.id)
      }))),
    warning ? h("p", { style: { color: "#8a5b00" } }, warning) : null,
    h("button", {
      type: "button",
      "data-tw-action": "remove-candidate",
      onClick: function () { removeCandidate(tier, index) },
    }, "删除候选"))
  }

  function useSettingsSnapshot(React, scope) {
    var state = React.useState(function () {
      return scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot() : { status: "unavailable", writable: false }
    })
    var snapshot = state[0]
    var setSnapshot = state[1]
    React.useEffect(function () {
      if (!scope || typeof scope.getSnapshot !== "function") return
      var sync = function () { setSnapshot(scope.getSnapshot()) }
      sync()
      return typeof scope.subscribe === "function" ? scope.subscribe(sync) : undefined
    }, [scope])
    return snapshot
  }

  function useModelCatalog(React, ctx) {
    var state = React.useState({
      status: "loading",
      providers: [],
      groups: [],
      failures: [],
      error: "",
      modelStatus: "loading",
      modelError: "",
    })
    var catalog = state[0]
    var setCatalog = state[1]
    React.useEffect(function () {
      var cancelled = false
      var connection = getService(ctx, "connection")
      var api = connection && connection.api
      if (!api || !api.llm || typeof api.llm.providers !== "function") {
        setCatalog({
          status: "error",
          providers: [],
          groups: [],
          failures: [],
          error: "Provider 列表接口不可用",
          modelStatus: "error",
          modelError: "模型目录接口不可用",
        })
        return
      }
      Promise.resolve(api.llm.providers({})).then(function (response) {
        if (cancelled) return
        var providerValue = unwrapRpc(response)
        var providers = Array.isArray(providerValue.providers) ? providerValue.providers : []
        var ready = {
          status: "ready",
          providers: providers,
          groups: [],
          failures: [],
          error: "",
          modelStatus: "loading",
          modelError: "",
        }
        setCatalog(ready)
        if (typeof api.llm.models !== "function") {
          setCatalog({ ...ready, modelStatus: "error", modelError: "模型目录接口不可用" })
          return
        }
        Promise.resolve(api.llm.models({})).then(function (modelResponse) {
          if (cancelled) return
          var modelValue = unwrapRpc(modelResponse)
          setCatalog({
            ...ready,
            groups: Array.isArray(modelValue.groups) ? modelValue.groups : [],
            failures: Array.isArray(modelValue.failures) ? modelValue.failures : [],
            modelStatus: "ready",
          })
        }).catch(function (error) {
          if (cancelled) return
          setCatalog({
            ...ready,
            modelStatus: "error",
            modelError: String(error?.message ?? error),
          })
        })
      }).catch(function (error) {
        if (cancelled) return
        setCatalog({
          status: "error",
          providers: [],
          groups: [],
          failures: [],
          error: String(error?.message ?? error),
          modelStatus: "error",
          modelError: "未读取 Provider，无法请求模型目录",
        })
      })
      return function () { cancelled = true }
    }, [ctx])
    return catalog
  }

  function unwrapRpc(response) {
    var result = response && (response.result || response)
    if (result && result.ok === false) throw new Error(result.error?.message || result.message || "请求被拒绝")
    return result && result.value !== undefined ? result.value : (result || {})
  }

  function blankCandidate() {
    return { provider: "", model: "", effort: "" }
  }

  function normalizeCandidate(value) {
    var source = value && typeof value === "object" && !Array.isArray(value) ? value : {}
    var candidate = {
      provider: typeof source.provider === "string" ? source.provider : "",
      model: typeof source.model === "string" ? source.model : "",
      effort: typeof source.effort === "string" ? source.effort : "",
    }
    if (typeof source.family === "string" && source.family) candidate.family = source.family
    return candidate
  }

  function normalizeTiers(value) {
    var source = value && typeof value === "object" && !Array.isArray(value) ? value : {}
    var normalized = {}
    TIER_ORDER.forEach(function (tier) {
      var raw = source[tier]
      var rows = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? [raw] : [])
      normalized[tier] = rows.length > 0 ? rows.map(normalizeCandidate) : [blankCandidate()]
    })
    return normalized
  }

  function cloneTiers(value) {
    var cloned = {}
    TIER_ORDER.forEach(function (tier) {
      cloned[tier] = (Array.isArray(value && value[tier]) ? value[tier] : []).map(function (candidate) {
        return { ...candidate }
      })
    })
    return cloned
  }

  function serializeTiers(value) {
    var serialized = {}
    TIER_ORDER.forEach(function (tier) {
      serialized[tier] = (Array.isArray(value && value[tier]) ? value[tier] : []).map(function (candidate) {
        var next = {
          provider: String(candidate.provider || "").trim(),
          model: String(candidate.model || "").trim(),
        }
        var effort = String(candidate.effort || "").trim()
        if (effort) next.effort = effort
        var family = String(candidate.family || "").trim()
        if (family) next.family = family
        return next
      })
    })
    return serialized
  }

  function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right)
  }

  function validateForSave(tiers, catalog) {
    for (var tierIndex = 0; tierIndex < TIER_ORDER.length; tierIndex += 1) {
      var tier = TIER_ORDER[tierIndex]
      var candidates = tiers[tier]
      if (!Array.isArray(candidates) || candidates.length === 0) return tier + " 至少需要一个候选。"
      for (var index = 0; index < candidates.length; index += 1) {
        var candidate = candidates[index]
        var label = tier + " 第 " + (index + 1) + " 个候选"
        var reason = candidateValidationError(catalog, candidate, label)
        if (reason) return reason
      }
    }
    return null
  }

  function modelsFor(catalog, provider) {
    var group = catalog.groups.find(function (item) { return item.id === provider })
    return group && Array.isArray(group.models) ? group.models : []
  }

  function modelFor(catalog, provider, model) {
    return modelsFor(catalog, provider).find(function (item) { return item.id === model })
  }

  function effortsFor(catalog, provider, model) {
    var item = modelFor(catalog, provider, model)
    return item && item.reasoning && Array.isArray(item.reasoning.efforts) ? item.reasoning.efforts : []
  }

  function candidateValidationError(catalog, candidate, label) {
    var providerId = String(candidate && candidate.provider || "").trim()
    var modelId = String(candidate && candidate.model || "").trim()
    var effortId = String(candidate && candidate.effort || "").trim()
    if (!providerId) return label + " 的 Provider 为必填项。"
    if (!modelId) return label + " 的模型为必填项。"
    if (catalog.status !== "ready") return label + " 无法确认 Provider 是否处于 active 状态；请恢复 Provider 列表后重试。"
    var provider = catalog.providers.find(function (item) { return item.provider === providerId })
    if (!provider || provider.active !== true) return label + " 的 Provider 未处于 active 状态。"
    if (catalog.modelStatus !== "ready") {
      if (catalog.modelStatus === "loading") return label + " 正在等待模型目录；目录加载完成后再保存。"
      return label + " 的模型目录不可用；请恢复模型目录后重试。"
    }
    var failure = catalogFailureFor(catalog, providerId)
    if (failure) return label + " 的 Provider 模型目录读取失败：" + failure + "。请恢复该 Provider 的模型目录后重试。"
    var group = catalog.groups.find(function (item) { return item && item.id === providerId && Array.isArray(item.models) })
    if (!group) return label + " 的 Provider 没有可验证的模型目录；请恢复该 Provider 的模型目录后重试。"
    var model = modelFor(catalog, providerId, modelId)
    if (!model) return label + " 的模型不在该 Provider 的可验证目录中；请选择目录内模型后重试。"
    var knownEfforts = model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : null
    if (effortId && knownEfforts && knownEfforts.length > 0 && !knownEfforts.some(function (effort) { return effort.id === effortId })) {
      return label + " 的推理等级不在该模型公开的选项中。"
    }
    return null
  }

  function catalogFailureFor(catalog, providerId) {
    var failure = catalog.failures.find(function (item) {
      return item && (item.provider === providerId || item.providerId === providerId || item.id === providerId)
    })
    if (!failure) return ""
    return String(failure.message || failure.error || "模型目录请求失败")
  }

  function listId(kind, tier, index) {
    return "tw-" + kind + "-" + tier + "-" + index
  }

  function modelFromSession(session) {
    if (!session) return null
    try {
      var trajectory = session.views && session.views.get && session.views.get("trajectory")
      var requests = trajectory && trajectory.requests
      var fromRequests = modelFromRows(requests, "assistant")
      if (fromRequests) return fromRequests
    } catch (error) { /* 可选 trajectory view 不可用时回退 chat */ }
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

  function useSessionModel(React, ctx, sessionId, refreshToken) {
    var state = React.useState(null)
    var value = state[0]
    var setValue = state[1]
    React.useEffect(function () {
      if (!sessionId) return
      var cancelled = false
      try {
        var connection = getService(ctx, "connection")
        var api = connection && connection.api
        if (!api || !api.sessions || !api.sessions.models) return
        api.sessions.models({ sessionId: sessionId }).then(function (response) {
          if (cancelled) return
          var result = response && (response.result || response)
          var current = result && result.ok === true ? result.value : result
          setValue((current && current.current) || null)
        }).catch(function () { /* RPC 失败时保留会话事实或暂不渲染 */ })
      } catch (error) { /* 同步失败时保留会话事实或暂不渲染 */ }
      return function () { cancelled = true }
    }, [sessionId, refreshToken])
    return value
  }

  return { apply: apply, inject: inject }
}

var api = (typeof window !== "undefined" ? window : globalThis).__ModuleLoader__
if (api && api.load) {
  api.load({ id: "team-work-runtime-dsh", factory: factory })
  api.load({ id: "team-work-runtime", factory: factory })
}
