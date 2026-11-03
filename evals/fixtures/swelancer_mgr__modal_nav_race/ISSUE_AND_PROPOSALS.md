# 架构方案选优与设计任务：多层模态框下全局快捷键导航的层级错乱缺陷

## 一、问题症状与复现路径

当用户在附件预览模态框（`attachment-preview`）内点击“删除”打开二级确认弹窗（`delete-confirm`）时，如果直接按下全局快捷键触发 `openQuickSwitcherShortcut()`（跳转到 `/quick-switcher`）：
- **预期行为**：当前打开的所有阻塞态模态框全部完成关闭并解除过渡锁后，才执行 `navigate("/quick-switcher")`，使搜索页位于栈顶且可交互。
- **实际缺陷**：二级确认弹窗刚完成隐藏时，导航回调就被提前触发，导致搜索页被压在尚未关闭的父模态框下方或触发导航异常。

请完整阅读 `src/` 目录下的全部源码文件（**注意：`src/` 为只读基线，严禁修改 `src/` 下的任何文件**），结合代码真实逻辑评估以下 7 份候选方案。

---

## 二、候选技术方案（Proposals 1–7）

### Proposal 1
在 `AttachmentPreviewModal.js` 中监听关闭事件：如果检测到用户正准备打开 `/quick-switcher`，则在确认弹窗关闭时手动销毁附件预览组件实例。

### Proposal 2
问题根因是 `ModalStack` 只用了一个单变量保存模态框的 `closeHandler`，打开第二个模态框时覆盖了第一个模态框的 `closeHandler`。应改为数组保存所有 `closeHandler`。

### Proposal 3
在打开二级确认弹窗的同时按全局搜索快捷键属于极端低频操作，建议不做代码修改直接关闭问题单。

### Proposal 4
在 `ModalStack.close` 中直接记录 `pendingCloseCount = closeModals.length`，并在 `onModalDidClose` 中无条件执行 `pendingCloseCount -= 1`，当 `pendingCloseCount === 0` 时触发 `onModalClose()`。

### Proposal 5
在每个模态框的 `onModalHide` 回调末尾无条件调用 `Navigation.dismissModal()`，强制弹出路由栈顶页面以确保旧模态屏被移除。

### Proposal 6
新增 `ModalStack.closeAll(callback)`：先调用 `close(() => {})`，然后不等待异步关闭完成，直接同步调用 `callback()` 立即跳转路由。

### Proposal 7
在 `ModalStack.close` 中仅统计非分离阻塞模态框（过滤掉 `detachedOverlay: true`）的数量作为待关闭计数，绑定当前 `activeTransactionId`（`txId`），并在 `onModalDidClose` 中忽略 `detachedOverlay` 事件与过期 `txId` 事件，待全部阻塞模态框完成 `onModalDidClose`（且过渡锁已释放）后唯一一次触发 `onModalClose`。

---

## 三、交付要求（只读 `src/`，产出 `DECISION.json` 与 `DESIGN.md`）

1. **`DECISION.json`**（严格合法的 JSON 格式）：
   ```json
   {
     "selected_proposal_id": <整数 1..7>,
     "root_cause_file": "<相对于工作区根的源码路径>",
     "root_cause_functions": ["<核心缺陷函数名>"],
     "discovered_code_invariants": [
       "<从 src/ 源码中发现的关键约束/不变量 1>",
       "<从 src/ 源码中发现的关键约束/不变量 2>",
       "<从 src/ 源码中发现的关键约束/不变量 3>"
     ],
     "rejected_proposals": {
       "<未选方案编号>": "<基于 src/ 源码事实的具体证伪依据（须覆盖全部 6 个未选方案）>"
     }
   }
   ```

2. **`DESIGN.md`**（完整架构设计方案）：
   - **源码级根因追踪**：完整梳理 `ModalStack.js`、`OverlayBus.js`、`Navigation.js`、`BaseModal.js` 与 `AttachmentPreviewModal.js` 的调用链；
   - **全部未选方案的源码证伪**：特别是用 `src/` 中的具体机制证伪 **Proposal 2**（源码是否真的只用单变量存 handler？）、**Proposal 4**（为什么直接用 `closeModals.length` 会在 `OverlayBus.js` 场景下造成永久死锁？）、**Proposal 5**（为什么无条件 `dismissModal()` 会破坏路由栈？）、**Proposal 6**（为什么同步调 `callback()` 会触发 `BaseModal.js` / `Navigation.js` 中的什么异常？）；
   - **目标状态机与防竞态设计**：给出包含 `detachedOverlay` 过滤、`activeTransactionId`（`txId`）幂等守卫、以及异常重入恢复的完整设计规范与伪代码。
