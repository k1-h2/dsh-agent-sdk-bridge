# 开发文档

实现要点与改这个仓库前必须知道的 DSH 行为。返回 [README](./README.md)。

## 实现要点

- **双版本**：品牌差异集中在 `src/brand.ts`（SDK 包、CLI 包、登录态目录、一键配置脚本），
  其余代码按 brand 参数化。CN SDK 静态引入；国际版 SDK 按需 `import()`，没装时只有国际版页面
  报错，插件照常加载。
- **品牌隔离**：两版的 CLI 查找、模型目录缓存、会话池、额度缓存、模型开关全部按 brand 分开。
  `QODERCLI_PATH` 若指向另一版本，对应版本会明确报错而不是借用那个 CLI 的账号。
- **额度**：`QoderUsage` 起一个不跑模型轮次的短命 `query()`，调用 SDK 的 `getUsageInfo()`；
  CLI 用自己的凭证查额度并返回与官方客户端一致的结构，插件只做展示与 1 分钟缓存。
- **版本开关**：`cnEnabled` / `intlEnabled` 是结构字段。宿主在 `loader/volatile-update` 时
  重新注册或释放对应 adapter 路由，并按启用状态重建 picker 目录；浏览器半侧同步
  `settings.section` 的注册与释放。关闭是「不存在」，不是「隐藏」。
- **快照优先**：设置页把上次成功的模型列表与额度写入 `localStorage`（同源、按版本分开），
  首次渲染直接用快照，随后后台刷新并覆盖；读取失败时保留旧快照并标注。
- **warm 会话**：每个宿主 session id 对应一个常驻内层 `query()` 子进程，对话延续与工具轮次都
  发生在会话内部，超出 `maxSessions` 按插入序 LRU 淘汰。
- **工具桥接**：宿主工具经进程内 MCP server 暴露给内层模型，qodercli 一次执行一个调用、宿主
  一次回传整轮结果；配对状态（`ToolResultPairing`）由**会话**持有而不是轮次，因为 handler 可能在
  它那一轮结束之后才触发。成对调用等待宿主的下一次请求并由该请求结算；只有未配上对的 handler
  受 `toolResultTimeoutSeconds` 兜底。宿主**从未见过**的调用（工具块落在两次宿主请求之间被丢弃，
  而 CLI 仍派发了 MCP 消息）不 park，立即返回取消结果——否则这一轮没人能解开。
- **旁路请求**：标题生成、压缩摘要走冷启动一次性调用，不占用 warm 会话。
- **真实计量**：CLI 默认把用量帧里的 token 计数清零，插件在启动子进程时带上它的
  `EXPOSE_TOKEN_USAGE` 开关；总量、缓存命中与 tok/s 因此都是 provider 实测值，只有拿不到计量时才
  按「context 比率 → 字符估算」兜底。占用样本只取自**每次请求结束**的那一帧（`requestUsageSample()`，
  见 [常见问题](./FAQ.md)），内层整轮的合计值不参与上下文计算。
- **溢出可恢复**：内层上下文超限按 `CONTEXT_WINDOW_EXCEEDED` 上报，交给 harness 自动压缩，
  而不是让整轮报废。

## 开发须知

改这个仓库前，有两点 DSH 行为必须先知道，否则会「毫无提示地坏掉」。

**1. 字段不 `.volatile()`，设置页就永远不出现。** DSH 用 `volatileForm(schema)` 构造表单，它
**只保留带 `meta.volatile` 的节点**；字段全是非 volatile 的 object 会塌缩成 `undefined`，
`describe()` 随即 `return []` 丢掉整个命名空间——插件照常加载、模型照常可用，但命名空间
**从未下发到客户端**。此外，DSH 的自动配置页渲染在「内置插件」分区内部，要独立顶层导航项就得
自带 `client.js` 注册 `settings.section`。

**2. `.volatile()` 的值必须在「用的时候」读，不能在挂载时读。** 一次只改 volatile 字段的写入，
loader 会把新值写进运行中插件**已经持有的那个 `Volatile` 引用**，然后**跳过重启**——`apply()`
不会再被调用（`cordis-plugin-loader` 的 `Entry.update` → `_commitVolatile`）：

```js
const pending = volatileOnly && this._commitVolatile() ? [] : changes
if (!pending.length && !force) return          // 不重启，不重新 apply
```

在 `apply()`（或构造函数）里把配置抄进自己的字段，就等于**永久冻结**。本插件的做法：

- [`src/live.ts`](./src/live.ts)：`Live<T>`（值或 thunk）+ `readLive()`，选项既接受普通值，也
  接受读取实时单元格的 thunk。
- [`src/config.ts`](./src/config.ts) 的 `liveConfig()`：每个字段返回 thunk，每次读取才从
  `Volatile` 取值；`resolveConfig()` 在它之上实现，两者语义不会漂移。
- 适配器、会话池、模型目录一律按需读。`updateVolatile()` 只把新值写进**同一个**引用，所以
  thunk 天然看到新值——不用重启，也不丢 warm 会话。
- 只有两个分组名（`displayName` / `intlDisplayName`）会被复制进选择器的分组目录，无法惰性化；
  插件监听 `loader/volatile-update`，只在这些字段变化时用 `replace()` 就地重发。

[`test/live.test.ts`](./test/live.test.ts) 精确复现 loader 的就地提交并断言适配器**在不重新
`apply()` 的情况下**跟着变；用 0.5.0 的构建跑同一段代码会失败。

**本插件的读写链路。** 读走插件自建路由 `GET /api/llm-qoder-cn/models?brand=cn|global`（模型
目录来自 CLI，进不了配置表单）；写走 `ctx.configForms`，与官方「模型」页共用带修订号的写入队列，
并发编辑会被拒绝而不是静默覆盖。宿主**提交完成后**才回应写入，页面因此先按新状态显示、随后核对，核对不
通过才报错；单次写入 20 秒未落定会放弃并解除控件禁用，避免一个卡住的调用锁死整页。

**构建与测试**

```sh
pnpm install          # 首次会下载两个 SDK 的 CLI worker runtime
pnpm run build:clean   # 清掉 lib/ 再构建；tsc 出 .d.ts，tsdown 出 lib/index.js
pnpm test              # vitest
```

**别用 `pnpm build` 验证改动。** 它的命令是 `tsc && tsdown`：类型一错，`&&` 就短路，`tsdown`
根本不跑，于是 `lib/index.js` **保持旧内容**——而 `lib/` 才是 DSH 真正加载、npm 真正发布的东西。
如果只盯着源码或只跑测试，会误以为改动已生效。发布路径上的 `prepublishOnly` 用的是
`build:clean`（先删 `lib/` 再构建），所以类型错误会让发布失败而不是发出陈旧包。

注意 **`pnpm build` 与 `pnpm run build` 在 PowerShell 里可能给出不同的退出码**（前者经
`pnpm` 的内置脚本别名，后者经 `run`）。判断构建是否成功请直接看 `lib/index.js` 的时间戳，
或跑 `build:clean`——不要只信退出码。
