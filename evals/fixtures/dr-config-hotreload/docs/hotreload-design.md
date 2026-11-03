# 跨进程配置热更新与多级缓存设计方案（草案 v1）

## 1. 目标与背景
在不重启主服务进程的前提下，支持通过 Web 控制台保存配置文件 `config.json` 并由文件监听器实时热更新内存路由表与凭据引用。系统须满足三项核心不变量：① 热更新期间文件读取不得因并发写入而解析报错或中断监听；② 正在执行中的长耗时请求不得因中途配置热更新而出现鉴权凭据与目标路由前后不一致；③ 配置文件须保持跨版本与扩展插件前向兼容，旧版控制台保存时不得丢失新版或第三方插件已写入的未知字段。

## 2. 写入与监听流程
1. 控制台点击保存时，配置服务调用 `await fs.writeFile(configPath, JSON.stringify(nextConfig, null, 2))` 直接覆写目标文件。
2. 主进程通过 `fs.watch(configPath)` 监听 `change` 事件，触发时立即调用 `JSON.parse(await fs.readFile(configPath, 'utf8'))` 并赋值给全局导出变量 `export let activeConfig = ...`。

## 3. 请求执行与多步读取
每次长耗时流式请求包含鉴权、路由解析、流式消费与重试四个阶段：
- 阶段 A（鉴权）：读取 `activeConfig.routes[routeId].apiKeyRef`；
- 阶段 B（流式请求，耗时 5～30s）：读取 `activeConfig.routes[routeId].endpoint` 发起连接；
- 阶段 C（中途重试）：再次读取 `activeConfig.routes[routeId]` 进行重试。

## 4. Schema 校验与落盘归一化
为保证配置整洁，编辑器保存前按当前版本已知字段构造新对象：
```js
function sanitizeForSave(raw) {
  return {
    version: 1,
    routes: Object.fromEntries(
      Object.entries(raw.routes ?? {}).map(([k, v]) => [k, { endpoint: v.endpoint, apiKeyRef: v.apiKeyRef }])
    )
  }
}
```

## 5. 界面展示说明（附录）
- 配置表格第一列建议宽度 180px，状态徽标采用浅蓝色背景。
- 流程图箭头建议使用虚线表示异步通知。
