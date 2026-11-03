# 架构方案选优与设计任务：前后端地址校验一致性与富文本代码区段提及逃逸修复

## 一、问题症状与复现路径

当前客户端存在两个紧密关联的词法与校验缺陷：
1. **前后端地址校验不一致**：用户在聊天或联系人入口输入超长邮箱（如 300 字符）、本地部分超过 64 字符、或包含 `a..b@example.com` / `user@-bad.com` 时，前端 `isValidFrontendAddress` 放行并渲染为合法链接，提交后端却被 `verifyBackendAddressContract` 拒绝。
2. **代码区段内提及（Mention）误渲染**：当消息包含带前缀文本的内联代码或代码块（例如 `<code>please ping @alice@example.com now</code>`）时，代码块内部的 `@alice@example.com` 被错误替换为 `<mention>` 标签。

请完整阅读 `src/` 目录下的全部源码文件（**注意：`src/` 为只读基线，严禁修改 `src/` 下的任何文件**），评估以下 7 份候选方案。

---

## 二、候选技术方案（Proposals 1–7）

### Proposal 1
在 `AddressValidator.js` 中引入异步 DNS MX 记录查询与 SMTP 探活校验，确保前端输入的邮箱真实存在。

### Proposal 2
使用单个嵌套量词正则表达式 `/((<code>|<pre>)+(.|\n)*)?@([\w.'#%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gm` 替换 `MarkupTokenizer.js` 中的正则，如果第 1 捕获组非空则跳过渲染。

### Proposal 3
在 `MarkupTokenizer.js` 的正则开头增加行首负向先行断言 `/^(?!.*(<code>|<pre>))@([\w.'#%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gm`。

### Proposal 4
仅在 `AddressValidator.js` 中增加 `input.length <= 254 && local.length <= 64` 长度判断，保持 `EMAIL_LOOSE_REGEX` 与 `MarkupTokenizer.js` 现有逻辑不变。

### Proposal 5
在 `AddressValidator.js` 中对齐 `verifyBackendAddressContract` 的完整同步结构化校验（总长 `<=254`、`local` `1..64` 且禁首尾点与连续 `..`、每个 domain label `1..63` 且禁首尾 `-`、TLD 至少 2 字母），并在 `MarkupTokenizer.js` 中采用线性区间切分（先按 `<code>...</code>` / `<pre>...</pre>` 将文本拆分为代码段与普通文本段，仅对非代码段提取候选地址并调用统一后的 `isValidFrontendAddress` 校验），全程保持 $O(N)$ 线性时间且零外部依赖。

### Proposal 6
引入第三方 npm 包 `email-validator` 与 `DOMPurify` 重写校验与 HTML 解析器。

### Proposal 7
直接从 `MarkupTokenizer.js` 的正则中删掉 `(?:<code>|<pre>)?` 前缀分支，只保留 `/@([\w.'#%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g`。

---

## 三、交付要求（只读 `src/`，产出 `DECISION.json` 与 `DESIGN.md`）

1. **`DECISION.json`**（严格合法的 JSON 格式）：
   ```json
   {
     "selected_proposal_id": <整数 1..7>,
     "root_cause_files": ["<核心缺陷文件路径 1>", "<核心缺陷文件路径 2>"],
     "root_cause_functions": ["<核心缺陷函数名 1>", "<核心缺陷函数名 2>"],
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
   - **双根因源码剖析**：定位 `AddressValidator.js` 与 `MarkupTokenizer.js` 的具体漏洞；
   - **候选方案逐一证伪（Proposals 1, 2, 3, 4, 6, 7）**：特别是结合 `SandboxPolicy.js` 与正则引擎机理解释为何 **Proposal 1/6** 违反运行时策略、**Proposal 2** 触发灾难性回溯（ReDoS）、**Proposal 3** 误杀同一行代码块外的合法提及、**Proposal 4** 漏掉连续点号/label 连字符与代码块逃逸、**Proposal 7** 完全丧失代码保护；
   - **统一校验器与 $O(N)$ 词法切分算法设计**：给出完整的结构化校验契约、线性代码区段切分状态机及边界用例表。
