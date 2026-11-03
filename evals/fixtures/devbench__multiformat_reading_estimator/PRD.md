# 产品需求与架构设计规格书：ReadPulse 多格式阅读时长与章节时间线估算引擎

## 一、任务目标与双阶段交付物

你需要从 0 到 1 完成 **ReadPulse**（支持 Plain Text / Markdown / HTML 的阅读时长与章节分解估算引擎）的**软件架构设计（`DESIGN.md`）**与**完整 Python 包实现（`src/readpulse/`）**。

### 必需交付物
1. **`DESIGN.md`**（架构设计文档）：
   - 模块分层文件树（至少包含公开入口 `api.py`、结果值对象 `result.py`、多格式解析与清洗器 `parser.py`）；
   - 使用 Mermaid 语法绘制的 **UML 类图（` ```mermaid classDiagram ``` ）** 与 **多格式解析计算时序图（` ```mermaid sequenceDiagram ``` ）**；
   - 模块依赖有向无环图（`code_file_DAG`）及针对下方“三项扩展架构约束”的算法说明。
2. **`src/readpulse/` 代码实现**：
   - 仅使用 Python 标准库（`re`、`math`、`html.parser`、`dataclasses` 等），不得依赖外部第三方包；
   - 在 `src/readpulse/__init__.py` 导出 `of_text`、`of_markdown`、`of_html`、`ReadPulseResult`、`DEFAULT_WPM`（默认 `265`）及 `UnsupportedFormatError`。

---

## 二、核心功能与 API 契约（含三项防背题扩展架构约束）

### 1. 基础 API 与计算规则
- `DEFAULT_WPM = 265`
- `of_text(text, wpm=265) -> ReadPulseResult`
- `of_markdown(markdown_text, wpm=265, code_wpm=None, exclude_blockquotes=False) -> ReadPulseResult`
- `of_html(html_text, wpm=265, code_wpm=None, exclude_blockquotes=False) -> ReadPulseResult`
- **异常与空输入处理**：
  - 当输入为 `None` 或空字符串 `""` 时，`seconds = 0`，`minutes = 0`，`text = "1 min read"`（遵循最小 1 分钟展示惯例，但 `exact_seconds == 0.0` 且 `word_count == 0`）；
  - 若 `wpm <= 0` 或 `code_wpm is not None and code_wpm <= 0`，抛出 `ValueError`；
  - 提供通用入口 `of_content(content, format="text", ...)`，当 `format` 不在 `("text", "markdown", "html")` 中时抛出 `UnsupportedFormatError`。
- **阶梯图片阅读耗时折算（Image Progressive Decay）**：
  - 在 Markdown（`!\[alt\]\(image_src\)`）或 HTML（`<img ...>`）中，第 1 张图片计 `12` 秒，第 2 张计 `11` 秒，……每多一张递减 1 秒，第 10 张及以后的图片固定每张计 `3` 秒（即 `[12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 3, ...]`）。
- **总秒数与分钟向上取整**：
  - `exact_seconds = prose_seconds + code_seconds + image_seconds`
  - `seconds = math.ceil(exact_seconds)`（非空内容）；`minutes = math.ceil(exact_seconds / 60.0)`（当 `exact_seconds == 0` 时 `minutes = 0`，但展示属性 `result.text` 为 `f"{max(1, minutes)} min read"`）。

### 2. 扩展架构约束 A：代码块独立阅读速率折算（`code_wpm`）
- 在 `of_markdown`（三反引号围栏代码块 ``` ```...``` ```）与 `of_html`（`<pre><code>...</code></pre>` 或 `<pre>...</pre>`）中：
  - 代码块内部的词数（按空白分词的非空 token 数）必须与普通正文词数（`prose_words`）分开统计为 `code_words`（且代码块内的文本不得重复计入 `prose_words`，代码块内若含 `!\[img\]\(image_src\)` 也不得被误判为图片！）；
  - 若调用时未指定 `code_wpm`（即 `code_wpm=None`），代码块按 `wpm` 计耗时；若指定了 `code_wpm`（例如 `code_wpm=100`），则 `code_seconds = (code_words / code_wpm) * 60.0`，而普通正文仍按 `prose_seconds = (prose_words / wpm) * 60.0` 计算。

### 3. 扩展架构约束 B：引用块可选剥离（`exclude_blockquotes`）
- 当 `exclude_blockquotes=True` 时，Markdown 中以 `>` 开头的引用行（Blockquote）以及 HTML 中的 `<blockquote>...</blockquote>` 节点内的所有文字与图片均被剥离，不计入词数、图片数与阅读时长。

### 4. 扩展架构约束 C：按标题章节的时间线分解（`result.sections`）
- `ReadPulseResult` 必须提供属性 `sections: list[dict]`，按 Markdown 标题（`# Heading` .. `###### Heading`）或 HTML 标题（`<h1>` .. `<h6>`）将文档切分为顺序章节列表：
  - 每个章节字典格式为 `{"title": str, "word_count": int, "image_count": int, "seconds": int}`；
  - 第一个标题之前的正文（若有非空内容或图片）归入标题为 `"Introduction"` 的首章节；若整篇文档没有任何标题但有内容，则生成单个 `title="Introduction"` 的章节；空文档时 `sections = []`。
