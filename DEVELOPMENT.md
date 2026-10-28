# 开发文档

实现要点与改这个仓库前必须知道的 DSH 行为。返回 [README](./README.md)。

## 实现要点

- **多 SDK**：品牌差异集中在 `src/brand.ts`（SDK 包、CLI 包、登录态目录、一键配置脚本、
  登录区域），其余代码按 brand 参数化。CN Qoder SDK 静态引入；另两个 SDK 按需 `import()`，
  没装时只有对应页面报错，插件照常加载。
- **品牌隔离**：各 provider 的 CLI 查找、模型目录缓存、会话池、账户读取、模型开关全部按 brand
  分开。`QODERCLI_PATH` 若指向另一 Qoder 版本，对应版本会明确报错而不是借用那个 CLI 的账号。
- **Qoder 的声明窗口必须稳定**：Qoder 的 `context_usage_ratio` 是「按 CLI 实际运行的窗口」算的，
  而 DSH 又用适配器上报的 `contextWindow` 当分母。两者一变，环就会跳。实测目录里 `dfmodel`
  等模型声明 `availableContextWindows: [200000, 400000, 1000000]`、默认 200000，用户选 1M 是
  上游真支持的档位。旧代码在目录短暂读不到时退回静态 `DEFAULT_CONTEXT_WINDOW`（200000），
  于是同一会话会在 1M 与 200K 之间翻转：分母变了，DSH 的压缩预算 `contextWindow - maxTokens
  - headroom` 也一起从 800K 掉到约 102K，一个才 10% 的会话就被自动压缩（历史里 t18 在
  99,747 token 时压缩、随后掉到 37,699，正是这种「小幅跳变」）。现在 `declaredWindow()` 记住
  每个路由上一次成功解析的窗口与可选项，目录缺席时复用它而不是退回 200K；
  `resolveDeclaredWindow()` 只在模型确实声明了该档位时才采用用户覆盖（`auto` 只声明
  `[200000]`，存了 1M 也会被忽略），`/models` 对单档模型回传
  `contextWindowSelectable: false`，页面显示「上游固定」。
- **CodeBuddy**：`src/codebuddy.ts` 自成一体会话（`unstable_v2_createSession` + 流式消息），
  模型目录取自 `getAvailableModelsRaw()`，账户取自一次性 `query().accountInfo()`；登录走
  `unstable_v2_authenticate`，`global`/`cn` 分别映射为 SDK 的 `external`/`internal`。
  企业 `ioa`/`cloudhosted`/`selfhosted` 环境不暴露。SDK 自带 CLI，因此没有安装脚本。
  登录点击会先 `unstable_v2_logout` 清掉该区域缓存的 token：SDK 的 `authenticate()` 发现
  旧 token 时会静默返回、不回调 `onAuthUrl`，导致「切区域后点登录不弹浏览器」；清掉后
  必定走完整浏览器授权。登录成功会关闭该区域所有热会话，避免继续复用旧凭据。
  登录结果按区域写入 `~/.dsh/agent-sdk-bridge/codebuddy-state.json`（`src/codebuddy-state.ts`，
  含账号、额度快照与 bearer token，权限 0600）。之后创建会话、读账号都用
  `CODEBUDDY_AUTH_TOKEN` 环境变量把该区域的 token 注入 CLI，因此切区域和重启后恢复登录都
  不需要再走浏览器；登出或配额 401 会清掉该区域的 token。无效 token 会让 CLI 以
  `anonymous` 账号应答，`isUnauthenticatedAccount()` 将其判为未登录。未登录时
  `listModels()` / `describeCatalog()` 直接返回空，`/models` 也不读取目录；账号读取与
  会话创建都要求该区域有已保存的 token，绝不借用 CLI 里可能属于另一区域的单份登录。
  切区域时页面先渲染本地快照，再用 `fresh=1` 在后台校验。
  浏览器由 CLI 的登录流程自己打开；`onAuthUrl` 只记录 URL 供卡片显示「手动打开登录页」，
  宿主不再调用系统打开方式，否则每次登录会出现两个相同标签页。
- **CodeBuddy 的宿主工具**：宿主工具通过进程内 MCP server 挂入，`CodeBuddySession` 必须
  在 CLI 启动前完成注册——`ensureTools()` 会保存 schema，`ensureStarted()` 创建 MCP server
  后立即重放，然后才 `createSession`（MCP SDK 拒绝连接后再注册）。早返回会让首个 turn
  根本没有宿主工具，模型退回调用 CLI 内置的 `Bash`，宿主只能报 unknown tool。
  会话同时传 `tools: []` 禁用 CLI 内置工具（`--tools ""`），MCP 工具不受影响；`handle()`
  仍会丢弃任何非宿主前缀的 tool_use，防止模型臆造工具名。CodeBuddy 会把 MCP server 名里的
  非字母数字字符规范成 `_`（`dsh-host` → `mcp__dsh_host__<tool>`），Qoder CLI 保留连字符，
  因此 `isHostTool()` / `hostToolName()` 同时接受两种拼写。
