# 架构方案选优与设计任务：非全屏模态框内右键菜单与遮罩关闭的冲突

## 一、故障表象与复现路径

1. 在非全屏（`fullscreen = false`）的报告详情模态框中，对一条报告消息按下右键：自定义菜单短暂出现后立刻消失，同时整个模态框被关闭。
2. 自定义菜单已经稳定显示时，点击菜单项（例如“隐藏报告”）：菜单项动作没有执行，模态框却关闭了。
3. 已有菜单打开时，右键模态框内的空白区域：浏览器原生右键菜单与自定义菜单同时出现，或自定义菜单残留不关闭。
4. 点击悬浮触发按钮打开菜单后，再次点击同一个触发按钮：菜单闪一下又恢复展开状态，无法收起。
5. 指针从消息上滑过出现的快捷操作条，与已打开的自定义菜单同时可见并争夺点击。
6. 连续打开两层自定义菜单后按 Esc：焦点跳到被遮挡的外层消息上；关闭外层菜单时焦点出现两次跳跃。

## 二、只读基线

`src/` 为只读基线，严禁修改 `src/` 下的任何文件。请完整阅读 `src/` 下全部 7 个模块，结合代码中真实的事件路由、浮层登记与焦点管理逻辑评估以下 8 份候选方案。

## 三、候选技术方案（Proposals 1–8）

### Proposal 1
在遮罩的 `pointerdown` 处理中忽略非主键事件，并在菜单容器上调用 `stopPropagation()`，阻止菜单内的点击冒泡到遮罩的关闭逻辑。

### Proposal 2
菜单打开期间给遮罩设置 `pointer-events: none`，菜单关闭后恢复，使遮罩在菜单存在时不再接收指针事件。

### Proposal 3
把自定义菜单的关闭推迟到当前事件循环之后（`setTimeout(..., 0)`），让菜单项的点击处理先执行完。

### Proposal 4
在 `ReportContextMenu` 内维护一个模块级的“菜单已打开”标志，遮罩点击时若该标志为真就直接返回，既不关闭菜单也不关闭模态框。

### Proposal 5
建立单一的事件路由层：右键事件由统一入口先做命中判定，命中具备自定义菜单的目标时阻止原生菜单、关闭已有菜单并打开新菜单；未命中时关闭已有菜单并放行浏览器原生菜单。遮罩的外部点击不再直接关闭模态框，而是先向浮层登记与触发排除登记询问事件归属，命中浮层或触发按钮时交回对应组件处理；命中遮罩且存在浮层时本轮只收起浮层岛，只有不存在任何浮层时才关闭模态框。悬浮触发按钮的锚点与其展开内容纳入外部点击排除名单，并由按钮自身按当前展开状态切换收起或展开。悬停态浮层在点击态浮层存在时不出现，点击态浮层打开时收回悬停态浮层。嵌套菜单按层级自顶向下关闭：一次交互同时关闭多层时，只在最外层被关闭的那一层把焦点归还一次；只关闭最内层时，焦点归还给打开该内层的菜单项；切换菜单时不做焦点归还。

### Proposal 6
把自定义菜单从浮层根改为直接渲染在模态框内容树内部（绝对定位），让遮罩的外部点击判定把菜单视为模态框内部元素。

### Proposal 7
全局监听 `contextmenu` 并一律 `preventDefault()`，用应用内菜单取代浏览器原生右键菜单；同时把遮罩的外部点击判定从 `click` 改为 `mousedown` 的 `relatedTarget`。

### Proposal 8
把遮罩关闭从 `pointerdown` 推迟到 `pointerup` 之后的下一帧，并在关闭前检查指针是否仍停在遮罩上；菜单打开期间给遮罩加 `inert`。

## 四、交付要求（只读 `src/`，在工作区根目录产出 `DECISION.json` 与 `DESIGN.md`）

