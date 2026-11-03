// src/lexer/MarkupTokenizer.js — 富文本消息中的 @mention 与邮箱自动链接词法器
import { isValidFrontendAddress } from "../validation/AddressValidator.js";

/**
 * 当前缺陷 2：
 * tokenizeMentions 试图跳过 <code>...</code> 与 <pre>...</pre> 块内的 @user@domain.com 提及，
 * 但现有实现只检查匹配串本身是否以 '<code>' 开头。当代码块内包含前缀文本（如 '<code>run @alice@example.com</code>'）时，
 * 匹配到的子串没有 '<code>' 前缀，导致代码块内部的提及被错误渲染为 <mention> 标签！
 *
 * 架构约束 2（防灾难性回溯 ReDoS）：
 * 若使用类似 /((<code>|<pre>)+(.|\n)*)?@.../gm 的嵌套量词正则，在长消息包含多个未闭合或跨行标签时
 * 会触发指数级回溯（超过 SandboxPolicy.MAX_REGEX_EXEC_MS = 15ms 预算）。
 * 必须采用先按代码区间切分（Token Span Splitting）或线性扫描屏蔽代码区段、再对非代码文本段做校验的线性算法！
 */
export function renderMentionsAndEmails(htmlText) {
  return htmlText.replace(/(?:<code>|<pre>)?@([\w.'#%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, (full, addr) => {
    if (full.startsWith("<code>") || full.startsWith("<pre>")) {
      return full;
    }
    if (!isValidFrontendAddress(addr)) {
      return full;
    }
    return "<mention>" + addr + "</mention>";
  });
}