- **切换模型读缓存**：`resolveModel` 与 `capture()` 走 `cachedModels()`
  （`src/model-cache.ts`）：有快照就先返回快照，刷新在后台跑；只有从未读到过目录时才等待。
  三家的目录获取都很贵（Qoder 冷启动 CLI，最长等于 fetch 超时；CodeBuddy 要启进程；MiniMax
  走 ACP 探测），而宿主在每次切模型、切思考档位时都会重新解析一次，所以以前 TTL 一过期就会
  卡住菜单。三家 catalog 都新增了 `snapshot()`（只读内存，不发网络）供这里使用。
  同步探测（`regionBlocked`、额度）不受影响，它们仍走各自的正常读取。
- **默认思考档位取最强的一档**：`reasoningInfo()` 的第二个参数是**用户配置**的档位，不再是上游
  声明的 `defaultEffort`；留空时由 `strongestEffort()` 按 `none < minimal < low < medium <
  high < xhigh < max` 取该模型支持的最强档（三家词表不同：Qoder `low|medium|high|max`、
  MiniMax `low|high`、CodeBuddy 由目录声明）。宿主在请求未带档位时会应用我们声明的
  `defaultEffort`（`requested ?? reasoning.defaultEffort`），所以这里选什么，实际就跑什么；
  上游自己的默认值会偏低（CodeBuddy 的 `high` 在可选 `max` 时就不再直接采用）。配置的档位若
  模型不支持，会退回最强档，而不是把这一轮判成 `UNSUPPORTED_REASONING_EFFORT`。
- **CodeBuddy 模型选择按区域**：`codebuddyGlobalDisabledModels` /
  `codebuddyCnDisabledModels` 与 `codebuddyGlobalModelContextWindows` /
  `codebuddyCnModelContextWindows` 是四个独立字段，`CodeBuddyAdapter` 按 region 读取，
  模型页也按当前区域写入对应字段。`/models?brand=codebuddy&region=cn|global` 显式选择区域，
  页面切换下拉框时先画该区域的本地缓存表，再拉取；这样不依赖 `codebuddyRegion` 的写入提交
  时序，也不会把另一区域的目录写进当前区域。
  CLI 把「当前产品环境」记在自己的用户目录里，initialize 时才切换，而模型提供方在切换前
  就已经选好了目录；两个区域共用 `~/.codebuddy` 时，换区后的读取会拿到上一个环境的列表，
  再被缓存 5 分钟——模型列表、以及由它派生的开关状态都会串到另一个区域。
  现在每个区域有独立的 `CODEBUDDY_CONFIG_DIR`
  （`~/.dsh/agent-sdk-bridge/codebuddy-cli/global|cn`，见 `codeBuddyCliDir()`），环境因此
  固定，进程启动后第一次读取就是本区域的目录。登录仍写用户自己的 CLI 目录，会话通过
  `CODEBUDDY_AUTH_TOKEN` + 该目录启动。页面在切区域时用 `fresh=1` 绕开宿主缓存，并校验
  `/models` 回显的 `region`。设置页的所有分支都渲染相同的 h2 / intro / 卡片前缀，避免切区时
  卡片因子节点下标变化被重建、把下拉框弹回配置里的旧区域。
- **CodeBuddy 的上下文窗口必须真正下发**：`contextWindow.supportedLengths` 才是可选项，
  `maxInputTokens` 只是物理上限。两套目录实测不同：国内站所有模型 `supportedLengths: null`
  （`set_config{contextWindow}` 被拒，`Allowed: <none>`）；国际站如 `deepseek-v4.1-flash` 是
  `[300K, 1M]`、`defaultLength` 300K。CLI 按「会话 override > defaultLength > 最小档 > 物理
  上限」解析有效预算，并据此设压缩阈值（92%）与网关限额。只把窗口告诉 DSH 而不下发时，宿主按
  1M 算、会话按 300K 跑：历史一过 276K 就被紧急压缩（日志 `Compact … trigger=blocking_limit`），
  上下文环从几十 % 塌到 2–3 %，下一轮补齐再涨回，正是「每轮被重置」的现象。实现：
  `contextWindows` 只收集 `supportedLengths`，`contextWindowFor()` 对不支持档位的模型返回
  `undefined`（旧覆盖值也随之失效）；`windowOption()` 对支持档位的模型始终返回一个值——用户选
  的档位，或模型默认（CLI 拒绝 `null` 清空：`contextWindow must be a positive safe integer`）；
  `CodeBuddySession.applyContextWindow()` 在 `setModel` 之后按 model+window 去重发送。
  `/models` 回传 `contextWindowSelectable`，页面把固定窗口模型显示为「上游固定」。
  另注：`CBC_SESSION_CONFIG_SYNC=1` 时 `result._meta` 的 `codebuddy.ai/contextWindow` 是模型
  物理窗口（如 1000000），不是用户选择。
