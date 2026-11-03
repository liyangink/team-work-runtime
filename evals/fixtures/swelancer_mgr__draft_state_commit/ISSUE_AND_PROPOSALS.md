# 架构方案选优与设计任务：分步表单中未确认币种选择的提前持久化与分摊截断缺陷

## 一、问题症状与复现路径

在费用分摊流程中，用户从金额编辑页（`AmountStepPage`）进入币种选择页（`CurrencySelectionPage`），点击任一币种（例如从 `USD` 切换为 `JPY`）返回金额编辑页后，**不点击“保存（Save）”按钮而是直接取消或返回**：
- **预期行为**：在用户点击 `AmountStepPage` 的 `save()` 按钮前，持久层 `StateVault("IOU_DRAFT")` 中的 `currency` 和 `splitShares` 均不得被修改。
- **实际缺陷**：点击币种选项的瞬间就已经修改了 `StateVault("IOU_DRAFT")`，并且触发了不可逆的分摊金额精度截断。

请完整阅读 `src/` 目录下的全部源码文件（**注意：`src/` 为只读基线，严禁修改 `src/` 下的任何文件**），结合源码中的真实约束评估以下 6 份候选方案。

---

## 二、候选技术方案（Proposals 1–6）

### Proposal 1
从 `AmountStepPage` 跳转到 `CurrencySelectionPage` 时，在 `navigateWithParams` 的路由参数 `params` 中直接传入一个回调函数 `{ onSelect: (currency) => setPendingCurrency(currency) }`，由 `CurrencySelectionPage` 调用该回调而不写 `StateVault`。

### Proposal 2
保持 `CurrencySelectionPage` 直接写入 `StateVault.mergeDraft("IOU_DRAFT", { currency })` 不变；在 `AmountStepPage` 中增加布尔状态 `isStepComplete`，若组件卸载（`unmount`）时 `isStepComplete === false`，再调用一次 `StateVault.mergeDraft("IOU_DRAFT", { currency: previousCurrency })` 将币种改回原值。

### Proposal 3
在 `StateVault` 中新增一个专门存放临时币种的独立顶级键 `StateVault.mergeDraft("IOU_TEMP_CURRENCY", { currency })`，避免直接修改 `IOU_DRAFT`。

### Proposal 4
移除 `CurrencySelectionPage.js` 中对 `StateVault.mergeDraft` 的直接调用；在点击币种时通过 `RouteSerializer.navigateWithParams(returnToRoute, { currency: selectedCurrency })` 将所选币种作为纯 JSON 路由参数传回 `AmountStepPage`，仅当用户在 `AmountStepPage` 点击 `save()` 时才写回 `StateVault`。

### Proposal 5
移除 `CurrencySelectionPage` 中对 `StateVault.mergeDraft` 的直接调用；在跳转与返回时通过 `RouteSerializer.navigateWithParams(returnToRoute, { currency: selectedCurrency, draftEpoch })` 传递纯 JSON 路由参数（保留 `draftEpoch` 乐观锁基线），由 `AmountStepPage` 在本地 `pendingCurrency` 持有预览态，仅当用户点击 `save()` 时携带 `expectedEpoch: capturedEpoch` 原子提交至 `StateVault.mergeDraft("IOU_DRAFT", ...)`（使币种变更与 `splitShares` 精度重算仅在确认保存时执行一次）。

### Proposal 6
修改 `StateVault.js`，删除 `mergeDraft` 中自动重算 `splitShares` 的逻辑，允许 `CurrencySelectionPage` 继续直接写 `IOU_DRAFT.currency`。

---

## 三、交付要求（只读 `src/`，产出 `DECISION.json` 与 `DESIGN.md`）

1. **`DECISION.json`**（严格合法的 JSON 格式）：
   ```json
   {
     "selected_proposal_id": <整数 1..6>,
     "root_cause_file": "<相对于工作区根的源码路径>",
     "root_cause_functions": ["<核心缺陷函数名>"],
     "discovered_code_invariants": [
       "<从 src/ 源码中发现的关键约束/不变量 1>",
       "<从 src/ 源码中发现的关键约束/不变量 2>",
       "<从 src/ 源码中发现的关键约束/不变量 3>"
     ],
     "rejected_proposals": {
       "<未选方案编号>": "<基于 src/ 源码事实的具体证伪依据（须覆盖全部 5 个未选方案）>"
     }
   }
   ```

2. **`DESIGN.md`**（完整架构设计方案）：
   - **源码级根因与副作用分析**：结合 `CurrencySelectionPage.js`、`AmountStepPage.js`、`StateVault.js` 与 `RouteSerializer.js` 说明为何提前写 `IOU_DRAFT` 不仅污染状态还会造成不可逆数据损坏；
   - **全部未选方案的源码证伪**：用 `src/` 中的具体代码异常或数据损坏机制逐一证伪 **Proposal 1**（触发什么序列化异常？）、**Proposal 2**（为什么卸载时回滚 `currency` 仍无法恢复 `JPY` 截断后的 `splitShares` 且增加 `draftEpoch`？）、**Proposal 3**（触发什么 Schema 异常？）、**Proposal 4 vs Proposal 5**（漏传 `draftEpoch` 在并发或跨步返回时有什么隐患？）、**Proposal 6**（破坏什么业务不变量？）；
   - **目标数据流与状态机设计**：给出从进入选择页、纯 JSON 路由参数回传、本地预览到 `expectedEpoch` 原子提交的完整时序与接口设计。
