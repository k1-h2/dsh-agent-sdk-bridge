# dsh-agent-sdk-bridge

把 **Qoder CN**、**Qoder 国际版**与 **CodeBuddy** 订阅接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 LLM 适配器插件。

> 本仓库是 [dsh-qoder-link](https://github.com/k1-h2/dsh-qoder-link) 插件的后续维护地址；除 Qoder 外，同仓库还接入了腾讯 CodeBuddy。

- **官方 SDK**：Qoder 用 [`@qodercn-ai/qodercn-agent-sdk`](https://www.npmjs.com/package/@qodercn-ai/qodercn-agent-sdk)
  与 [`@qoder-ai/qoder-agent-sdk`](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk)；
  CodeBuddy 用 [`@tencent-ai/agent-sdk`](https://www.npmjs.com/package/@tencent-ai/agent-sdk)。
- **零凭据**：复用本机 CLI 登录态，不需要 API key。
- **额度可见**：Qoder 显示套餐、已用百分比、剩余 credits、加量包与到期时间；CodeBuddy 通过其
  计费接口显示积分余额与各积分包（与官方账号页同源），卡片上的「用量明细」可直接打开当前区域
  官网的用量页。
- **三套设置页**：Qoder CN / Qoder 国际版 / CodeBuddy，各自独立的模型开关、上下文窗口与登录面板。

## 为什么需要它

Qoder 两家发行版各有一个官方 SDK，品牌在编译期写死，一个包只能服务一边：CN 包找不到国际版的
登录态，国际版包也找不到 CN 的。上游插件只依赖国际版包，在只装了 `qoderclicn` 的机器上模型
列表永远为空。

CodeBuddy 的官方 SDK 则自带 CLI，但同样需要按账号登录。本插件把三种接入放进同一个 provider
层：各装各的 SDK、各起各的会话，账号、模型目录与登录态互不串台。

## 安装

### 1. 装插件

**插件 → 添加插件**，填 `dsh-agent-sdk-bridge` 并安装（npm）；也可用
`github:k1-h2/dsh-agent-sdk-bridge` 或本地目录。

若提示**「需要允许安装脚本」**（SDK 下载自己的 worker runtime），点「允许这些脚本并重试」即可；
不授权也能用，SDK 会回退到 PATH 上的系统 CLI。装完按提示**重启 DSH**。

### 2. 登录

插件不持有凭据，内层会话直接复用对应 CLI 的登录态：

| 版本 | npm 包 | 登录方式 | 登录态目录 |
|---|---|---|---|
| Qoder CN | `@qodercn-ai/qoderclicn` | 页面「一键配置」或 `qoderclicn login` | `~/.qoder-cn/.auth` |
| Qoder 国际版 | `@qoder-ai/qodercli` | 页面「一键配置」或 `qodercli login` | `~/.qoder/.auth` |
| CodeBuddy | `@tencent-ai/agent-sdk`（已随插件安装） | 页面选择区域后点「登录」 | 由 CodeBuddy CLI 管理 |

**设置 → Qoder CN / Qoder 国际版** → 页面底部「一键配置」：缺 CLI 就装，未登录就拉起浏览器授权，
输出实时显示。**设置 → CodeBuddy** → 顶部选择「国际版（codebuddy.ai）」或「国内版
（copilot.tencent.com）」，点「登录」后在浏览器完成授权。两个区域的登录凭据分别保存在本机
（`~/.dsh/agent-sdk-bridge/codebuddy-state.json`，权限 0600），切换区域会立即恢复对应账号的
账号、额度与模型表，各自启用哪些模型和上下文窗口也按区域独立保存；未登录时不会读取或显示
模型目录。浏览器由 CodeBuddy CLI 打开，插件不再重复打开。企业域名 / IOA 登录不在支持范围内。

也可以手动执行 Qoder 的两步：

```bash
npm install -g @qodercn-ai/qoderclicn && qoderclicn login   # Qoder CN
npm install -g @qoder-ai/qodercli       && qodercli login    # 国际版
```

`qoderclicn status` / `qodercli status` 能列出 `Username` 即登录成功。Qoder 的一键配置只支持 Windows。

> `QODERCLI_PATH` 若指向另一版本的 CLI，对应版本会明确报错，而不是借用那个账号回答。国际版
> 专用覆盖变量是 `QODER_CLI_PATH`。更多见 [常见问题](./FAQ.md)。

## 设置页

**设置 → Qoder CN**、**设置 → Qoder 国际版**、**设置 → CodeBuddy** 是三个独立入口：

- **额度 / 登录卡片**：Qoder 显示套餐、已用百分比进度、套餐 / 加量包 / 组织资源包剩余量、到期时间，
  以及官方用量与升级链接；CodeBuddy 显示登录区域、账号、积分余额、已用百分比、各积分包与最近到期
  （通过其账号页使用的计费接口读取）。
- **模型清单**：来自账号实时目录，逐个启用 / 关闭、指定上下文窗口；倍率取自上游报价。
- **高级设置**：并发会话数、目录缓存、超时、默认思考档位、模型别名、分组名称等，可折叠。
- **CLI 分组**：Qoder 页面有一键配置 / 重新登录 / 卸载 CLI（卸载前确认，保留登录凭证），附实时输出。
- 再次打开页面时**先显示上次快照**，模型与账户在后台更新，不再每次都停在「正在读取」。

每个 provider 只注册一条路由（`qoder-cn` / `qoder-intl` / `codebuddy`），只服务订阅自带的模型；
BYOK 自定义模型会被过滤掉。

三个入口是否出现，在**插件 → Agent SDK Bridge → 启用的版本**里控制。关闭后对应的设置页、模型
列表、选择器分组与 provider 路由一起移除；已保存的模型选择保留，重新打开即可恢复。

## 用 YAML 配置

设置页之外，也可以直接写进 profile 的 `cordis.patch.yml`：

```yaml
- id: llm-qoder-cn
  name: dsh-agent-sdk-bridge
  config:
    cnEnabled: true
    intlEnabled: false                # 关闭国际版：设置页与模型分组一起移除
    displayName: Qoder CN (工作号)
    intlDisplayName: Qoder (Global)
    maxSessions: 4
    disabledModels: [mmodel]          # CN：关闭的模型
    modelContextWindows:
      qmodel_38max: 1000000           # CN：按模型指定窗口（token）
    intlDisabledModels: [auto]        # 国际版：独立的关闭清单
    intlModelContextWindows:
      dmodel: 1000000
    intlModelAliases:
      claude-sonnet: dmodel
    codebuddyRegion: cn                 # global（国际版）或 cn（国内版）
    codebuddyDisplayName: CodeBuddy
    codebuddyDisabledModels: [glm-5.2]
    codebuddyModelContextWindows:
      glm-5.3: 1000000
    codebuddyModelAliases:
      cb-fast: fast-model
```

各个 provider 的模型开关、窗口和别名是**分开的字段**；并发会话数、超时、思考档位等运行参数共享。

## 更多

- 问题排查与历史修复记录：[常见问题](./FAQ.md)
- 实现要点、开发须知与构建说明：[开发文档](./DEVELOPMENT.md)

## 合规与风险

本插件通过官方 Agent SDK 复用**你自己**的 Qoder / CodeBuddy 账号登录态：不逆向私有协议、
不伪造客户端身份或请求头、不自动化领取签到积分，也不向任何第三方域名发送数据。

但请自行判断：「以订阅额度驱动第三方宿主」是否符合对应服务的条款，本项目无法替你解释，
也不保证账号不被限制；上游接口与 SDK 可能变更，届时插件可能失效。请仅用于你自己的账号。

## 许可

MIT。本仓库是 [JiamingZang/dsh-llm-qodersdk](https://github.com/JiamingZang/dsh-llm-qodersdk)
（MIT）的衍生作品，上游许可与版权声明保留在 [`LICENSE.original`](./LICENSE.original)，出处与
改动清单见 [`NOTICE`](./NOTICE)。
