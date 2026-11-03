# 产品需求与架构设计规格书：StructFold 嵌套表格投影引擎

## 一、任务目标与双阶段交付物

你需要从 0 到 1 完成 **StructFold**（平面分隔符表格到嵌套 JSON 投影引擎）的**软件架构设计（`DESIGN.md`）**与**完整 Python 包实现（`src/structfold/`）**。

### 必需交付物
1. **`DESIGN.md`**（架构设计文档）：
   - 完整的模块分层文件树（至少拆分为主控制器 `StructFolder`、CSV/分隔符词法读取器 `csv_utils`、Schema 树推导与类型转换器 `schema_utils`）；
   - 使用 Mermaid 语法绘制的 **UML 类图（` ```mermaid classDiagram ``` ）** 与 **核心转换时序图（` ```mermaid sequenceDiagram ``` ）**；
   - 模块依赖有向无环图（`code_file_DAG`）及针对下方“三项扩展架构约束”的专门设计说明。
2. **`src/structfold/` 代码实现**：
   - 仅使用 Python 标准库（`csv`、`json`、`re`、` pathlib` 等），不得依赖第三方包；
   - 在 `src/structfold/__init__.py` 导出核心类 `StructFolder` 及异常类 `SchemaConflictError`、`CircularAliasError`。

---

## 二、核心功能与 API 契约（含三项防背题扩展架构约束）

### 1. 基础构造函数与 Schema 自动推导
```python
folder = StructFolder(
    delimiters=["_", " "],          # 可选分隔符列表，默认 ["_", " "]
    conflict_policy="error",        # 扩展约束 A：前缀冲突策略 "error" | "last" | "nest_value"
    type_coercion=False,            # 扩展约束 B：内联类型指令开关
    column_aliases=None             # 扩展约束 C：列名别名映射 dict[str, str] | None
)
```
- **`get_schema(csv_filepath_or_lines) -> dict`**：
  - 读取 CSV 表头行，按 `delimiters` 切分共享前缀（当且仅当至少 2 个列共享同一非空前缀时，才将该前缀提升为嵌套字典键，支持多层递归嵌套）；
  - 例如表头 `["name", "birth_year", "birth_month"]` 自动生成的 Schema 为：
    `{"name": "name", "birth": {"year": "birth_year", "month": "birth_month"}}`；
  - 支持标准 CSV 双引号包裹与转义（如列名或单元格内含逗号 `,`、双引号 `""`、首尾空白）。
- **`convert(csv_filepath_or_lines, schema=None) -> list[dict]`**：
  - 若 `schema` 为 `None`，先调用 `get_schema` 自动生成 Schema，再将每行数据填充为嵌套字典列表（键按字典序稳定排序或保持结构一致）。

### 2. 扩展架构约束 A：叶子与子树路径冲突策略（`conflict_policy`）
当表头同时存在既是完整列名又是其他列前缀的字段时（例如同时存在列 `"user"` 和 `"user_id"`、`"user_name"`）：
- `conflict_policy="error"`（默认）：在 `get_schema` 或 `convert` 时立即抛出 `SchemaConflictError`；
- `conflict_policy="nest_value"`：将原叶子列 `"user"` 挂载到嵌套字典的 `"_self"` 键下，即 `{"user": {"_self": "user", "id": "user_id", "name": "user_name"}}`；
- `conflict_policy="last"`：保留子树结构并忽略冲突的标量同名覆盖（或按后出现的子键覆盖）。

### 3. 扩展架构约束 B：列类型强制转换指令（`type_coercion=True`）
当 `type_coercion=True`（或 Schema 叶子映射字符串带有 `@int`、`@float`、`@bool` 后缀，如表头列名为 `"age_years@int"` 或 `"adopted@bool"`）：
- 在生成的 Schema 中自动剥离类型后缀作为 JSON 属性名（例如 `"age_years@int"` 的 JSON 键路径为 `age_years` 或嵌套下的 `years`）；
- 在 `convert()` 填充单元格值时：
  - `@int`：空串或 `"N/A"` 转为 `None`，其余转为 `int`；
  - `@float`：空串或 `"N/A"` 转为 `None`，其余转为 `float`；
  - `@bool`：`"true"` / `"1"` / `"yes"`（不区分大小写）转为 `True`，`"false"` / `"0"` / `"no"` 转为 `False`，空串或 `"N/A"` 转为 `None`。

### 4. 扩展架构约束 C：列名别名链解析与环路检测（`column_aliases`）
当传入 `column_aliases: dict[str, str]`（例如 `{"u_id": "account_id", "account_id": "profile_id"}`）时：
- 在推导 Schema 前先沿别名链将原始列名解析为最终目标列名（支持多跳传递解析：`u_id -> account_id -> profile_id`）；
- 若 `column_aliases` 中存在环路（例如 `{"a": "b", "b": "c", "c": "a"}`），必须在初始化或 `get_schema` 时立即抛出 `CircularAliasError`。