- **图片要同时给像素和路径**：DSH 原生适配器除了图片块，还会附一句
  `requestImageHandleText()`——附件名、像素尺寸、**只读归一化副本的宿主路径**，以及「编辑前先复制成
  可写 `.png`」的指示。桥接此前只发像素：模型能看懂图，但用户说「取反色保存」时它去工作区找一个
  从未存在过的文件（Qoder 的原话是「图片没有保存在工作目录中」），而 DeepSeek 官方因为有路径能直接
  处理。现在 `render.ts` 的 `imageRefText()` 复用同一文案，`ImagePathResolver` 由
  `ctx.attachments.imageHostPath()` 取宿主路径、再经 `ctx.fs.processPathFromHostPath()` 映射到工具
  执行世界；Qoder / CodeBuddy / MiniMax 在图片块前插入这条句柄，历史图片（rebuild 时按文本重放、
  不发像素）同样带路径。另外三个适配器都会记住每个路由上一次验证过的 `vision` 能力：目录某次读不到
  时不再谎报 text-only——那会让 DSH 在适配器之前就把像素剥成占位符。
- **CodeBuddy 额度**：SDK 没有额度方法，`readQuotaWithToken()` 用登录 token 调
  `POST /v2/billing/meter/get-user-resource`（国内与国际同协议），按积分包汇总实时余额；
  额度读取优先用保存的 token，缺失时才静默 `authenticate`，不会拉起浏览器。卡片里的积分包
  与 Trae 适配器同一规则：`packageSummary()` 算出包数、合计额度与最近到期（跳过 year-9999
  哨兵），默认只渲染这一行；展开后逐个包列在 190px 高的滚动区里，不再截断到前四个。
- **MiniMax Code（ACP）**：`src/minimax.ts` 直接启动 `mcode acp` 并用
  `@agentclientprotocol/sdk` 的 `ClientSideConnection` 说话；`session/new` 的
  `configOptions` 提供模型与思考档位，`session/prompt` 的 `session/update` 通知被翻译成
  DSH 的 block/delta。宿主工具通过 `mcpServers` 注入一个本地 HTTP MCP endpoint
  （`MinimaxMcpServer` + `MinimaxMcpBridge`，每个会话一个随机 token），模型调用
  `mcp__dsh-host__*` 时桥接回 `MinimaxSession`，由后者像 CodeBuddy 一样挂起等待宿主在
  下一次请求里回传结果。`selectModel()` 在每个会话创建后应用模型与档位。
  模型目录不能只信 `configOptions`：0.6.12 会广告一个 CLI 自己拒绝的
  `M3.1-Flash` 非思考值（`Invalid model reasoning`），而非思考模型又会移除
  `thinkingEffort`。`probeModels()` 逐个选择一次，过滤失败值并记录每个模型自己的档位。
- **MiniMax 的区域与登录**：`MAVIS_REGION` 在建进程时固定为 `cn` / `en`（`minimaxCliRegion()`），
  登录态按 `~/.minimax/auth/prod/<region>/mcode-public/auth-state.json` 读取，并校验文件内
  记录的 `region`。官方 CLI 同一时间只允许一个站点在线，登录第二个站点会失败；插件如实显示
  该错误，不复制或搬运另一站的凭据。国内站/国际站的模型开关与窗口仍是独立字段。
- **MiniMax 的内置工具**：ACP 没有关闭 CLI 内置工具的选项。`HOST_TOOL_POLICY` 写进启动时的
  system prompt；`MinimaxAcp` 监听 `tool_call`，发现非 `mcp__dsh-host__` 的调用即
  `session/cancel`，`MinimaxSession` 随后用 `NATIVE_TOOL_CORRECTION` 让模型改用宿主工具重试
  （最多 2 次，用尽则本轮报错）。取消后的下一次 `session/prompt` 可能短暂返回
  “Session already has an active Turn”，`launchPrompt()` 按 200/400/800/1600ms 退避重试。
