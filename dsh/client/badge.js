// badge.js — DSH Web client bundle：子代理模型席位徽标与全局 tiers 配置卡。
// 文件本身是宿主加载的 CJS 工厂产物；React 由宿主模块空间提供。
var factory = function (require) {
  var controls
  try { controls = require("@deepseek-ai/dsh-client-ui-primitives") } catch (error) { controls = {} }
  var Input = controls.Input || "input"
  var Button = controls.Button || "button"
  var BADGE_SLOT = "conversation.input.right"
  var SETTINGS_SLOT = "plugins.bundle.config"
  var SETTINGS_NS = "team-work-dsh"
  var TIER_ORDER = ["junior", "senior", "expert"]
  var TIER_TEXT = {
    junior: "低成本的只读探索与常规辅助工作。",
    senior: "常规实现、复核与需要稳定判断的工作。",
    expert: "核心场景、技术裁决与高失败成本工作。",
  }
  // 档位价值说明与原生委派指引。
  var TIER_TRIGGER_TEXT = {
    junior: "足以负担大部分基础工作；速度优势显著、单位成本最低——批量探索、信息收集、格式化整理、初稿类工作的默认选择。",
    senior: "平衡档：推理能力与解题率不错，综合能力对比 expert 略有不足，但价格优势明显、性价比高——大多数常规开发任务的默认选择。",
    expert: "最强推理能力、高解题率、低错误率；价格与执行耗时都最贵——只在高难度设计、疑难定位、关键技术裁决时使用。",
  }
  var SETTINGS_CSS = [
    ".tw-settings-body{container-type:inline-size;font-family:inherit}",
    ".tw-settings-overview{margin:0;padding:12px 0;color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;line-height:18px}",
    ".tw-settings-tier{display:flex;flex-direction:column;gap:10px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2,#e1e5ee)}",
    ".tw-settings-tier-head{display:flex;flex-direction:column;gap:3px}",
    ".tw-settings-tier-name{margin:0;color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;font-weight:500;line-height:20px}",
    ".tw-settings-hint{margin:0;color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;line-height:18px}",
    ".tw-settings-candidate{display:flex;flex-direction:column;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#e1e5ee);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff)}",
    ".tw-settings-candidate-head{display:flex;align-items:center;gap:8px}",
    ".tw-settings-candidate-name{flex:1;color:var(--dsw-alias-label-secondary,#5f636b);font-size:12px;font-weight:500;line-height:18px}",
    ".tw-settings-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}",
    ".tw-settings-field{display:flex;flex-direction:column;gap:6px;min-width:0;color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;font-weight:500;line-height:20px}",
    ".tw-settings-input{width:100%;min-width:0}",
    ".tw-settings-add{align-self:flex-start}",
    ".tw-settings-message{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);font-size:12px;line-height:18px}",
    ".tw-settings-status{color:var(--dsw-alias-label-tertiary,#81858c)}",
    ".tw-settings-warning{color:var(--dsw-alias-state-warn-primary,#9a6700)}",
    ".tw-settings-error{color:var(--dsw-alias-state-error-primary,#b42318)}",
    ".tw-settings-success{color:var(--dsw-alias-state-success-primary,#067647)}",
    ".tw-settings-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2,#e1e5ee)}",
    "@container (max-width:460px){.tw-settings-fields{grid-template-columns:minmax(0,1fr)}}",
  ].join("")
  // 每项功能单独等待自己的服务，缺少可选服务不阻塞整个客户端。
  var inject = {}

  function getService(ctx, name) {
    // Cordis 对 ctx.<service> 实施 inject 属性守卫；可选服务必须先走 ctx.get，
    // 否则还没进入“缺失时降级”分支就会抛 without inject。普通对象仅供测试兜底。
    if (ctx && typeof ctx.get === "function") return ctx.get(name)
    return ctx && ctx[name]
  }

  function warn(ctx, message) {
    ctx.logger?.warn?.("team-work-dsh: " + message)
  }

  function apply(ctx) {
    var disposers = []
    function feature(names, install) {
      if (typeof ctx.inject === "function") {
        var fiber = ctx.inject(names, (child) => install(child))
        disposers.push(function () { return fiber.dispose() })
      } else if (names.every(function (name) { return !!getService(ctx, name) })) {
        disposers.push(install(ctx))
      }
    }
    feature(["inputTriggers"], registerTierTriggers)
    var React
    try { React = require("react") } catch (error) {
      warn(ctx, "react 不可解析，Web 扩展停用")
      return cleanup
    }
    feature(["slots", "sessions"], function (child) { return registerBadge(child, React) })
    feature(["slots", "configForms"], function (child) { return registerTierSettings(child, React) })
    return cleanup
    function cleanup() {
      return Promise.all(disposers.splice(0).map(function (dispose) { if (typeof dispose === "function") return dispose() }))
    }
  }

  // 候选只记录档位意图，提交时读取当前已保存配置。
  function registerTierTriggers(ctx) {
    var inputTriggers = getService(ctx, "inputTriggers")
    if (!inputTriggers || typeof inputTriggers.registerSource !== "function") {
      warn(ctx, "inputTriggers 不可用，跳过 @ 档位候选")
      return
    }
    try {
      return inputTriggers.registerSource({
        trigger: "@",
        name: "team-work 档位",
        order: 100,
        candidates: function (_session, req) {
          var query = String((req && req.query) || "").toLowerCase()
          // 宿主契约：candidates 必须返回 Promise（InputTriggerController 直接调 .then），
          // 同步数组会在 fetchCandidates 抛 TypeError 并炸掉整个 @ 菜单。
          return Promise.resolve(
            TIER_ORDER
              .filter(function (tier) { return query === "" || tier.indexOf(query) === 0 })
              .map(function (tier) {
                return { name: tier, description: TIER_TRIGGER_TEXT[tier] }
              })
          )
        },
        onPick: function (pick) {
          var name = pick && pick.candidate && pick.candidate.name
          if (TIER_ORDER.indexOf(name) < 0) return { text: "" }
          // insert 形态：与文件/会话引用一致的标记 chip（有 occurrence 身份与 range），
          // 提交时经 codec 序列化为模型可读的委派指令（而非把提示词写进输入框）。
          return { insert: {
            source: "tw-tier",
            ref: "@" + name,
            label: name,
            appearance: "session",
            clipboardText: "@" + name,
          } }
        },
        codec: {
          clipboardText: function (ref) { return ref },
          serialize: function (ref) {
            var tier = String(ref).replace(/^@/, "")
            var forms = getService(ctx, "configForms")
            var form = forms && forms.get(SETTINGS_NS)
            var snapshot = form && form.getSnapshot()
            var raw = snapshot && snapshot.value && snapshot.value.tiers && snapshot.value.tiers[tier]
            var candidate = Array.isArray(raw) ? raw[0] : raw
            if (snapshot?.status !== "ready" || !candidate?.provider || !candidate?.model) {
              return Promise.resolve("[委派 " + ref + "] unresolved：当前 profile 的该档位未配置完整 provider/model；请在插件配置页修复后再委派。")
            }
            var params = { provider: candidate.provider, model: candidate.model }
            if (candidate.effort) params.reasoning_effort = candidate.effort
            return Promise.resolve("[委派 " + ref + "] 请使用原生 subagent（继承历史时 subagent_fork），精确参数 " + JSON.stringify(params) + "。先通过 list_subagent_models 确认路由；目录未列出时按 provider+model 精确查询，区分权限拒绝与解析失败，禁止改用默认模型。需要续聊时后台模式必须为 continuable，仅 subagentId 可用于 send_message；不要把 jobId/runId 当作会话 ID，不自动修改宿主开关或允许列表。")
          },
        },
        lexicon: function () { return TIER_ORDER.slice() },
      })
    } catch (error) {
      warn(ctx, "@ 档位候选注册失败：" + String(error?.message ?? error))
    }
  }

  function registerBadge(ctx, React) {
    try {
      var sessions = getService(ctx, "sessions")
      var slots = getService(ctx, "slots")
      return slots.inject(BADGE_SLOT, function () {
        return slots.register({
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
          // 新版 slot kit 提供会话事实和模型选择投影；不从 tiers 推测实际模型。
          var useSessionHook = props && typeof props.useSession === "function" ? props.useSession : null
          var useProjectionHook = props && typeof props.useProjection === "function" ? props.useProjection : null
          var session = props && props.session
          var address = useSessionHook
            ? useSessionHook(function (s) { return s && s.subagent ? s.subagent.address : null })
            : (session && session.subagent && session.subagent.address)
          var running = useSessionHook
            ? useSessionHook(function (s) { return s ? s.running : undefined })
            : (session && session.running)
          var isSubagent = !!address || !!(props && props.addressed)
          var projected = useProjectionHook
            ? normalizeSelection(useProjectionHook("modelSelection", function (snap) { return snap && (snap.lastUsed ?? snap.next) }))
            : null
          var selected = useSessionModel(React, ctx, isSubagent ? props.sessionId : null, running)
          var current = isSubagent ? (modelFromSession(session) || projected || selected) : null
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
    var forms = getService(ctx, "configForms")
    var slots = getService(ctx, "slots")
    function register() {
      var form = forms.get(SETTINGS_NS)
      return slots.inject(SETTINGS_SLOT, function () {
        return slots.register({
          name: SETTINGS_SLOT,
          key: "team-work-runtime",
          id: "team-work-dsh-tiers",
          inject: function () { return { form: form } },
        }, function TierSettings(props) {
          return renderTierSettings(ctx, React, props)
        })
      })
    }
    // 服务拥有共享表单；客户端只释放自己的注册与订阅，不 dispose 共享表单。
    if (typeof ctx.effect === "function") {
      return ctx.effect(function () { return forms.whileServed([SETTINGS_NS], register) }, "team-work 档位配置")
    }
    return forms.whileServed([SETTINGS_NS], register)
  }

  function renderTierSettings(ctx, React, props) {
    var h = React.createElement
    var form = props && props.form
    var snapshot = useSettingsSnapshot(React, form)
    var editorState = React.useState(function () {
      return { draft: normalizeTiers(snapshot.value?.tiers), revision: snapshot.revision, dirty: false }
    })
    var editor = editorState[0]
    var setEditor = editorState[1]
    React.useEffect(function () {
      setEditor(function (previous) {
        if (previous.dirty) return previous
        return { draft: normalizeTiers(snapshot.value?.tiers), revision: snapshot.revision, dirty: false }
      })
    }, [snapshot.revision, snapshot.status, snapshot.value])
    var draft = editor.draft
    var catalog = useModelCatalog(React, ctx)
    var errorState = React.useState("")
    var error = errorState[0]
    var setError = errorState[1]
    var noticeState = React.useState("")
    var notice = noticeState[0]
    var setNotice = noticeState[1]
    var savingState = React.useState(false)
    var saving = savingState[0]
    var setSaving = savingState[1]

    function edit(change) {
      setEditor(function (previous) {
        var next = cloneTiers(previous.draft)
        change(next)
        return { draft: next, revision: previous.revision, dirty: true }
      })
      setError("")
      setNotice("")
    }
    function updateCandidate(tier, index, field, value) {
      edit(function (next) { next[tier][index][field] = value })
    }
    function addCandidate(tier) {
      edit(function (next) { next[tier].push(blankCandidate()) })
    }
    function removeCandidate(tier, index) {
      edit(function (next) { next[tier].splice(index, 1) })
    }
    function reload() {
      setEditor({ draft: normalizeTiers(snapshot.value?.tiers), revision: snapshot.revision, dirty: false })
      setError("")
      setNotice("")
    }
    async function save() {
      if (saving) return
      var serialized = serializeTiers(draft)
      var reason = validateForSave(serialized, catalog)
      if (reason) { setError(reason); setNotice(""); return }
      if (!form || snapshot.status !== "ready" || snapshot.writable !== true || editor.revision === undefined) {
        setError("当前 profile 配置不可写或尚未读取版本，无法保存。")
        return
      }
      setSaving(true)
      setNotice("")
      try {
        // 确认当前注册表，不能把打开页面时的旧目录当成保存时的可用性证明。
        var freshReason = validateForSave(serialized, await readModelCatalog(ctx))
        if (freshReason) { setError(freshReason + " 草稿已保留。"); return }
        var accepted = await form.mutate([{ op: "set", path: ["tiers"], value: serialized }], editor.revision)
        var confirmed = form.getSnapshot()
        var confirmedTiers = serializeTiers(normalizeTiers(confirmed?.value?.tiers))
        if (accepted !== true || confirmed?.status !== "ready" || !sameJson(confirmedTiers, serialized)) {
          setError("保存未被宿主确认，或配置已被其他页面更新；草稿已保留。请核对当前 profile 后重新载入。")
          return
        }
        setEditor({ draft: normalizeTiers(confirmed.value.tiers), revision: confirmed.revision, dirty: false })
        setError("")
        setNotice("已保存并由宿主确认；后续派单使用新配置。")
      } catch (saveError) {
        setError("保存失败，草稿已保留：" + String(saveError?.message ?? saveError))
      } finally { setSaving(false) }
    }
    var conflict = editor.dirty && editor.revision !== snapshot.revision
    var saveReason = validateForSave(serializeTiers(draft), catalog)
    return h("div", { "data-tw-settings": "tiers", className: "tw-settings-body" },
      h("style", { "data-tw-settings-style": "tiers" }, SETTINGS_CSS),
      h("p", { className: "tw-settings-overview" }, "当前 profile 内所有项目共用三档候选。Provider 和模型必填，推理等级可选；省略推理等级时采用宿主解析结果。tiers 管理正式团队派发策略，原生允许列表管理普通委派权限，插件不修改该列表。"),
      snapshot.status !== "ready" ? h("p", { role: "status" }, "正在读取 profile 配置…") : null,
      catalog.status === "loading" || catalog.modelStatus === "loading" ? h("p", { role: "status" }, "正在读取 Provider 和模型目录…") : null,
      catalog.error || catalog.modelError ? h("p", { role: "alert", className: "tw-settings-message tw-settings-error" }, "目录读取失败：" + (catalog.error || catalog.modelError)) : null,
      saveReason ? h("p", { role: "status", className: "tw-settings-hint tw-settings-warning" }, saveReason) : null,
      conflict ? h("p", { role: "alert", className: "tw-settings-message tw-settings-warning" }, "配置已被其他页面更新；本地草稿与开始编辑时的版本已保留。") : null,
      TIER_ORDER.map(function (tier) { return renderTier(React, tier, draft[tier], catalog, updateCandidate, addCandidate, removeCandidate) }),
      error ? h("p", { role: "alert", className: "tw-settings-message tw-settings-error" }, error) : null,
      notice ? h("p", { role: "status", className: "tw-settings-message tw-settings-success" }, notice) : null,
      h("div", { className: "tw-settings-footer" },
        h(Button, { type: "button", className: "tw-settings-button", "data-tw-action": "reload-tiers", onClick: reload, disabled: saving }, "重新载入（放弃草稿）"),
        h(Button, { type: "button", variant: "primary", className: "tw-settings-button tw-settings-save", "data-tw-action": "save-tiers", onClick: save, disabled: saving || snapshot.status !== "ready" || snapshot.writable !== true || !!saveReason }, saving ? "保存中…" : "保存")
      )
    )
  }

  function renderTier(React, tier, candidates, catalog, updateCandidate, addCandidate, removeCandidate) {
    var h = React.createElement
    var rows = Array.isArray(candidates) ? candidates : []
    return h("section", {
      key: tier,
      "data-tw-tier": tier,
      className: "tw-settings-tier",
    },
    h("div", { className: "tw-settings-tier-head" },
      h("h3", { className: "tw-settings-tier-name" }, tier),
      h("p", { className: "tw-settings-hint" }, TIER_TEXT[tier])
    ),
    rows.map(function (candidate, index) {
      return renderCandidate(React, tier, index, candidate, catalog, updateCandidate, removeCandidate)
    }),
    rows.length === 0 ? h("p", { className: "tw-settings-message tw-settings-warning" }, "尚无候选；请新增一行。") : null,
    h(Button, {
      type: "button",
      className: "tw-settings-button tw-settings-add",
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
      className: "tw-settings-candidate",
    },
    h("div", { className: "tw-settings-candidate-head" },
      h("span", { className: "tw-settings-candidate-name" }, "候选 " + (index + 1)),
      h(Button, {
        type: "button",
        className: "tw-settings-button tw-settings-remove",
        "data-tw-action": "remove-candidate",
        onClick: function () { removeCandidate(tier, index) },
      }, "删除")
    ),
    h("div", { className: "tw-settings-fields" },
    h("label", { className: "tw-settings-field" }, "Provider（active，必填）",
      h(Input, {
        className: "tw-settings-input",
        value: candidate.provider,
        list: providerId,
        onChange: function (event) { updateCandidate(tier, index, "provider", event.target.value) },
      }),
      h("datalist", { id: providerId }, activeProviders.map(function (provider) {
        return h("option", { key: provider.provider, value: provider.provider }, provider.displayName || provider.provider)
      }))),
    h("label", { className: "tw-settings-field" }, "模型（必填）",
      h(Input, {
        className: "tw-settings-input",
        value: candidate.model,
        list: modelId,
        onChange: function (event) { updateCandidate(tier, index, "model", event.target.value) },
      }),
      h("datalist", { id: modelId }, models.map(function (model) {
        return h("option", { key: model.id, value: model.id }, model.name || model.id)
      }))),
    h("label", { className: "tw-settings-field" }, "推理等级（可选）",
      h(Input, {
        className: "tw-settings-input",
        value: candidate.effort,
        list: effortId,
        onChange: function (event) { updateCandidate(tier, index, "effort", event.target.value) },
      }),
      h("datalist", { id: effortId }, efforts.map(function (effort) {
        return h("option", { key: effort.id, value: effort.id }, effort.name || effort.id)
      })))
    ),
    warning ? h("p", { className: "tw-settings-hint tw-settings-warning" }, warning) : null)
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

  async function readModelCatalog(ctx) {
    var llm = getService(ctx, "remote.llm")
    var session = getService(ctx, "remote.session")
    if (!llm || typeof llm.listProviders !== "function") throw new Error("Provider 列表接口不可用")
    var providerValue = unwrapRpc(await llm.listProviders())
    var ready = {
      status: "ready",
      providers: (Array.isArray(providerValue) ? providerValue : []).map(function (entry) {
        return { provider: entry.id, displayName: entry.name, active: true }
      }),
      groups: [], failures: [], error: "", modelStatus: "error", modelError: "",
    }
    try {
      if (!session || typeof session.modelCatalog !== "function") throw new Error("模型目录接口不可用")
      var modelValue = unwrapRpc(await session.modelCatalog())
      return { ...ready, groups: Array.isArray(modelValue.groups) ? modelValue.groups : [], failures: Array.isArray(modelValue.failures) ? modelValue.failures : [], modelStatus: "ready" }
    } catch (error) {
      return { ...ready, modelError: String(error?.message ?? error) }
    }
  }

  function useModelCatalog(React, ctx) {
    var state = React.useState({ status: "loading", providers: [], groups: [], failures: [], error: "", modelStatus: "loading", modelError: "" })
    var catalog = state[0]
    var setCatalog = state[1]
    React.useEffect(function () {
      var cancelled = false
      readModelCatalog(ctx).then(function (current) { if (!cancelled) setCatalog(current) }).catch(function (error) {
        if (!cancelled) setCatalog({ status: "error", providers: [], groups: [], failures: [], error: String(error?.message ?? error), modelStatus: "error", modelError: "未读取 Provider，无法确认模型目录" })
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
    if (!model) return label + " 尚未验证：目录未列出该模型，宿主无精确只读校验 RPC。草稿保留；请使用原生 list_subagent_models 按 provider+model 精确查询，区分权限与解析问题。未列出不代表不存在或不允许。"
    var knownEfforts = model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : null
    if (effortId && (!knownEfforts || !knownEfforts.some(function (effort) { return effort.id === effortId }))) {
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

  // 新版模型投影规范形：provider/model/reasoningEffort。
  function normalizeSelection(value) {
    if (!value || typeof value !== "object") return null
    if (typeof value.provider !== "string" || !value.provider) return null
    if (typeof value.model !== "string" || !value.model) return null
    return {
      provider: value.provider,
      model: value.model,
      ...(typeof value.reasoningEffort === "string" && value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}),
    }
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
        var session = getService(ctx, "remote.session")
        if (!session?.projections) return
        session.projections({ sessionId: sessionId }).then(function (response) {
          if (cancelled) return
          var baseline = unwrapRpc(response)
          var selection = baseline?.values?.modelSelection
          setValue(normalizeSelection(selection && (selection.lastUsed ?? selection.next)))
        }).catch(function () { /* 读取失败时保留会话事实 */ })
      } catch (error) { /* 同步失败时保留会话事实或暂不渲染 */ }
      return function () { cancelled = true }
    }, [sessionId, refreshToken])
    return value
  }

  // Cordis 把带 prototype 的普通函数当构造器；箭头入口确保返回的 disposer 被收集。
  return { apply: (ctx) => apply(ctx), inject: inject }
}

var api = (typeof window !== "undefined" ? window : globalThis).__ModuleLoader__
if (api && api.load) {
  api.load({ id: "team-work-runtime", factory: factory })
}