1. **`DECISION.json`**（严格合法的 JSON），字段与形状如下（尖括号为占位说明，不是实际取值）：
   ```json
   {
     "selected_proposal_id": <整数 1..8>,
     "root_cause_files": ["<相对于工作区根的源码路径>", "..."],
     "discovered_implicit_contracts": ["<从 src/ 源码中发现的跨文件隐式约束或不变量>", "..."],
     "rejected_proposals": {
       "<未选方案编号>": "<基于 src/ 源码事实的具体证伪依据（须覆盖其余全部 7 个方案）>"
     },
     "routing_matrix": {
       "rightClickAnotherMessage": { "closeExisting": <布尔值>, "openNewCustom": <布尔值>, "allowNativeMenu": <布尔值>, "restoreFocus": <布尔值> },
       "rightClickPlainArea": { "closeExisting": <布尔值>, "openNewCustom": <布尔值>, "allowNativeMenu": <布尔值>, "restoreFocus": <布尔值> },
       "clickFabWhileOpen": { "closeExisting": <布尔值>, "openNewCustom": <布尔值>, "allowNativeMenu": <布尔值>, "restoreFocus": <布尔值> },
       "hoverActionWhileMenuOpen": { "closeExisting": <布尔值>, "openNewCustom": <布尔值>, "allowNativeMenu": <布尔值>, "restoreFocus": <布尔值> },
       "pressEscapeWithNestedMenu": { "closeExisting": <布尔值>, "openNewCustom": <布尔值>, "allowNativeMenu": <布尔值>, "restoreFocus": <布尔值> },
       "outsideLeftClick": { "closeExisting": <布尔值>, "openNewCustom": <布尔值>, "allowNativeMenu": <布尔值>, "restoreFocus": <布尔值> }
     }
   }
   ```

   **`routing_matrix` 六种场景（均以“场景开始时已有自定义菜单打开”为前提，第 4、5 项除外，其前提见各自说明）：**
   - `rightClickAnotherMessage`：已有自定义菜单打开时，对另一条具备自定义菜单的消息按下右键。
   - `rightClickPlainArea`：已有自定义菜单打开时，对不具备自定义菜单的目标按下右键。
   - `clickFabWhileOpen`：由悬浮触发按钮展开的菜单处于展开状态时，再次点击同一触发按钮。
   - `hoverActionWhileMenuOpen`：已有自定义菜单打开时，指针移入某条消息的悬停快捷操作区域。
   - `pressEscapeWithNestedMenu`：两层嵌套的自定义菜单都已打开时按下 Esc。
   - `outsideLeftClick`：已有自定义菜单打开时，在菜单与模态框界面之外、且不落在任何被排除的触发节点上的遮罩区域按下主键（`button = 0`）。

   **`routing_matrix` 字段语义：**
   - `closeExisting`：该交互结束后，交互开始前已打开的自定义菜单或浮层是否被关闭（只关闭其中最上层也记为 true）。
   - `openNewCustom`：该交互结束后，是否出现新的自定义菜单并成为最上层。
   - `allowNativeMenu`：该交互是否会让浏览器原生右键菜单弹出。
   - `restoreFocus`：被关闭的自定义浮层是否按其层级把焦点归还给打开它的锚点；一次交互关闭多层时，只按最外层被关闭的那一层判定一次；本次交互没有关闭任何自定义浮层、或焦点由新浮层接管的场景记为 false。

   所有字段都会以 `src/` 的实际实现为基准逐项核对，不得凭直觉填写。

2. **`DESIGN.md`**（完整架构设计方案）：
   - **源码级根因追踪**：梳理 `src/` 下 7 个模块的调用链与职责边界，说明冲突发生在哪一环、哪些环节已经具备可复用的机制；
   - **全部未选方案的源码证伪**：逐一用 `src/` 中的具体事实证伪其余 7 个方案，指出每个方案在哪些场景下失效或引入新的破坏；
   - **目标事件路由与焦点层级设计**：给出覆盖 6 种场景的路由决策规则、浮层岛的关闭范围规则、嵌套菜单的层级顺序与焦点归还规则，并对 `routing_matrix` 的每一格给出推导依据。