- **MiniMax 的 CLI 安装**：`src/minimax-cli.ts` 只固定执行 npm 的安装 / 卸载 argv，模式走
  白名单，不接受任何页面输入；安装参数必须包含 `--allow-scripts=@minimax-ai/code,better-sqlite3`
  与 `--ignore-scripts=false`，否则 npm 12 会跳过 better-sqlite3 的原生构建。
  `MCODE_CLI_PATH` 可指向 `cli.js` 或可执行文件；Windows 上优先解析 npm `.cmd` shim 背后的
  `cli.js`，避免 cmd.exe 夹在 ACP 的 stdio 之间。
- **MiniMax 的额度**：`minimaxUsage()` 读 CLI 的 OAuth 凭据
  （`~/.minimax/auth/prod/<region>/mcode-public/auth.json`）后调用 mcode 自己的接口：
  `/v1/api/user/info`（账号）、`/matrix/api/v1/user/get_user_extra_info`（个人 workspace 与
  `op_group_id`）、`/matrix/api/v1/commerce/get_membership_info`（套餐、积分、是否订阅 Token Plan）、
  `/v1/api/openplatform/coding_plan/remains`（5 小时 / 每周窗口）。前三个是签名网关，签名算法与
  CLI 一致：`yy = md5(encodeURIComponent(path+search) + '_' + body + md5(String(nowMs)) + 'ooui')`，
  `x-signature = md5(seconds + salt + body)`；remains 只需 bearer token 与 `X-Group-Id`。
  非订阅账号会收到 `base_resp.status_code = 2062`，此时不生成窗口，只显示积分。
  结果缓存 60 秒（`MINIMAX_USAGE_CACHE_TTL_MS`），登录、登出、CLI 变更都会清缓存。
  映射逻辑抽成 `minimaxUsageFromParts()`，可脱离网络单测。
- **MiniMax 的区域可达性**：两个站点的边缘节点对跨区请求返回 `307`，把 `.io` 指回
  `.minimaxi.com`（反向亦然）。跨 origin 重定向会丢掉 `Authorization`，账号接口于是返回空
  `401`，CLI 的原始错误也只是 `401 token is required`——这不是登录过期。`minimaxRegionBlocked()`
  先请求账号主机的 `/`（`redirect: 'manual'`），只把「重定向到另一站域名」判为区域不可用，
  超时或 DNS 失败不改变既有结论。判为不可用后，`minimaxUsage()` 直接返回一份只有
  `regionBlocked` 与提示的快照（不含账号/套餐/额度），`MinimaxCatalog` 与 `listModels()` 返回空，
  `dispatch()` 直接抛出同一条提示。结论缓存 30 秒；`fresh=1`、登录/登出，以及页面的区域切换
  都会先清掉结论再重新探测（切换时额度与目录同时开始，两者共享同一个在途探测，不会给出互相
  矛盾的判定）。`/models` 也会回传 `regionBlocked`，页面据此清掉该区域缓存的模型表，避免把
  别的网络的旧数据当成当前可用的目录；若手动刷新额度后判定恢复为可用，页面会自动重新读取
  模型列表，不需要切区再切回来。
- **MiniMax 的用量必须是整数**：`estimateTextTokens()` 按脚本计价并返回小数，而 DSH 的用量桶
  校验是 `z.number().int().nonnegative()`。直接上报小数时，流式回合能跑完，但用量投影会失败；
  用户切走再回来、会话重放该轮时就会看到 `failed to project session` /
  `uncachedInputTokens expected int`。所有 MiniMax 用量（warm 回合与旁路冷请求）都统一经
  `minimaxTurnUsage()` 输出：每个桶 `Math.ceil` 到整数，`reasoningTokens` 再钳制在
  `outputTokens` 之内。
- **额度**：`QoderUsage` 起一个不跑模型轮次的短命 `query()`，调用 SDK 的 `getUsageInfo()`；
  CLI 用自己的凭证查额度并返回与官方客户端一致的结构，插件只做展示与 1 分钟缓存。
- **版本开关**：`cnEnabled` / `intlEnabled` / `codebuddyEnabled` / `minimaxEnabled` 是结构字段。
  宿主在 `loader/volatile-update` 时重新注册或释放对应 adapter 路由，并按启用状态重建 picker
  目录；浏览器半侧同步 `settings.section` 的注册与释放。关闭是「不存在」，不是「隐藏」。
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
