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
  // @ 候选的一句话价值主张（方案 §3.5/§3.7）：与 dsh/tw-tool-subagent.js 的 TIER_VALUE_PROPS 字面同文，
  // 由 tests/dsh-tw-tool-subagent.test.mjs 对齐校验（浏览器 bundle 无法 require host 模块，只能内联副本）。
  var TIER_TRIGGER_TEXT = {
    junior: "足以负担大部分基础工作；速度优势显著、单位成本最低——批量探索、信息收集、格式化整理、初稿类工作的默认选择。",
    senior: "平衡档：推理能力与解题率不错，综合能力对比 expert 略有不足，但价格优势明显、性价比高——大多数常规开发任务的默认选择。",
    expert: "最强推理能力、高解题率、低错误率；价格与执行耗时都最贵——只在高难度设计、疑难定位、关键技术裁决时使用。",
  }
  var SETTINGS_CSS = [
    ".tw-settings-card{border:1px solid var(--dsw-alias-border-l2,#e1e5ee);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:12px;list-style:none;color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;transition:border-color .16s,background .16s}",
    ".tw-settings-card:hover{border-color:var(--dsw-alias-label-dimmed,#c8ccd4)}",
    ".tw-settings-card-open{background:var(--dsw-alias-bg-layer-2,#f7f8fa);border-color:var(--dsw-alias-label-dimmed,#c8ccd4)}",
    ".tw-settings-header{appearance:none;width:100%;box-sizing:border-box;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}",
    ".tw-settings-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-2px}",
    ".tw-settings-head-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0}",
    ".tw-settings-name{color:var(--dsw-alias-label-primary,#0f1115);font-size:15px;font-weight:600;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".tw-settings-description{color:var(--dsw-alias-label-tertiary,#81858c);font-size:13px;line-height:1.5}",
    ".tw-settings-chevron{color:var(--dsw-alias-label-tertiary,#81858c);flex:none;display:inline-flex;transition:transform .16s}",
    ".tw-settings-chevron-open{transform:rotate(180deg)}",
    ".tw-settings-body{border-top:1px solid var(--dsw-alias-border-l2,#e1e5ee);margin:0 16px;padding:0 0 8px;container-type:inline-size}",
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
    ".tw-settings-input{appearance:none;width:100%;height:34px;box-sizing:border-box;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#e1e5ee);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:13px;font-weight:400;line-height:1.5;outline:none}",
    ".tw-settings-input:focus-visible{border-color:var(--dsw-alias-brand-primary,#4f6ef7)}",
    ".tw-settings-button{appearance:none;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#e1e5ee);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5f636b);cursor:pointer;font:inherit;font-size:13px;font-weight:400;line-height:19.5px;padding:5px 12px}",
    ".tw-settings-button:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#c8ccd4);color:var(--dsw-alias-label-primary,#0f1115)}",
    ".tw-settings-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px}",
    ".tw-settings-button:disabled{cursor:default;opacity:.45}",
    ".tw-settings-remove{border-color:transparent;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);padding:2px 6px;font-size:12px;line-height:18px}",
    ".tw-settings-add{align-self:flex-start}",
    ".tw-settings-message{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);font-size:12px;line-height:18px}",
    ".tw-settings-status{color:var(--dsw-alias-label-tertiary,#81858c)}",
    ".tw-settings-warning{color:var(--dsw-alias-state-warn-primary,#9a6700)}",
    ".tw-settings-error{color:var(--dsw-alias-state-error-primary,#b42318)}",
    ".tw-settings-success{color:var(--dsw-alias-state-success-primary,#067647)}",
    ".tw-settings-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2,#e1e5ee)}",
    ".tw-settings-save{border-color:transparent;background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-bg-layer-3,#fff);padding:5px 14px}",
    ".tw-settings-save:hover:not(:disabled){border-color:transparent;color:var(--dsw-alias-bg-layer-3,#fff)}",
    "@container (max-width:460px){.tw-settings-fields{grid-template-columns:minmax(0,1fr)}}",
  ].join("")
  // inputTriggers 必须显式声明：客户端 ctx 只注入已声明服务（对齐 dsh-client-ui-skill 的做法），
  // 未声明时 ctx.get 拿不到、@ 档位候选静默降级。DSH Web 宿主该服务为输入框内置能力。
  // remote/remote.llm/remote.session：最新版模型目录契约（listProviders + modelCatalog）；
  // connection 保留给子代理模型席位徽标的 sessions.models RPC。
  var inject = ["slots", "sessions", "connection", "remote", "remote.session", "remote.llm", "settingsScope", "inputTriggers"]

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
    registerTierTriggers(ctx)
    var React
    try { React = require("react") } catch (error) {
      warn(ctx, "react 不可解析，Web 扩展停用")
      return
    }
    registerBadge(ctx, React)
    registerTierSettings(ctx, React)
  }

  // @junior/@senior/@expert 档位候选（方案 §3.5）：选中后写入明确、可见的委派意图，
  // 不创建子代理、不保存 sessionId；Lead 补全任务后调用 tw-tool-subagent。
  // 客户端缺少 inputTriggers 时仅关闭候选（自然语言与工具调用不受影响，§3.2 尾段）。
  function registerTierTriggers(ctx) {
    var inputTriggers = getService(ctx, "inputTriggers")
    if (!inputTriggers || typeof inputTriggers.registerSource !== "function") {
      warn(ctx, "inputTriggers 不可用，跳过 @ 档位候选（自然语言与 tw-tool-subagent 工具调用不受影响）")
      return
    }
    try {
      inputTriggers.registerSource({
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
            return Promise.resolve("[委派 " + ref + "]（请以该档位调用 tw-tool-subagent 创建子代理）")
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
    var openState = React.useState(false)
    var open = openState[0]
    var setOpen = openState[1]
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
      className: "tw-settings-message tw-settings-status",
    }, snapshot.status === "loading" ? "正在读取全局设置…" : "全局设置当前不可用。")
    var serializedDraft = serializeTiers(draft)
    var saveValidationError = validateForSave(serializedDraft, catalog)
    var catalogStatus = catalog.status === "loading" ? h("p", {
      role: "status",
      className: "tw-settings-message tw-settings-status",
    }, "正在读取 Provider 列表…") : (catalog.modelStatus === "loading" ? h("p", {
      role: "status",
      className: "tw-settings-message tw-settings-status",
    }, "正在读取模型目录；目录完成加载后才可验证并保存。") : null)
    var catalogError = catalog.status === "error" ? h("p", {
      role: "alert",
      className: "tw-settings-message tw-settings-error",
    }, "Provider 列表读取失败：" + catalog.error) : (catalog.modelStatus === "error" ? h("p", {
      role: "alert",
      className: "tw-settings-message tw-settings-error",
    }, "模型目录读取失败：" + catalog.modelError + "。请恢复模型目录服务后重试。") : null)
    var failureText = catalog.failures.length > 0 ? h("p", {
      role: "alert",
      className: "tw-settings-message tw-settings-error",
    }, "部分 Provider 的模型目录不可用；选择受影响的 Provider 前请恢复其模型目录后重试。") : null

    return h("li", {
      "data-tw-settings": "tiers",
      className: open ? "tw-settings-card tw-settings-card-open" : "tw-settings-card",
    },
    h("style", { "data-tw-settings-style": "tiers" }, SETTINGS_CSS),
    h("button", {
      type: "button",
      className: "tw-settings-header",
      "aria-expanded": open,
      "aria-label": (open ? "收起设置: " : "展开设置: ") + "team-work-runtime",
      onClick: function () { setOpen(!open) },
    },
    h("span", { className: "tw-settings-head-text" },
      h("span", { className: "tw-settings-name" }, "team-work-runtime"),
      h("span", { className: "tw-settings-description" }, "为子代理配置团队档位模型。")
    ),
    h("span", {
      className: open ? "tw-settings-chevron tw-settings-chevron-open" : "tw-settings-chevron",
      "aria-hidden": "true",
    }, h("svg", { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
      h("path", { d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z", fill: "currentColor" }))
    )),
    open ? h("div", { className: "tw-settings-body" },
      h("p", { className: "tw-settings-overview" }, "为 junior、senior、expert 配置候选模型。Provider 和模型必填，推理等级可选；所有值都依据当前 DSH 模型目录校验。"),
      status,
      catalogStatus,
      catalogError,
      failureText,
      TIER_ORDER.map(function (tier) {
        return renderTier(React, tier, draft[tier], catalog, updateCandidate, addCandidate, removeCandidate)
      }),
      error ? h("p", { role: "alert", className: "tw-settings-message tw-settings-error" }, error) : null,
      notice ? h("p", { role: "status", className: "tw-settings-message tw-settings-success" }, notice) : null,
      h("div", { className: "tw-settings-footer" },
        h("button", {
          type: "button",
          className: "tw-settings-button tw-settings-save",
          "data-tw-action": "save-tiers",
          onClick: save,
          disabled: snapshot.status !== "ready" || snapshot.writable === false || !!saveValidationError,
        }, "保存")
      )
    ) : null)
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
    h("button", {
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
      h("button", {
        type: "button",
        className: "tw-settings-button tw-settings-remove",
        "data-tw-action": "remove-candidate",
        onClick: function () { removeCandidate(tier, index) },
      }, "删除")
    ),
    h("div", { className: "tw-settings-fields" },
    h("label", { className: "tw-settings-field" }, "Provider（active，必填）",
      h("input", {
        className: "tw-settings-input",
        value: candidate.provider,
        list: providerId,
        onChange: function (event) { updateCandidate(tier, index, "provider", event.target.value) },
      }),
      h("datalist", { id: providerId }, activeProviders.map(function (provider) {
        return h("option", { key: provider.provider, value: provider.provider }, provider.displayName || provider.provider)
      }))),
    h("label", { className: "tw-settings-field" }, "模型（必填）",
      h("input", {
        className: "tw-settings-input",
        value: candidate.model,
        list: modelId,
        onChange: function (event) { updateCandidate(tier, index, "model", event.target.value) },
      }),
      h("datalist", { id: modelId }, models.map(function (model) {
        return h("option", { key: model.id, value: model.id }, model.name || model.id)
      }))),
    h("label", { className: "tw-settings-field" }, "推理等级（可选）",
      h("input", {
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
      // 最新版宿主契约：remote.llm.listProviders()（active 路由目录）+ remote.session.modelCatalog()
      // （模型目录含 reasoning.efforts）；旧 connection.api.llm.providers/models 已随宿主移除。
      var remote = getService(ctx, "remote")
      var llm = remote && remote.llm
      var session = remote && remote.session
      if (!llm || typeof llm.listProviders !== "function") {
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
      Promise.resolve(llm.listProviders()).then(function (response) {
        if (cancelled) return
        var providerValue = unwrapRpc(response)
        var providers = (Array.isArray(providerValue) ? providerValue : []).map(function (entry) {
          return { provider: entry.id, displayName: entry.name, active: true }
        })
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
        if (!session || typeof session.modelCatalog !== "function") {
          setCatalog({ ...ready, modelStatus: "error", modelError: "模型目录接口不可用" })
          return
        }
        Promise.resolve(session.modelCatalog()).then(function (catalogResponse) {
          if (cancelled) return
          var catalogValue = unwrapRpc(catalogResponse)
          setCatalog({
            ...ready,
            groups: Array.isArray(catalogValue.groups) ? catalogValue.groups : [],
            failures: (Array.isArray(catalogValue.failures) ? catalogValue.failures : []).map(function (entry) {
              return { provider: entry.id, name: entry.name, message: entry.message }
            }),
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
  api.load({ id: "team-work-runtime", factory: factory })
}
