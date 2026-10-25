/**
 * dsh-agent-sdk-bridge — browser half.
 *
 * Contributes one top-level settings section per enabled provider (`qoder-cn`,
 * `qoder-intl`, `codebuddy`), each showing its account card and then the model
 * list: every model the account exposes, with an on/off switch and a
 * context-window choice, plus a collapsed "advanced" area holding the scalars
 * worth reaching without editing YAML. The plugin manager's page for this
 * bundle carries the switches that decide which of those sections exist.
 *
 * The model list cannot come from the config form: it is fetched live from the
 * provider. So the page reads `GET <prefix>/models`, which joins that live
 * catalog with the user's stored choices, while every change goes back through
 * the host's own config form. The host owns the catalog, so the page never
 * derives state the adapter does not share.
 *
 * The page can also start the CLI helper shipped with this package
 * (`POST <prefix>/setup`, then `GET <prefix>/setup` for its output): installing
 * and signing into qoderclicn is a local action a browser cannot perform.
 *
 * Rendering from the schema-driven form alone would be wrong here: the useful
 * controls depend on rows that only exist at runtime.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. Colour comes from theme variables so the
 * page survives a scheme switch.
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-sdk-bridge',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } = React

    /** The plugin's config namespace — must equal the profile row id. */
    const NS = 'llm-qoder-cn'
    const inject = ['slots', 'locale', 'configForms']

    // ── copy ────────────────────────────────────────────────────────────────
    const zh = {
      nav: 'Qoder CN',
      title: 'Qoder CN',
      intro: '勾选要启用的模型，并为需要的模型指定上下文窗口。改动即时生效，无需重启。',
      loading: '正在读取模型列表…',
      loadFailed: '读取模型列表失败',
      retry: '重试',
      refresh: '刷新列表',
      refreshing: '刷新中…',
      saveFailed: '保存失败',
      notApplied: '服务器未报告这次改动，可能被其他窗口覆盖了，请刷新后重试',
      timeout: '保存超时，请重试',
      saved: '已保存',
      saving: '保存中…',
      enabledCount: '已启用',
      noModels: '账号没有返回任何模型：一般是本机 qoderclicn 还没装好，或者还没登录。',
      search: '搜索模型…',
      onlyEnabled: '只看已启用',
      selectAll: '全部启用',
      selectNone: '全部关闭',
      colEnabled: '启用',
      windowDefault: '默认',
      windowDefaultHint: '跟随上游声明的窗口',
      vision: '读图',
      free: '免费',
      advanced: '高级设置',
      advancedHint: '以下为细节参数，通常无需改动。',
      show: '展开',
      hide: '收起',
      reset: '恢复默认',
      windowWarn: '窗口越大，DSH 的自动压缩触发得越晚。若对话经常超限，请选较小的窗口。',
      cliGroup: 'Qoder CN CLI',
      cliHint: '插件复用本机 qoderclicn 的登录态。这里可以直接跑随包附带的配置脚本：缺 CLI 就装，未登录就拉起浏览器登录。',
      cliRun: '一键配置',
      cliLogin: '重新登录',
      cliRunning: '正在执行，输出持续刷新…',
      cliStartFailed: '无法启动配置脚本',
      cliExitOk: '配置脚本执行完成',
      cliExitFail: '配置脚本未通过，退出码',
      cliShowLog: '查看输出',
      cliHideLog: '收起输出',
      cliUninstall: '卸载 CLI',
      cliUninstallConfirm: '确定要卸载本机的 Qoder CLI 吗？卸载后需要重新安装才能继续使用，登录凭证会保留。',
      cliUninstalling: '正在卸载…',
      cliUninstallOk: 'CLI 已卸载',
      intlNav: 'Qoder 国际版',
      intlTitle: 'Qoder 国际版',
      intlIntro: '国际版账户（qoder.com）的模型与额度。勾选要启用的模型，并为需要的模型指定上下文窗口。改动即时生效，无需重启。',
      intlNoModels: '国际版账号没有返回任何模型：一般是本机 qodercli 还没装好，或者还没登录。',
      intlCliGroup: 'Qoder 国际版 CLI',
      intlCliHint: '插件复用本机 qodercli 的登录态。这里可以直接跑随包附带的配置脚本：缺 CLI 就装，未登录就拉起浏览器登录。',
      usageTitle: '额度',
      usageLoading: '正在读取额度…',
      usageRefresh: '刷新额度',
      usageUnavailable: '无法读取额度',
      usageRetry: '重试',
      usageAccount: '账号',
      usagePlan: '套餐',
      usageUsed: '已用',
      usageRemaining: '剩余',
      usageOf: '/',
      usageCredits: 'credits',
      usagePlanQuota: '套餐额度',
      usageAddOn: '加量包',
      usageOrgPackage: '组织资源包',
      usageExpires: '到期',
      usageNever: '长期有效',
      usageDetail: '用量明细',
      usageUpgrade: '升级套餐',
      usageExceeded: '额度已用完',
      usageUpdated: '更新于',
      usageUnknownPlan: '未知套餐',
      usageStale: '显示上次读数，刷新失败',
      pluginOptionsTitle: '启用的版本',
      pluginOptionsHint: '关闭后，对应设置页、模型列表与模型分组都会移除；已保存的模型选择保留，重新打开即可恢复。',
      pluginOptionsOn: '显示中',
      pluginOptionsOff: '已关闭',
      pluginOptionsReadOnly: '当前配置不可写',
      pluginOptionsRejected: '宿主拒绝了这次改动；若刚更新过插件，请重启 DSH 后再试',
      codebuddyNav: 'CodeBuddy',
      codebuddyTitle: 'CodeBuddy',
      codebuddyIntro: '腾讯 CodeBuddy 账户的模型。请先在下方选择登录区域并登录，再勾选要启用的模型。',
      codebuddyNoModels: 'CodeBuddy 账号没有返回任何模型：请确认已选择登录区域并完成登录。',
      codebuddyAuthTitle: '登录',
      codebuddyAuthHint: 'CodeBuddy 分国际版与国内版，两边账号与模型目录独立。企业域名登录不在本插件支持范围内。',
      codebuddyRegionGlobal: '国际版（codebuddy.ai）',
      codebuddyRegionCn: '国内版（copilot.tencent.com）',
      codebuddyRegionLabel: '登录区域',
      codebuddyLogin: '登录',
      codebuddyLogout: '退出登录',
      codebuddyLoggingIn: '请在浏览器中完成登录…',
      codebuddyLoginPrompt: '登录后这里会显示账号与额度信息。',
      codebuddyModelsHint: '请先登录 CodeBuddy，登录后才会读取并显示可用模型。',
      codebuddyRegionMismatch: '宿主返回的模型列表不属于当前区域，请刷新页面后重试。',
      codebuddyLoginStarted: '已打开浏览器，完成登录后这里会自动更新。',
      codebuddyLoginFailed: '登录失败',
      codebuddyOpenUrl: '手动打开登录页',
      codebuddyLoggedOut: '已退出登录',
      codebuddyNotLoggedIn: '未登录',
      codebuddySignedIn: '已登录',
      codebuddyAccountUnknown: '账号信息暂不可用',
      codebuddyNoQuota: '暂时无法读取额度。',
      codebuddyQuotaFailed: '额度读取失败',
      codebuddyQuotaTitle: '积分额度',
      codebuddyQuotaPackages: '积分包',
      codebuddyQuotaExpires: '最近到期',
      codebuddyConfirmLogout: '确定要退出当前区域的 CodeBuddy 登录吗？',
      minimaxNav: 'MiniMax Code',
      minimaxTitle: 'MiniMax Code',
      minimaxIntro: '通过 Agent Client Protocol 接入 MiniMax Code（mcode acp）。选择登录区域并完成登录后，才会读取模型目录。',
      minimaxNoModels: 'MiniMax Code 账号没有返回任何模型：请确认 CLI 已安装、已选择区域并完成登录。',
      minimaxAuthTitle: '登录与 CLI',
      minimaxAuthHint: 'MiniMax Code 分国内站与国际站，模型目录独立。登录由 mcode CLI 完成，凭据保存在本机；CLI 同一时间只允许一个站点登录，切换前请先在另一站点退出登录。',
      minimaxRegionGlobal: '国际站（account.minimax.io）',
      minimaxRegionCn: '国内站（account.minimax.cn）',
      minimaxRegionLabel: '登录区域',
      minimaxLogin: '登录',
      minimaxLogout: '退出登录',
      minimaxLoggingIn: '请在浏览器中完成授权…',
      minimaxLoginPrompt: '登录后这里会显示账号状态与可用模型。',
      minimaxModelsHint: '请先安装并登录 MiniMax Code，登录后才会读取并显示可用模型。',
      minimaxRegionMismatch: '宿主返回的模型列表不属于当前区域，请刷新页面后重试。',
      minimaxLoginStarted: '已打开浏览器，完成授权后这里会自动更新。',
      minimaxLoginFailed: '登录失败',
      minimaxOpenUrl: '手动打开授权页',
      minimaxNotLoggedIn: '未登录',
      minimaxSignedIn: '已登录',
      minimaxConfirmLogout: '确定要退出当前区域的 MiniMax Code 登录吗？',
      minimaxCliGroup: 'MiniMax Code CLI',
      minimaxCliHint: '安装的是 @minimax-ai/code（含 native SQLite）。普通 npm 安装会被 npm 12 拦截安装脚本，导致 mcode 无法启动，这里使用官方要求的参数。',
      minimaxCliInstalled: '已安装',
      minimaxCliMissing: '未安装',
      minimaxCliInstall: '安装 / 更新 CLI',
      minimaxCliUninstall: '卸载 CLI',
      minimaxCliInstalling: '正在安装…',
      minimaxCliUninstalling: '正在卸载…',
      minimaxConfirmUninstall: '确定要卸载全局 MiniMax Code CLI 吗？登录态会保留。',
      minimaxCliFailed: 'CLI 操作失败',
      minimaxShowOutput: '查看输出',
      minimaxHideOutput: '收起输出',
      minimaxNoUsage: '登录后会显示账号、套餐与剩余额度。',
      minimaxCliRequired: '请先安装 MiniMax Code CLI，再登录。',
      minimaxExpires: '凭据到期',
      minimaxAccount: '账号',
      minimaxAccountUnknown: '未知账号',
      minimaxPlan: '当前套餐',
      minimaxPlanTokenPlan: 'Token Plan',
      minimaxPlanCredits: '积分',
      minimaxPlanFree: '免费',
      minimaxCredits: '剩余积分',
      minimaxCreditsPurchased: '其中购买',
      minimaxCreditsFree: '其中赠送',
      minimaxQuotaRemaining: '剩余',
      minimaxQuotaReset: '重置于',
      minimaxQuotaUnlimited: '不限',
      minimaxQuotaNone: '当前账号没有 Token Plan 额度窗口。',
      minimaxUsageLoading: '正在读取账号与额度…',
      minimaxUsageFailed: '额度读取失败',
      advancedFields: {
        displayName: '分组名称',
        maxSessions: '并发会话数',
        modelCacheTtlSeconds: '模型列表缓存（秒）',
        defaultReasoningEffort: '默认思考档位',
        defaultMaxTokens: '默认输出上限',
        toolResultTimeoutSeconds: '工具结果等待（秒）',
        catalogFetchTimeoutSeconds: '模型列表超时（秒）',
        abortGraceSeconds: '中断宽限（秒）',
        coldMaxTurns: '旁路请求轮次',
        modelAliases: '模型别名',
        intlDisplayName: '国际版分组名称',
        intlModelAliases: '国际版模型别名',
        codebuddyDisplayName: 'CodeBuddy 分组名称',
        codebuddyModelAliases: 'CodeBuddy 模型别名',
        minimaxDisplayName: 'MiniMax 分组名称',
        minimaxModelAliases: 'MiniMax 模型别名',
      },
    }
    const en = {
      nav: 'Qoder CN',
      title: 'Qoder CN',
      intro: 'Tick the models you want available and set a context window where needed. Changes apply immediately.',
      loading: 'Loading models…',
      loadFailed: 'Could not load the model list',
      retry: 'Retry',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      saveFailed: 'Save failed',
      notApplied: 'The host did not report this change; another window may have overwritten it. Refresh and retry.',
      timeout: 'Save timed out; please retry',
      saved: 'Saved',
      saving: 'Saving…',
      enabledCount: 'enabled',
      noModels: 'The account returned no models - usually qoderclicn is not installed on this machine, or not signed in.',
      search: 'Search models…',
      onlyEnabled: 'Enabled only',
      selectAll: 'Enable all',
      selectNone: 'Disable all',
      colEnabled: 'On',
      windowDefault: 'Default',
      windowDefaultHint: "Follow upstream's declared window",
      vision: 'Vision',
      free: 'Free',
      advanced: 'Advanced',
      advancedHint: 'Detail parameters; rarely changed.',
      show: 'Show',
      hide: 'Hide',
      reset: 'Reset',
      windowWarn: 'A larger window delays DSH\u2019s auto-compaction. Pick a smaller one if conversations overflow.',
      cliGroup: 'Qoder CN CLI',
      cliHint: 'The plugin reuses this machine\u2019s qoderclicn sign-in. Run the bundled helper from here: it installs the CLI when missing and opens the browser sign-in when signed out.',
      cliRun: 'Configure',
      cliLogin: 'Re-login',
      cliRunning: 'Running, output refreshes…',
      cliStartFailed: 'Could not start the helper',
      cliExitOk: 'Helper finished',
      cliExitFail: 'Helper failed with exit code',
      cliShowLog: 'Show output',
      cliHideLog: 'Hide output',
      cliUninstall: 'Uninstall CLI',
      cliUninstallConfirm: 'Uninstall the Qoder CLI from this machine? It must be installed again to keep using this edition. Sign-in files are kept.',
      cliUninstalling: 'Uninstalling…',
      cliUninstallOk: 'CLI uninstalled',
      intlNav: 'Qoder International',
      intlTitle: 'Qoder International',
      intlIntro: 'Models and quota for the international account (qoder.com). Tick the models you want available and set a context window where needed. Changes apply immediately.',
      intlNoModels: 'The international account returned no models - usually qodercli is not installed on this machine, or not signed in.',
      intlCliGroup: 'Qoder International CLI',
      intlCliHint: 'The plugin reuses this machine\u2019s qodercli sign-in. Run the bundled helper from here: it installs the CLI when missing and opens the browser sign-in when signed out.',
      usageTitle: 'Quota',
      usageLoading: 'Reading quota…',
      usageRefresh: 'Refresh quota',
      usageUnavailable: 'Could not read the quota',
      usageRetry: 'Retry',
      usageAccount: 'Account',
      usagePlan: 'Plan',
      usageUsed: 'Used',
      usageRemaining: 'Remaining',
      usageOf: '/',
      usageCredits: 'credits',
      usagePlanQuota: 'Plan quota',
      usageAddOn: 'Add-on package',
      usageOrgPackage: 'Organization package',
      usageExpires: 'Expires',
      usageNever: 'No expiry',
      usageDetail: 'Usage details',
      usageUpgrade: 'Upgrade',
      usageExceeded: 'Quota exhausted',
      usageUpdated: 'Updated',
      usageUnknownPlan: 'Unknown plan',
      usageStale: 'Showing the last reading; refresh failed',
      pluginOptionsTitle: 'Enabled editions',
      pluginOptionsHint: 'Turning one off removes its settings page, model list, and model group. Saved model choices are kept, so turning it back on restores them.',
      pluginOptionsOn: 'Shown',
      pluginOptionsOff: 'Off',
      pluginOptionsReadOnly: 'This configuration is read-only',
      pluginOptionsRejected: 'The host rejected this change; if you just updated the plugin, restart DSH and retry',
      codebuddyNav: 'CodeBuddy',
      codebuddyTitle: 'CodeBuddy',
      codebuddyIntro: 'Models for your Tencent CodeBuddy account. Choose a login region below and sign in before enabling models.',
      codebuddyNoModels: 'The CodeBuddy account returned no models: make sure a region is selected and the browser login completed.',
      codebuddyAuthTitle: 'Sign in',
      codebuddyAuthHint: 'CodeBuddy has independent international and mainland accounts with their own model catalogs. Enterprise-domain login is out of scope for this plugin.',
      codebuddyRegionGlobal: 'International (codebuddy.ai)',
      codebuddyRegionCn: 'Mainland (copilot.tencent.com)',
      codebuddyRegionLabel: 'Login region',
      codebuddyLogin: 'Sign in',
      codebuddyLogout: 'Sign out',
      codebuddyLoggingIn: 'Finish the sign-in in your browser…',
      codebuddyLoginPrompt: 'Sign in to see the account and quota here.',
      codebuddyModelsHint: 'Sign in to CodeBuddy first; the model catalog is read only after sign-in.',
      codebuddyRegionMismatch: 'The host answered with the other region\'s models; reload the page and try again.',
      codebuddyLoginStarted: 'Browser opened; this card updates when the login completes.',
      codebuddyLoginFailed: 'Sign-in failed',
      codebuddyOpenUrl: 'Open the sign-in page',
      codebuddyLoggedOut: 'Signed out',
      codebuddyNotLoggedIn: 'Not signed in',
      codebuddySignedIn: 'Signed in',
      codebuddyAccountUnknown: 'Account details are unavailable',
      codebuddyNoQuota: 'The quota is temporarily unavailable.',
      codebuddyQuotaFailed: 'Could not read the quota',
      codebuddyQuotaTitle: 'Credits',
      codebuddyQuotaPackages: 'Credit packages',
      codebuddyQuotaExpires: 'Earliest expiry',
      codebuddyConfirmLogout: 'Sign out of CodeBuddy for the selected region?',
      minimaxNav: 'MiniMax Code',
      minimaxTitle: 'MiniMax Code',
      minimaxIntro: 'MiniMax Code over the Agent Client Protocol (mcode acp). Choose a login region and sign in before the catalog is read.',
      minimaxNoModels: 'The MiniMax Code account returned no models: make sure the CLI is installed, a region is selected, and the login completed.',
      minimaxAuthTitle: 'Sign in and CLI',
      minimaxAuthHint: 'MiniMax Code has independent mainland and international catalogs. Login runs through the mcode CLI and the credential stays on this machine; the CLI allows one region at a time, so sign out of the other before switching.',
      minimaxRegionGlobal: 'International (account.minimax.io)',
      minimaxRegionCn: 'Mainland (account.minimax.cn)',
      minimaxRegionLabel: 'Login region',
      minimaxLogin: 'Sign in',
      minimaxLogout: 'Sign out',
      minimaxLoggingIn: 'Finish the authorization in your browser…',
      minimaxLoginPrompt: 'Sign in to see the account state and available models.',
      minimaxModelsHint: 'Install and sign in to MiniMax Code first; the model catalog is read only after sign-in.',
      minimaxRegionMismatch: 'The host answered with the other region\'s models; reload the page and try again.',
      minimaxLoginStarted: 'Browser opened; this card updates when the login completes.',
      minimaxLoginFailed: 'Sign-in failed',
      minimaxOpenUrl: 'Open the authorization page',
      minimaxNotLoggedIn: 'Not signed in',
      minimaxSignedIn: 'Signed in',
      minimaxConfirmLogout: 'Sign out of MiniMax Code for the selected region?',
      minimaxCliGroup: 'MiniMax Code CLI',
      minimaxCliHint: 'Installs @minimax-ai/code (including its native SQLite dependency). npm 12 blocks install scripts by default, which leaves mcode unable to start; the official flags are used here.',
      minimaxCliInstalled: 'Installed',
      minimaxCliMissing: 'Not installed',
      minimaxCliInstall: 'Install / update CLI',
      minimaxCliUninstall: 'Uninstall CLI',
      minimaxCliInstalling: 'Installing…',
      minimaxCliUninstalling: 'Uninstalling…',
      minimaxConfirmUninstall: 'Uninstall the global MiniMax Code CLI? The login state is kept.',
      minimaxCliFailed: 'CLI action failed',
      minimaxShowOutput: 'Show output',
      minimaxHideOutput: 'Hide output',
      minimaxNoUsage: 'Sign in to see the account, plan and remaining quota.',
      minimaxCliRequired: 'Install the MiniMax Code CLI before signing in.',
      minimaxExpires: 'Credential expires',
      minimaxAccount: 'Account',
      minimaxAccountUnknown: 'Unknown account',
      minimaxPlan: 'Plan',
      minimaxPlanTokenPlan: 'Token Plan',
      minimaxPlanCredits: 'Credits',
      minimaxPlanFree: 'Free',
      minimaxCredits: 'Remaining credits',
      minimaxCreditsPurchased: 'purchased',
      minimaxCreditsFree: 'free',
      minimaxQuotaRemaining: 'remaining',
      minimaxQuotaReset: 'resets at',
      minimaxQuotaUnlimited: 'Unlimited',
      minimaxQuotaNone: 'This account has no Token Plan quota windows.',
      minimaxUsageLoading: 'Reading the account and quota…',
      minimaxUsageFailed: 'Could not read the quota',
      advancedFields: {
        displayName: 'Group name',
        maxSessions: 'Concurrent sessions',
        modelCacheTtlSeconds: 'Catalog cache (s)',
        defaultReasoningEffort: 'Default reasoning effort',
        defaultMaxTokens: 'Default output cap',
        toolResultTimeoutSeconds: 'Tool result wait (s)',
        catalogFetchTimeoutSeconds: 'Catalog timeout (s)',
        abortGraceSeconds: 'Abort grace (s)',
        coldMaxTurns: 'Side-channel turns',
        modelAliases: 'Model aliases',
        intlDisplayName: 'International group name',
        intlModelAliases: 'International model aliases',
        codebuddyDisplayName: 'CodeBuddy group name',
        codebuddyModelAliases: 'CodeBuddy model aliases',
        minimaxDisplayName: 'MiniMax group name',
        minimaxModelAliases: 'MiniMax model aliases',
      },
    }

    /**
     * Scalars shown under Advanced, in order, with how to render each.
     *
     * The schema is the source of truth for labels, help text and bounds; this
     * list only decides order and which control each field gets.
     */
    const ADVANCED = {
      cn: [
        ['displayName', 'text'],
        ['maxSessions', 'number'],
        ['modelCacheTtlSeconds', 'number'],
        ['defaultReasoningEffort', 'text'],
        ['defaultMaxTokens', 'number'],
        ['toolResultTimeoutSeconds', 'number'],
        ['catalogFetchTimeoutSeconds', 'number'],
        ['abortGraceSeconds', 'number'],
        ['coldMaxTurns', 'number'],
        ['modelAliases', 'json'],
      ],
      // The shared scalars above already have a home on the CN page; the intl
      // page only adds what is specific to that edition, so the same setting is
      // never edited in two places with two different values.
      global: [
        ['intlDisplayName', 'text'],
        ['intlModelAliases', 'json'],
      ],
      codebuddy: [
        ['codebuddyDisplayName', 'text'],
        ['codebuddyModelAliases', 'json'],
      ],
      minimax: [
        ['minimaxDisplayName', 'text'],
        ['minimaxModelAliases', 'json'],
      ],
    }

    /**
     * One settings section per provider.
     *
     * They share the page component and the API routes; only the config keys,
     * the API brand and the copy differ.
     */
    const BRANDS = [
      {
        id: 'cn',
        kind: 'qoder',
        settingsId: 'qoder-cn',
        order: 36,
        titleKey: 'title',
        navKey: 'nav',
        introKey: 'intro',
        noModelsKey: 'noModels',
        cliGroupKey: 'cliGroup',
        cliHintKey: 'cliHint',
        fields: {
          enabled: 'cnEnabled',
          disabled: 'disabledModels',
          windows: 'modelContextWindows',
        },
      },
      {
        id: 'global',
        kind: 'qoder',
        settingsId: 'qoder-intl',
        order: 37,
        titleKey: 'intlTitle',
        navKey: 'intlNav',
        introKey: 'intlIntro',
        noModelsKey: 'intlNoModels',
        cliGroupKey: 'intlCliGroup',
        cliHintKey: 'intlCliHint',
        fields: {
          enabled: 'intlEnabled',
          disabled: 'intlDisabledModels',
          windows: 'intlModelContextWindows',
        },
      },
      {
        id: 'codebuddy',
        kind: 'codebuddy',
        settingsId: 'codebuddy',
        order: 38,
        titleKey: 'codebuddyTitle',
        navKey: 'codebuddyNav',
        introKey: 'codebuddyIntro',
        noModelsKey: 'codebuddyNoModels',
        fields: {
          enabled: 'codebuddyEnabled',
          // The page swaps these for the selected login region's own fields.
          disabled: 'codebuddyGlobalDisabledModels',
          windows: 'codebuddyGlobalModelContextWindows',
        },
      },
      {
        id: 'minimax',
        kind: 'minimax',
        settingsId: 'minimax',
        order: 39,
        titleKey: 'minimaxTitle',
        navKey: 'minimaxNav',
        introKey: 'minimaxIntro',
        noModelsKey: 'minimaxNoModels',
        fields: {
          enabled: 'minimaxEnabled',
          // Swapped for the selected region's fields, like CodeBuddy.
          disabled: 'minimaxCnDisabledModels',
          windows: 'minimaxCnModelContextWindows',
        },
      },
    ]

    const css = {
      page: { maxWidth: '860px', display: 'flex', flexDirection: 'column', gap: '14px', color: 'var(--dsw-alias-label-primary)' },
      h2: { margin: '0', fontSize: '1.25em' },
      intro: { margin: '0', opacity: 0.72, lineHeight: 1.55, fontSize: '0.92em' },
      bar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      btn: { padding: '6px 12px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: '0.88em' },
      input: { padding: '6px 10px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit', font: 'inherit', fontSize: '0.88em' },
      search: { flex: '1 1 180px', minWidth: '140px' },
      count: { fontSize: '0.85em', opacity: 0.7, marginLeft: 'auto' },
      list: { display: 'flex', flexDirection: 'column', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', borderRadius: '10px', overflow: 'hidden' },
      row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))' },
      rowFirst: { borderTop: 'none' },
      rowOff: { opacity: 0.5 },
      name: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      nameText: { fontSize: '0.92em', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      id: { fontSize: '0.76em', opacity: 0.55, fontFamily: 'ui-monospace, monospace' },
      tag: { fontSize: '0.72em', padding: '1px 6px', borderRadius: '5px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', opacity: 0.75 },
      price: { fontSize: '0.9em', opacity: 0.7, fontWeight: 400 },
      select: { padding: '5px 8px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit', font: 'inherit', fontSize: '0.85em', minWidth: '104px' },
      switch: { width: '17px', height: '17px', cursor: 'pointer', accentColor: 'var(--dsw-alias-brand-primary, #4c6ef5)' },
      note: { fontSize: '0.82em', opacity: 0.62, lineHeight: 1.5 },
      err: { fontSize: '0.86em', color: 'var(--dsw-alias-label-danger, #e03131)' },
      guide: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '12px 14px', borderRadius: '10px', border: '1px solid var(--dsw-alias-label-danger, #e03131)', background: 'rgba(224,49,49,0.07)' },
      guideText: { flex: '1 1 240px', fontSize: '0.88em', lineHeight: 1.5, color: 'var(--dsw-alias-label-danger, #e03131)' },
      btnAlert: { border: '1px solid var(--dsw-alias-label-danger, #e03131)', color: 'var(--dsw-alias-label-danger, #e03131)' },
      group: { display: 'flex', flexDirection: 'column', gap: '10px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', borderRadius: '10px', padding: '14px 16px' },
      advLabel: { fontSize: '0.88em' },
      h3: { margin: 0, fontSize: '0.95em' },
      log: { margin: '0', maxHeight: '240px', overflowY: 'auto', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', background: 'var(--dsw-alias-bg-base, rgba(128,128,128,0.05))', fontFamily: 'ui-monospace, monospace', fontSize: '0.76em', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      usageCard: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', background: 'var(--dsw-alias-bg-base, rgba(128,128,128,0.03))' },
      usageHead: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      usagePct: { marginLeft: 'auto', fontSize: '0.9em', fontWeight: 600 },
      progressOuter: { height: '8px', borderRadius: '999px', background: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.22))', overflow: 'hidden' },
      progressInner: { height: '100%', borderRadius: '999px', background: 'var(--dsw-alias-brand-primary, #4c6ef5)', transition: 'width .25s ease' },
      progressDanger: { background: 'var(--dsw-alias-label-danger, #e03131)' },
      usageLine: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', fontSize: '0.86em' },
      usageLabel: { opacity: 0.62, minWidth: '72px' },
      usageValue: { fontWeight: 500 },
      link: { color: 'var(--dsw-alias-brand-primary, #4c6ef5)', textDecoration: 'none', fontSize: '0.86em' },
      usageFoot: { display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', fontSize: '0.8em', opacity: 0.6 },
      optionRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))' },
      optionFirst: { borderTop: 'none', paddingTop: 0 },
      optionText: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      optionName: { fontSize: '0.92em', fontWeight: 500 },
      optionStatus: { fontSize: '0.82em', opacity: 0.62 },
    }

    /**
     * Same-origin API base, resolved against the document so a deployment under
     * a sub-path still reaches its own host.
     */
    const API = (() => {
      try { return new URL('api/llm-qoder-cn', document.baseURI).pathname } catch { return '/api/llm-qoder-cn' }
    })()

    /**
     * Last successful answer per edition, so reopening a settings page paints
     * the previous content immediately and refreshes behind it.
     *
     * The cache is deliberately stale-while-revalidate: the page never waits on
     * the CLI just to show something it showed a minute ago. Both the model list
     * and the quota reading are cached separately because they are fetched by
     * different cards. `localStorage` keeps the snapshot across a page reload;
     * the in-memory map covers a deployment where storage is unavailable.
     */
    const CACHE_PREFIX = 'dsh-agent-sdk-bridge/cache/v1'
    const cacheMemory = new Map()

    function cacheKey(brand, kind) {
      return `${CACHE_PREFIX}:${brand}:${kind}`
    }

    function readCache(brand, kind) {
      const key = cacheKey(brand, kind)
      const held = cacheMemory.get(key)
      if (held !== undefined) return held
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null) return undefined
        const parsed = JSON.parse(raw)
        cacheMemory.set(key, parsed)
        return parsed
      } catch {
        return undefined
      }
    }

    function writeCache(brand, kind, value) {
      const key = cacheKey(brand, kind)
      cacheMemory.set(key, value)
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* private mode or a full quota: the in-memory copy still works */
      }
    }

    /** Call the plugin's model API. */
    async function api(path, options) {
      const { timeout = 30_000, ...rest } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...rest, signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * How long a settings write may take before the page gives up on it.
     *
     * A config write is a round trip to the host, which commits the value into
     * the running plugin before it answers, so this is not a normal-path limit —
     * it is a floor under the UI. Without it a wire call that never settles
     * leaves every control disabled forever, which is exactly how this page was
     * previously reported as frozen.
     */
    const WRITE_TIMEOUT_MS = 20_000

    /** Settle with `promise`, or reject with `message` once `ms` elapse. */
    function withDeadline(promise, ms, message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms)
        promise.then(
          value => { clearTimeout(timer); resolve(value) },
          error => { clearTimeout(timer); reject(error) },
        )
      })
    }

    /** Compact label for a token count. */
    function windowLabel(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
      if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1))}M`
      if (n >= 1000) return `${Math.round(n / 1000)}K`
      return String(n)
    }

    /**
     * The credit multiplier upstream quotes, as a short suffix.
     *
     * `0` renders as 免费 rather than `x0`, matching how the Qoder client shows
     * a free model. A model upstream quoted no multiplier for gets no suffix at
     * all — inventing one would misstate its cost.
     */
    function priceSuffix(t, factor) {
      if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0) return ''
      if (factor === 0) return t('free')
      return `x${Number(factor.toFixed(4))}`
    }

    /** A 0–100 percentage, clamped, or undefined when the value is not a number. */
    function percentOf(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      return Math.max(0, Math.min(100, value))
    }

    /** A credit count with group separators; dashes for absent values. */
    function creditsOf(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    }

    /**
     * Whether a timestamp means "no expiry".
     *
     * The quota endpoint reports plan end dates as a sentinel far in the future
     * (year 9999). Rendering that as a date is technically true and practically
     * noise, so it is shown as "never".
     */
    function neverExpires(ms) {
      return typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0 || ms > Date.now() + 50 * 365 * 24 * 3600 * 1000
    }

    /** A short local date for an epoch-millisecond value. */
    function dateLabel(ms) {
      try { return new Date(ms).toLocaleDateString('zh-CN') } catch { return String(ms) }
    }

    /**
     * One quota bucket as a line: label, `remaining / total`, percentage.
     *
     * Both editions quote the same shape (`userQuota`, `addOnQuota`,
     * `orgResourcePackage`), so the three render through one function; a bucket
     * the account does not have is simply not passed in.
     */
    function QuotaLine({ t, label, bucket, fallbackUnit }) {
      if (bucket === undefined || bucket === null) return null
      const total = bucket.total ?? bucket.cap
      const remaining = bucket.remaining
      const used = bucket.used
      // A plan bucket the account does not have is reported as all zeros; an
      // empty line describes nothing, so it is omitted rather than rendered.
      if ((total === undefined || total === 0) && remaining === undefined) return null
      const pct = percentOf(bucket.percentage)
      const unit = bucket.unit ?? fallbackUnit ?? t('usageCredits')
      const amount = remaining !== undefined && total !== undefined
        ? `${t('usageRemaining')} ${creditsOf(remaining)} ${t('usageOf')} ${creditsOf(total)} ${unit}`
        : total !== undefined
          ? `${t('usageUsed')} ${creditsOf(used)} ${t('usageOf')} ${creditsOf(total)} ${unit}`
          : '—'
      return h('div', { style: css.usageLine },
        h('span', { style: css.usageLabel }, label),
        h('span', { style: css.usageValue }, amount),
        pct === undefined ? null : h('span', { style: { opacity: 0.55 } }, `${Number(pct.toFixed(1))}%`),
      )
    }

    /**
     * Account quota and usage, read through the CLI.
     *
     * This is the same data the Qoder clients show on their account panel: plan,
     * percentage used, remaining credits, add-on package, expiry and the
     * upgrade/usage links. It is fetched from the host (which asks the CLI), not
     * from the provider directly, because only the CLI holds a usable token.
     */
    function UsageCard({ t, brand, refreshSignal }) {
      const [snapshot, setSnapshot] = useState(() => readCache(brand.id, 'usage'))
      const [failure, setFailure] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const ticket = useRef(0)

      const load = useCallback(async (fresh = false) => {
        const mine = ++ticket.current
        setBusy(true)
        setFailure(undefined)
        try {
          const payload = await api(`/usage?brand=${brand.id}${fresh ? '&fresh=1' : ''}`, { timeout: 45_000 })
          if (mine !== ticket.current) return
          // A failed account lookup (signed out, endpoint down) must not replace
          // the last good reading with an empty card: keep it and say so.
          if (payload?.usage === undefined && payload?.error !== undefined) {
            setFailure(String(payload.error))
            return
          }
          setSnapshot(payload)
          writeCache(brand.id, 'usage', payload)
        } catch (err) {
          if (mine !== ticket.current) return
          setFailure(String(err?.message ?? err))
        } finally {
          if (mine === ticket.current) setBusy(false)
        }
      }, [brand.id])

      // `refreshSignal` changes after a CLI install or uninstall, both of which
      // make the cached account reading describe a machine state that is gone.
      useEffect(() => { void load() }, [load, refreshSignal])

      const usage = snapshot?.usage
      const account = snapshot?.account
      const error = failure ?? (snapshot?.usage === undefined && snapshot?.error !== undefined ? String(snapshot.error) : undefined)
      const pct = percentOf(usage?.totalUsagePercentage)
      const plan = account?.subscriptionType ?? usage?.userType ?? t('usageUnknownPlan')
      const identity = account?.name ?? account?.email ?? usage?.userId
      const exceeded = usage?.isQuotaExceeded === true

      const head = h('div', { style: css.usageHead },
        h('h3', { style: css.h3 }, t('usageTitle')),
        identity === undefined
          ? null
          : h('span', { style: { ...css.note, opacity: 0.7 } }, `${t('usageAccount')} ${identity}`),
        h('button', {
          style: { ...css.btn, marginLeft: 'auto' },
          disabled: busy,
          onClick: () => void load(true),
        }, busy ? t('refreshing') : t('usageRefresh')),
      )

      if (snapshot === undefined || usage === undefined) {
        return h('div', { style: css.usageCard },
          head,
          error === undefined
            ? h('div', { style: css.note }, t('usageLoading'))
            : h('div', { style: css.err }, `${t('usageUnavailable')}：${error}`),
          error === undefined
            ? null
            : h('div', { style: css.bar },
                h('button', { style: css.btn, disabled: busy, onClick: () => void load(true) }, t('usageRetry')),
              ),
        )
      }

      const expiry = usage?.expiresAt
      return h('div', { style: css.usageCard },
        head,
        h('div', { style: css.usageLine },
          h('span', { style: css.usageLabel }, t('usagePlan')),
          h('span', { style: css.usageValue }, plan),
          exceeded ? h('span', { style: { ...css.err, fontWeight: 600 } }, t('usageExceeded')) : null,
          pct === undefined ? null : h('span', { style: css.usagePct }, `${Number(pct.toFixed(1))}%`),
        ),
        pct === undefined ? null : h('div', { style: css.progressOuter },
          h('div', {
            style: { ...css.progressInner, width: `${pct}%`, ...(exceeded ? css.progressDanger : {}) },
          }),
        ),
        h(QuotaLine, { t, label: t('usagePlanQuota'), bucket: usage?.userQuota }),
        h(QuotaLine, { t, label: t('usageAddOn'), bucket: usage?.addOnQuota }),
        h(QuotaLine, { t, label: t('usageOrgPackage'), bucket: usage?.orgResourcePackage }),
        h('div', { style: css.usageFoot },
          expiry === undefined || neverExpires(expiry)
            ? h('span', null, `${t('usageExpires')} ${t('usageNever')}`)
            : h('span', null, `${t('usageExpires')} ${dateLabel(expiry)}`),
          snapshot?.at === undefined ? null : h('span', null, `${t('usageUpdated')} ${new Date(snapshot.at).toLocaleTimeString('zh-CN')}`),
          typeof usage?.addOnQuota?.detailUrl === 'string'
            ? h('a', { href: usage.addOnQuota.detailUrl, target: '_blank', rel: 'noreferrer', style: css.link }, t('usageDetail'))
            : null,
          typeof usage?.upgradeUrl === 'string' && usage.upgradeUrl !== ''
            ? h('a', { href: usage.upgradeUrl, target: '_blank', rel: 'noreferrer', style: css.link }, t('usageUpgrade'))
            : null,
          failure === undefined
            ? null
            : h('span', { style: css.err }, `${t('usageStale')}：${failure}`),
        ),
      )
    }

    /**
     * CodeBuddy's account card: region choice, browser login/logout and the
     * signed-in account.
     *
     * The region is a config write (the host starts the CLI with it), but the
     * card does not wait for it: the target region's snapshot paints first and
     * the live account read follows. Both regions keep their own saved login,
     * so switching back does not open the browser again.
     */
    function codeBuddySnapshot(region) {
      const cached = readCache('codebuddy', `snapshot:${region}`)
      return cached !== null && typeof cached === 'object' ? cached : undefined
    }

    function rememberCodeBuddy(region, patch) {
      const previous = codeBuddySnapshot(region) ?? {}
      writeCache('codebuddy', `snapshot:${region}`, { ...previous, ...patch, at: Date.now() })
    }

    function CodeBuddyCard({ t, ctx, brand, refreshSignal, onSignedIn, onAuthChange, onRegionChange }) {
      const form = ctx.configForms.get(NS)
      const subscribe = useCallback(listener => form.subscribe(listener), [form])
      const read = useCallback(() => form.getSnapshot(), [form])
      const snapshot = useSyncExternalStore(subscribe, read)
      const value = snapshot?.value ?? {}
      const configuredRegion = value.codebuddyRegion === 'cn' ? 'cn' : 'global'
      const [region, setRegionState] = useState(configuredRegion)
      const regionRef = useRef(configuredRegion)
      const initial = codeBuddySnapshot(configuredRegion)
      const [auth, setAuth] = useState(initial?.auth)
      const [account, setAccount] = useState(initial?.account)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const lastRunning = useRef(false)
      const signingIn = auth?.running === true
      const accountFields = account?.account ?? {}
      const accountSignedIn = account?.error === undefined
        && ['uid', 'userName', 'email', 'organization', 'subscriptionType']
          .some(key => typeof accountFields[key] === 'string' && accountFields[key] !== '')
      // The host's status is authoritative once it has answered; the account
      // reading only covers the first paint before that answer arrives.
      const signedIn = auth === undefined ? accountSignedIn : auth.signedIn === true
      const resolved = auth !== undefined || account !== undefined

      const applySnapshot = useCallback(target => {
        const cached = codeBuddySnapshot(target)
        setAuth(cached?.auth)
        setAccount(cached?.account)
      }, [])

      const loadAccount = useCallback(async (fresh = false, target = regionRef.current) => {
        try {
          const payload = await api(`/usage?brand=codebuddy&region=${target}${fresh ? '&fresh=1' : ''}`, { timeout: 45_000 })
          if (regionRef.current !== target) return
          setAccount(payload)
          rememberCodeBuddy(target, { account: payload })
          // A quota 401 clears the server's credential; mirror that here so the
          // button flips back to 登录 without waiting for a page reload.
          if (typeof payload?.signedIn === 'boolean') {
            const next = { running: false, region: target, signedIn: payload.signedIn }
            setAuth(previous => (previous?.running === true ? previous : next))
            rememberCodeBuddy(target, { auth: next })
          }
        } catch (err) {
          if (regionRef.current !== target) return
          setAccount({ error: String(err?.message ?? err) })
        }
      }, [])

      const poll = useCallback(async (target = regionRef.current) => {
        try {
          const next = await api(`/auth?brand=codebuddy&region=${target}`, { timeout: 10_000 })
          if (regionRef.current !== target) return
          setAuth(next)
          rememberCodeBuddy(target, { auth: next })
          if (lastRunning.current && next.running === false) {
            lastRunning.current = false
            if (next.error === undefined) await loadAccount(true, target)
          }
          if (next.running === true) lastRunning.current = true
        } catch (err) {
          if (regionRef.current !== target) return
          setError(String(err?.message ?? err))
        }
      }, [loadAccount])

      // Paint the target region from its snapshot, then verify in the background.
      useEffect(() => {
        regionRef.current = region
        applySnapshot(region)
        setError(undefined)
        void poll(region)
        void loadAccount(false, region)
        const timer = setTimeout(() => { void loadAccount(true, region) }, 250)
        return () => clearTimeout(timer)
      }, [region, refreshSignal, applySnapshot, loadAccount, poll])

      // A config edit from elsewhere (or a reload) becomes the new selection.
      useEffect(() => {
        if (configuredRegion === regionRef.current) return
        setRegionState(configuredRegion)
        regionRef.current = configuredRegion
        applySnapshot(configuredRegion)
      }, [configuredRegion, applySnapshot])

      useEffect(() => {
        if (auth?.running !== true) return undefined
        const timer = setInterval(() => { void poll(region) }, 1500)
        return () => clearInterval(timer)
      }, [auth?.running, poll, region])

      useEffect(() => { if (resolved) onAuthChange?.(signedIn) }, [resolved, signedIn, onAuthChange])

      const setRegion = useCallback(next => {
        if (next === regionRef.current) return
        // Local paint first; the config write is only needed by the adapter.
        regionRef.current = next
        lastRunning.current = false
        setRegionState(next)
        applySnapshot(next)
        setError(undefined)
        onRegionChange?.(next)
        void (async () => {
          try {
            const accepted = await withDeadline(form.set('codebuddyRegion', next), WRITE_TIMEOUT_MS, t('timeout'))
            if (accepted === false) throw new Error(t('saveFailed'))
            if (regionRef.current === next) onSignedIn?.()
          } catch (err) {
            if (regionRef.current !== next) return
            setError(`${t('saveFailed')}：${String(err?.message ?? err)}`)
            const fallback = form.getSnapshot()?.value?.codebuddyRegion === 'cn' ? 'cn' : 'global'
            regionRef.current = fallback
            setRegionState(fallback)
            applySnapshot(fallback)
            onRegionChange?.(fallback)
          }
        })()
      }, [applySnapshot, form, onRegionChange, onSignedIn, t])

      const startLogin = useCallback(async () => {
        const target = regionRef.current
        setBusy(true)
        setError(undefined)
        try {
          const next = await api('/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ brand: 'codebuddy', region: target, action: 'login' }),
            timeout: 20_000,
          })
          if (regionRef.current !== target) return
          setAuth(next)
          rememberCodeBuddy(target, { auth: next })
          if (next.running === true) lastRunning.current = true
        } catch (err) {
          if (regionRef.current !== target) return
          setError(`${t('codebuddyLoginFailed')}：${String(err?.message ?? err)}`)
        } finally {
          setBusy(false)
        }
      }, [t])

      const logout = useCallback(async () => {
        if (typeof window.confirm === 'function' && !window.confirm(t('codebuddyConfirmLogout'))) return
        const target = regionRef.current
        setBusy(true)
        setError(undefined)
        try {
          const next = await api('/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ brand: 'codebuddy', region: target, action: 'logout' }),
            timeout: 20_000,
          })
          if (regionRef.current !== target) return
          setAuth(next)
          setAccount(undefined)
          rememberCodeBuddy(target, { auth: next, account: undefined })
          onAuthChange?.(false)
          await loadAccount(true, target)
        } catch (err) {
          if (regionRef.current !== target) return
          // The host clears its local credential even when the CLI refuses the
          // logout, so the card must not keep presenting the account.
          const signedOut = { running: false, region: target, signedIn: false }
          setAuth(signedOut)
          setAccount(undefined)
          rememberCodeBuddy(target, { auth: signedOut, account: undefined })
          onAuthChange?.(false)
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [loadAccount, onAuthChange, t])

      const accountText = account?.account === undefined
        ? (account?.error ?? t('codebuddyAccountUnknown'))
        : [account.account.email, account.account.organization, account.account.subscriptionType]
            .filter(part => typeof part === 'string' && part.length > 0)
            .join(' · ')
      const quota = account?.quota
      const quotaPct = quota !== undefined && quota.total > 0
        ? Math.max(0, Math.min(100, (quota.used / quota.total) * 100))
        : undefined
      const packages = Array.isArray(quota?.packages)
        ? [...quota.packages].sort((a, b) => (a.end ?? Number.MAX_SAFE_INTEGER) - (b.end ?? Number.MAX_SAFE_INTEGER)).slice(0, 4)
        : []
      // The website's own usage page, under the profile the CLI login belongs
      // to. Both regions serve it at the same path.
      const usageLink = h('a', {
        href: region === 'cn'
          ? 'https://copilot.tencent.com/profile/plans-usage'
          : 'https://www.codebuddy.ai/profile/plans-usage',
        target: '_blank',
        rel: 'noreferrer',
        style: css.link,
      }, t('usageDetail'))

      return h('div', { style: css.usageCard },
        h('div', { style: css.usageHead },
          h('h3', { style: css.h3 }, t('codebuddyAuthTitle')),
          h('span', { style: { ...css.note, opacity: 0.7 } }, signedIn ? t('codebuddySignedIn') : t('codebuddyNotLoggedIn')),
          signedIn
            ? h('button', { style: { ...css.btn, marginLeft: 'auto' }, disabled: busy, onClick: () => void loadAccount(true) }, t('usageRefresh'))
            : null,
        ),
        h('div', { style: css.note }, t('codebuddyAuthHint')),
        h('div', { style: css.usageLine },
          h('span', { style: css.usageLabel }, t('codebuddyRegionLabel')),
          h('select', {
            style: css.select,
            value: region,
            disabled: busy,
            onChange: event => { setRegion(event.target.value) },
          },
            h('option', { key: 'global', value: 'global' }, t('codebuddyRegionGlobal')),
            h('option', { key: 'cn', value: 'cn' }, t('codebuddyRegionCn')),
          ),
          h('button', {
            style: signedIn ? { ...css.btn, ...css.btnAlert } : css.btn,
            disabled: busy || signingIn,
            onClick: () => { if (signedIn) void logout(); else void startLogin() },
          }, signingIn ? t('codebuddyLoggingIn') : signedIn ? t('codebuddyLogout') : t('codebuddyLogin')),
        ),
        signedIn
          ? h('div', { style: css.usageLine },
              h('span', { style: css.usageLabel }, t('usageAccount')),
              h('span', { style: css.usageValue }, accountText),
            )
          : h('div', { style: css.note }, t('codebuddyLoginPrompt')),
        signedIn
          ? (quota === undefined
              ? (account?.quotaError !== undefined
                  ? h('div', { style: css.err }, `${t('codebuddyQuotaFailed')}：${account.quotaError}`)
                  : h('div', { style: css.note }, t('codebuddyNoQuota')))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                  h('div', { style: css.usageLine },
                    h('span', { style: css.usageLabel }, t('codebuddyQuotaTitle')),
                    h('span', { style: css.usageValue },
                      `${t('usageRemaining')} ${creditsOf(quota.remaining)} ${t('usageOf')} ${creditsOf(quota.total)} ${t('usageCredits')}`),
                    quotaPct === undefined ? null : h('span', { style: css.usagePct }, `${quotaPct.toFixed(1)}%`),
                  ),
                  quotaPct === undefined ? null : h('div', { style: css.progressOuter },
                    h('div', { style: { ...css.progressInner, width: `${quotaPct}%` } }),
                  ),
                  packages.length === 0 ? null : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                    h('div', { style: css.note }, t('codebuddyQuotaPackages')),
                    packages.map((pkg, index) => h('div', { key: `${pkg.name}-${index}`, style: css.usageLine },
                      h('span', { style: { ...css.usageLabel, minWidth: '160px' } }, pkg.name || '—'),
                      h('span', null, `${creditsOf(pkg.used)} / ${creditsOf(pkg.total)}`),
                      pkg.end === undefined ? null : h('span', { style: { opacity: 0.55 } }, dateLabel(pkg.end)),
                    )),
                  ),
                  h('div', { style: css.usageFoot },
                    quota.cycleEnd === undefined ? null : h('span', null, `${t('codebuddyQuotaExpires')} ${dateLabel(quota.cycleEnd)}`),
                    usageLink,
                  ),
                ))
          : null,
        signedIn && quota === undefined
          ? h('div', { style: css.usageFoot }, usageLink)
          : null,
        typeof auth?.url === 'string' && signingIn
          ? h('div', { style: css.usageLine },
              h('a', { href: auth.url, target: '_blank', rel: 'noreferrer', style: css.link }, t('codebuddyOpenUrl')),
              h('span', { style: css.note }, t('codebuddyLoginStarted')),
            )
          : null,
        auth?.error !== undefined ? h('div', { style: css.err }, `${t('codebuddyLoginFailed')}：${auth.error}`) : null,
        error !== undefined ? h('div', { style: css.err }, error) : null,
      )
    }

    function minimaxSnapshot(region) {
      const cached = readCache('minimax', `snapshot:${region}`)
      return cached !== null && typeof cached === 'object' ? cached : undefined
    }

    function rememberMinimax(region, patch) {
      const previous = minimaxSnapshot(region) ?? {}
      writeCache('minimax', `snapshot:${region}`, { ...previous, ...patch, at: Date.now() })
    }

    /**
     * MiniMax Code's account card: region, CLI install state and browser login.
     *
     * The login is a CLI process: `mcode login` opens the browser and writes an
     * auth file. The card polls the host while that process runs, then re-reads
     * the account so the model page can unlock.
     */
    function MinimaxCard({ ctx, t, brand, refreshSignal, onAuthChange, onRegionChange }) {
      const form = ctx.configForms.get(NS)
      const subscribe = useCallback(listener => form.subscribe(listener), [form])
      const read = useCallback(() => form.getSnapshot(), [form])
      const snapshot = useSyncExternalStore(subscribe, read)
      const value = snapshot?.value ?? {}
      const configuredRegion = value.minimaxRegion === 'global' ? 'global' : 'cn'
      const [region, setRegionState] = useState(configuredRegion)
      const regionRef = useRef(configuredRegion)
      const initial = minimaxSnapshot(configuredRegion)
      const [auth, setAuth] = useState(initial?.auth)
      const [usage, setUsage] = useState(initial?.usage)
      const [setup, setSetup] = useState(undefined)
      const [showLog, setShowLog] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(undefined)
      const lastRunning = useRef(false)
      const signingIn = auth?.running === true
      const signedIn = auth?.signedIn === true
      const runningSetup = setup?.running === true
      const installed = setup?.installed === true || usage?.installed === true

      const applySnapshot = useCallback(target => {
        const cached = minimaxSnapshot(target)
        setAuth(cached?.auth)
        setUsage(cached?.usage)
      }, [])

      const loadUsage = useCallback(async (fresh = false, target = regionRef.current) => {
        try {
          const payload = await api(`/usage?brand=minimax&region=${target}${fresh ? '&fresh=1' : ''}`, { timeout: 30_000 })
          if (regionRef.current !== target) return
          setUsage(payload)
          rememberMinimax(target, { usage: payload })
          if (typeof payload?.signedIn === 'boolean') {
            setAuth(previous => (previous?.running === true
              ? previous
              : { ...previous, running: false, region: target, signedIn: payload.signedIn }))
          }
        } catch (err) {
          if (regionRef.current !== target) return
          setUsage({ error: String(err?.message ?? err) })
        }
      }, [])

      const pollAuth = useCallback(async (target = regionRef.current) => {
        try {
          const next = await api(`/auth?brand=minimax&region=${target}`, { timeout: 10_000 })
          if (regionRef.current !== target) return
          setAuth(next)
          rememberMinimax(target, { auth: next })
          if (lastRunning.current && next.running === false) {
            lastRunning.current = false
            if (next.signedIn === true) {
              await loadUsage(true, target)
              onAuthChange?.(true)
            }
          }
          if (next.running === true) lastRunning.current = true
        } catch (err) {
          if (regionRef.current !== target) return
          setError(String(err?.message ?? err))
        }
      }, [loadUsage, onAuthChange])

      const pollSetup = useCallback(async () => {
        try {
          setSetup(await api('/setup?brand=minimax', { timeout: 10_000 }))
        } catch {
          /* a host without the installer route leaves this group empty */
        }
      }, [])

      useEffect(() => {
        regionRef.current = region
        applySnapshot(region)
        setError(undefined)
        void pollAuth(region)
        void loadUsage(false, region)
        void pollSetup()
      }, [region, refreshSignal, applySnapshot, loadUsage, pollAuth, pollSetup])

      useEffect(() => {
        if (configuredRegion === regionRef.current) return
        setRegionState(configuredRegion)
        regionRef.current = configuredRegion
        applySnapshot(configuredRegion)
      }, [configuredRegion, applySnapshot])

      useEffect(() => {
        if (!signingIn) return undefined
        const timer = setInterval(() => { void pollAuth(region) }, 1500)
        return () => clearInterval(timer)
      }, [signingIn, pollAuth, region])

      useEffect(() => {
        if (!runningSetup) return undefined
        const timer = setInterval(() => { void pollSetup() }, 1200)
        return () => clearInterval(timer)
      }, [runningSetup, pollSetup])

      useEffect(() => {
        if (!runningSetup && setup?.code === 0) void pollAuth(region)
      }, [runningSetup, setup?.code, pollAuth, region])

      const authResolved = auth !== undefined
      useEffect(() => {
        if (!authResolved) return
        onAuthChange?.(signedIn)
      }, [authResolved, signedIn, onAuthChange])

      const setRegion = useCallback(next => {
        if (next === regionRef.current) return
        regionRef.current = next
        lastRunning.current = false
        setRegionState(next)
        applySnapshot(next)
        setError(undefined)
        onRegionChange?.(next)
        void (async () => {
          try {
            const accepted = await withDeadline(form.set('minimaxRegion', next), WRITE_TIMEOUT_MS, t('timeout'))
            if (accepted === false) throw new Error(t('saveFailed'))
          } catch (err) {
            if (regionRef.current !== next) return
            setError(`${t('saveFailed')}：${String(err?.message ?? err)}`)
            const fallback = form.getSnapshot()?.value?.minimaxRegion === 'global' ? 'global' : 'cn'
            regionRef.current = fallback
            setRegionState(fallback)
            applySnapshot(fallback)
            onRegionChange?.(fallback)
          }
        })()
      }, [applySnapshot, form, onRegionChange, t])

      const startLogin = useCallback(async () => {
        const target = regionRef.current
        setBusy(true)
        setError(undefined)
        try {
          const next = await api('/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ brand: 'minimax', region: target, action: 'login' }),
            timeout: 20_000,
          })
          if (regionRef.current !== target) return
          setAuth(next)
          rememberMinimax(target, { auth: next })
          if (next.running === true) lastRunning.current = true
        } catch (err) {
          if (regionRef.current !== target) return
          setError(`${t('minimaxLoginFailed')}：${String(err?.message ?? err)}`)
        } finally {
          setBusy(false)
        }
      }, [t])

      const logout = useCallback(async () => {
        if (typeof window.confirm === 'function' && !window.confirm(t('minimaxConfirmLogout'))) return
        const target = regionRef.current
        setBusy(true)
        setError(undefined)
        try {
          const next = await api('/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ brand: 'minimax', region: target, action: 'logout' }),
            timeout: 30_000,
          })
          if (regionRef.current !== target) return
          setAuth(next)
          rememberMinimax(target, { auth: next })
          onAuthChange?.(false)
        } catch (err) {
          if (regionRef.current !== target) return
          setError(`${t('minimaxLoginFailed')}：${String(err?.message ?? err)}`)
        } finally {
          setBusy(false)
        }
      }, [onAuthChange, t])

      const runSetup = useCallback(async mode => {
        if (mode === 'uninstall' && typeof window.confirm === 'function' && !window.confirm(t('minimaxConfirmUninstall'))) return
        setBusy(true)
        setError(undefined)
        setShowLog(true)
        try {
          setSetup(await api('/setup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ brand: 'minimax', mode }),
            timeout: 15_000,
          }))
        } catch (err) {
          setError(`${t('minimaxCliFailed')}：${String(err?.message ?? err)}`)
        } finally {
          setBusy(false)
        }
      }, [t])

      const lines = Array.isArray(setup?.lines) ? setup.lines : []
      const setupBusy = busy || runningSetup
      const account = usage?.account
      const plan = usage?.plan
      const credits = usage?.credits
      const quotas = Array.isArray(usage?.windows) ? usage.windows : []
      const planLabel = plan?.kind === 'token-plan'
        ? t('minimaxPlanTokenPlan')
        : plan?.kind === 'credits' ? t('minimaxPlanCredits') : t('minimaxPlanFree')
      const timeLabel = ms => {
        try {
          return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        } catch {
          return String(ms)
        }
      }

      const quotaBlock = !signedIn
        ? h('div', { style: css.note }, installed ? t('minimaxNoUsage') : t('minimaxCliRequired'))
        : usage === undefined
          ? h('div', { style: css.note }, t('minimaxUsageLoading'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', { style: css.usageLine },
              h('span', { style: css.usageLabel }, t('minimaxAccount')),
              h('span', { style: css.usageValue }, account?.name ?? account?.email ?? t('minimaxAccountUnknown')),
            ),
            h('div', { style: css.usageLine },
              h('span', { style: css.usageLabel }, t('minimaxPlan')),
              h('span', { style: css.usageValue }, plan?.name ?? planLabel),
              plan?.hasTokenPlan === true ? h('span', { style: { ...css.tag, marginLeft: '6px' } }, t('minimaxPlanTokenPlan')) : null,
              plan?.expiresAt === undefined
                ? null
                : h('span', { style: css.note }, `${t('minimaxExpires')} ${dateLabel(plan.expiresAt)}`),
            ),
            credits === undefined
              ? null
              : h('div', { style: css.usageLine },
                  h('span', { style: css.usageLabel }, t('minimaxCredits')),
                  h('span', { style: css.usageValue }, creditsOf(credits.remaining)),
                  typeof credits.purchasedRemaining === 'number' && credits.purchasedRemaining > 0
                    ? h('span', { style: css.note }, `${t('minimaxCreditsPurchased')} ${creditsOf(credits.purchasedRemaining)}`)
                    : null,
                  typeof credits.freeRemaining === 'number' && credits.freeRemaining > 0
                    ? h('span', { style: css.note }, `${t('minimaxCreditsFree')} ${creditsOf(credits.freeRemaining)}`)
                    : null,
                ),
            quotas.length === 0
              ? h('div', { style: css.note }, t('minimaxQuotaNone'))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
                  quotas.map(window => {
                    const remaining = typeof window.remainingPercent === 'number' ? window.remainingPercent : undefined
                    const used = remaining === undefined ? undefined : 100 - remaining
                    return h('div', { key: window.id, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                      h('div', { style: css.usageLine },
                        h('span', { style: css.usageLabel }, window.label),
                        h('span', { style: css.usageValue }, window.unlimited
                          ? t('minimaxQuotaUnlimited')
                          : remaining === undefined
                            ? (window.remainingCount === undefined ? '—' : `${creditsOf(window.remainingCount)} / ${creditsOf(window.totalCount ?? 0)}`)
                            : `${t('minimaxQuotaRemaining')} ${remaining}%`),
                        typeof window.resetAt === 'number'
                          ? h('span', { style: css.note }, `${t('minimaxQuotaReset')} ${timeLabel(window.resetAt)}`)
                          : null,
                      ),
                      used === undefined || window.unlimited
                        ? null
                        : h('div', { style: css.progressOuter },
                            h('div', {
                              style: {
                                ...css.progressInner,
                                width: `${used}%`,
                                ...(remaining !== undefined && remaining < 20 ? css.progressDanger : {}),
                              },
                            }),
                          ),
                    )
                  }),
                ),
            usage?.error !== undefined ? h('div', { style: css.err }, `${t('minimaxUsageFailed')}：${usage.error}`) : null,
          )

      return h('div', { style: css.usageCard },
        h('div', { style: css.usageHead },
          h('h3', { style: css.h3 }, t('minimaxAuthTitle')),
          h('span', { style: { ...css.note, opacity: 0.7 } }, signedIn ? t('minimaxSignedIn') : t('minimaxNotLoggedIn')),
          signedIn
            ? h('button', { style: { ...css.btn, marginLeft: 'auto' }, disabled: busy, onClick: () => void loadUsage(true) }, t('usageRefresh'))
            : null,
        ),
        h('div', { style: css.note }, t('minimaxAuthHint')),
        h('div', { style: css.usageLine },
          h('span', { style: css.usageLabel }, t('minimaxRegionLabel')),
          h('select', {
            style: css.select,
            value: region,
            disabled: busy,
            onChange: event => { setRegion(event.target.value) },
          },
            h('option', { key: 'cn', value: 'cn' }, t('minimaxRegionCn')),
            h('option', { key: 'global', value: 'global' }, t('minimaxRegionGlobal')),
          ),
          h('button', {
            style: signedIn ? { ...css.btn, ...css.btnAlert } : css.btn,
            disabled: busy || signingIn || (!signedIn && !installed),
            onClick: () => { if (signedIn) void logout(); else void startLogin() },
          }, signingIn ? t('minimaxLoggingIn') : signedIn ? t('minimaxLogout') : t('minimaxLogin')),
        ),
        quotaBlock,
        typeof auth?.expiresAt === 'number'
          ? h('div', { style: css.usageFoot },
              h('span', null, `${t('minimaxExpires')} ${dateLabel(auth.expiresAt)}`),
            )
          : null,
        typeof auth?.url === 'string' && signingIn
          ? h('div', { style: css.usageLine },
              h('a', { href: auth.url, target: '_blank', rel: 'noreferrer', style: css.link }, t('minimaxOpenUrl')),
              h('span', { style: css.note }, t('minimaxLoginStarted')),
            )
          : null,
        auth?.error !== undefined ? h('div', { style: css.err }, `${t('minimaxLoginFailed')}：${auth.error}`) : null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { style: css.usageLine },
            h('span', { style: css.usageLabel }, t('minimaxCliGroup')),
            h('span', { style: css.usageValue }, installed ? t('minimaxCliInstalled') : t('minimaxCliMissing')),
            h('button', {
              style: { ...css.btn, marginLeft: 'auto' },
              disabled: setupBusy,
              onClick: () => void runSetup('install'),
            }, runningSetup && setup?.mode === 'install' ? t('minimaxCliInstalling') : t('minimaxCliInstall')),
            installed
              ? h('button', {
                  style: { ...css.btn, ...css.btnAlert },
                  disabled: setupBusy,
                  onClick: () => void runSetup('uninstall'),
                }, runningSetup && setup?.mode === 'uninstall' ? t('minimaxCliUninstalling') : t('minimaxCliUninstall'))
              : null,
          ),
          h('div', { style: css.note }, t('minimaxCliHint')),
          lines.length === 0
            ? null
            : h('div', null,
                h('button', {
                  style: css.btn,
                  onClick: () => setShowLog(value => !value),
                }, showLog ? t('minimaxHideOutput') : t('minimaxShowOutput')),
                showLog ? h('pre', { style: css.log }, lines.join('\n')) : null,
              ),
        ),
        error !== undefined ? h('div', { style: css.err }, error) : null,
      )
    }

    /**
     * The model table plus the advanced block.
     *
     * Each change posts and then adopts the host's returned list, so the page
     * shows what the adapter will actually do rather than what the click hoped.
     * A per-request ticket keeps a slow earlier answer from overwriting a newer
     * one when the user clicks quickly.
     */
    function SettingsPage({ ctx, t, brand }) {
      const form = ctx.configForms.get(NS)
      /** CodeBuddy and MiniMax both have two login regions and their own catalogs. */
      const regional = brand.id === 'codebuddy' || brand.id === 'minimax'
      const initialSnapshot = form.getSnapshot()?.value ?? {}
      const initialRegion = brand.id === 'minimax'
        ? (initialSnapshot.minimaxRegion === 'global' ? 'global' : 'cn')
        : (initialSnapshot.codebuddyRegion === 'cn' ? 'cn' : 'global')
      const snapshotFor = target => brand.id === 'minimax'
        ? minimaxSnapshot(target)
        : codeBuddySnapshot(target)
      // Each login region has its own catalog, deny-list and windows; the page
      // key follows the region so switching shows that region's choices.
      const [region, setRegion] = useState(initialRegion)
      const modelsKind = regional ? `models:${region}` : 'models'
      const cached = readCache(brand.id, modelsKind)
      const [models, setModels] = useState(() => Array.isArray(cached?.rows) ? cached.rows : undefined)
      const [catalogNotice, setCatalogNotice] = useState(() =>
        typeof cached?.notice === 'string' ? cached.notice : undefined)
      const [signedIn, setSignedIn] = useState(() =>
        regional
          ? cached?.signedIn === true || snapshotFor(initialRegion)?.auth?.signedIn === true
          : undefined)
      const [error, setError] = useState(undefined)
      const [status, setStatus] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [query, setQuery] = useState('')
      const [onlyEnabled, setOnlyEnabled] = useState(false)
      const [showAdvanced, setShowAdvanced] = useState(false)
      const [usageTick, setUsageTick] = useState(0)
      const ticket = useRef(0)
      /** Separate from `ticket`: `load()` bumps that one, so sharing it would
       *  make every write look stale the moment its own refresh landed. */
      const writeTicket = useRef(0)

      const subscribe = useCallback(listener => form.subscribe(listener), [form])
      const read = useCallback(() => form.getSnapshot(), [form])
      const snapshot = useSyncExternalStore(subscribe, read)

      const configuredRegion = brand.id === 'minimax'
        ? (snapshot?.value?.minimaxRegion === 'global' ? 'global' : 'cn')
        : (snapshot?.value?.codebuddyRegion === 'cn' ? 'cn' : 'global')
      /**
       * The region the user just picked, until the config write lands.
       *
       * Without this, a snapshot that still carries the old value would pull
       * the selection back mid-switch.
       */
      const pendingRegion = useRef(null)
      useEffect(() => {
        if (!regional) return
        if (pendingRegion.current !== null) {
          if (pendingRegion.current === configuredRegion) pendingRegion.current = null
          return
        }
        setRegion(current => (current === configuredRegion ? current : configuredRegion))
      }, [regional, configuredRegion, region])

      const selectRegion = useCallback(next => {
        pendingRegion.current = next
        setRegion(next)
      }, [])

      const fields = brand.id === 'codebuddy'
        ? {
            disabled: region === 'cn' ? 'codebuddyCnDisabledModels' : 'codebuddyGlobalDisabledModels',
            windows: region === 'cn' ? 'codebuddyCnModelContextWindows' : 'codebuddyGlobalModelContextWindows',
          }
        : brand.id === 'minimax'
          ? {
              disabled: region === 'cn' ? 'minimaxCnDisabledModels' : 'minimaxGlobalDisabledModels',
              windows: region === 'cn' ? 'minimaxCnModelContextWindows' : 'minimaxGlobalModelContextWindows',
            }
          : brand.fields

      const describeFace = ctx.configForms.describe()
      const describeSubscribe = useCallback(listener => describeFace.subscribe(listener), [describeFace])
      const describeRead = useCallback(() => describeFace.getSnapshot(), [describeFace])
      const describeSnapshot = useSyncExternalStore(describeSubscribe, describeRead)
      useEffect(() => { describeFace.ensure().catch(() => undefined) }, [describeFace])

      const fetchModels = useCallback(async (fresh = false) => {
        const regionQuery = regional ? `&region=${region}` : ''
        const payload = await api(`/models?brand=${brand.id}${regionQuery}${fresh ? '&fresh=1' : ''}`)
        // Never adopt a table the host answered for another login region.
        if (regional && typeof payload?.region === 'string' && payload.region !== region) {
          throw new Error(t(brand.id === 'minimax' ? 'minimaxRegionMismatch' : 'codebuddyRegionMismatch'))
        }
        return {
          rows: Array.isArray(payload?.models) ? payload.models : [],
          notice: typeof payload?.notice === 'string' ? payload.notice : undefined,
          signedIn: regional ? payload?.signedIn === true : undefined,
        }
      }, [brand.id, regional, region, t])

      /** Adopt one read and remember it for the next visit to this region. */
      const adopt = useCallback((rows, notice, nextSignedIn) => {
        setModels(rows)
        setCatalogNotice(notice)
        setSignedIn(nextSignedIn)
        writeCache(brand.id, modelsKind, { rows, notice, signedIn: nextSignedIn, at: Date.now() })
      }, [brand.id, modelsKind])

      /** Read the list. `fresh` asks the host to drop its catalog cache first. */
      const load = useCallback(async (fresh = false) => {
        const requestedKind = modelsKind
        setError(undefined)
        const mine = ++ticket.current
        try {
          const { rows, notice, signedIn: nextSignedIn } = await fetchModels(fresh)
          if (mine !== ticket.current || kindRef.current !== requestedKind) return
          adopt(rows, notice, nextSignedIn)
        } catch (err) {
          if (mine !== ticket.current || kindRef.current !== requestedKind) return
          setError(String(err?.message ?? err))
          setModels(previous => previous ?? [])
        }
      }, [adopt, fetchModels, modelsKind])

      /** Latest values for callbacks the account card holds across renders. */
      const loadRef = useRef(load)
      loadRef.current = load
      const kindRef = useRef(modelsKind)
      kindRef.current = modelsKind
      /** The region of the last model read; a change forces a fresh read. */
      const lastLoaded = useRef(undefined)
      const refresh = useCallback(() => { void loadRef.current() }, [])

      /**
       * On a region switch, paint that region's remembered table first and
       * then verify it with the host. The read carries the region explicitly,
       * so it stays correct even before the config write commits.
       */
      useEffect(() => {
        if (regional) {
          const saved = readCache(brand.id, modelsKind)
          const accountSnapshot = brand.id === 'minimax'
            ? minimaxSnapshot(region)
            : codeBuddySnapshot(region)
          setModels(Array.isArray(saved?.rows) ? saved.rows : undefined)
          setCatalogNotice(typeof saved?.notice === 'string' ? saved.notice : undefined)
          // The account snapshot already knows whether this region is signed
          // in, so the locked view does not flash while the catalog boots.
          setSignedIn(saved?.signedIn === true || accountSnapshot?.auth?.signedIn === true)
          setError(undefined)
        }
        // A switch must not be served from the host's cached catalog: the CLI
        // only settles into the new login environment on a fresh read.
        const switched = regional
          && lastLoaded.current !== undefined
          && lastLoaded.current !== region
        lastLoaded.current = region
        void load(switched)
      }, [brand.id, regional, modelsKind, region, load])

      /** Login/logout flips which catalog the page is allowed to show. */
      const handleAuthChange = useCallback(next => {
        if (!regional) return
        setSignedIn(next === true)
        if (next === true) {
          refresh()
          return
        }
        setModels([])
        setCatalogNotice(undefined)
        writeCache(brand.id, kindRef.current, { rows: [], notice: undefined, signedIn: false, at: Date.now() })
      }, [brand.id, regional, refresh])

      /**
       * Re-read until the list reflects what was just written, or give up.
       *
       * The host commits a volatile config edit into the running plugin before
       * it answers the write, so the first read after `set()` normally already
       * shows the change and this returns immediately. The retries exist for the
       * cases where it does not: a reload that briefly unpublished the route, or
       * a host that answered ahead of its own commit. Spending them turns a
       * transient disagreement into a short wait instead of a wrong answer.
       *
       * @param verify - whether the rows already show the intended change.
       * @param attempts - how many reads to try before accepting what arrived.
       * @returns the last rows read, or undefined when every read failed.
       */
      const loadUntil = useCallback(async (verify, attempts = 5) => {
        let rows
        const requestedKind = kindRef.current
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            const read = await fetchModels()
            // A region switch during the save invalidates this verification.
            if (kindRef.current !== requestedKind) return undefined
            rows = read.rows
            adopt(rows, read.notice, read.signedIn)
          } catch (err) {
            setError(String(err?.message ?? err))
            return undefined
          }
          if (verify === undefined || verify(rows)) return rows
          await new Promise(resolve => setTimeout(resolve, 120 + attempt * 120))
        }
        return rows
      }, [adopt, fetchModels])

      /**
       * Apply one change through the shared config form, then re-read until the
       * list reflects it.
       *
       * The write goes through `configForms`, not the API route: that form owns
       * the namespace's revision fence, so every change is ordered and a stale
       * editor is refused rather than silently overwriting.
       *
       * `busy` is owned by the newest write alone, and is always cleared in
       * `finally`. It must NOT be gated on the read generation: the read bumps
       * that counter, so gating there would leave `busy` set forever and every
       * control disabled.
       *
       * The host answers only after it has committed the value, so the re-read
       * normally confirms the change on its first attempt. `verify` therefore
       * acts as a real check rather than a wait: if the list still disagrees
       * once the retries are spent, the change was NOT adopted and the page says
       * so instead of reporting a save that did nothing.
       *
       * @param key - the config field to write.
       * @param next - the value, or undefined to clear the field.
       * @param verify - whether the re-read list already shows this change.
       */
      const write = useCallback(async (key, next, verify) => {
        const mine = ++writeTicket.current
        setBusy(true)
        setStatus(t('saving'))
        setError(undefined)
        try {
          const op = next === undefined ? form.unset(key) : form.set(key, next)
          const accepted = await withDeadline(op, WRITE_TIMEOUT_MS, t('timeout'))
          if (accepted === false) throw new Error(t('saveFailed'))
          const rows = await loadUntil(verify)
          if (rows !== undefined && verify !== undefined && !verify(rows)) throw new Error(t('notApplied'))
          if (mine === writeTicket.current) setStatus(t('saved'))
        } catch (err) {
          if (mine !== writeTicket.current) return
          setError(`${t('saveFailed')}：${String(err?.message ?? err)}`)
          setStatus(undefined)
          // The rows now hold an optimistic guess; re-read so the page shows what
          // the host actually stored rather than what the click hoped for.
          await load()
        } finally {
          if (mine === writeTicket.current) setBusy(false)
        }
      }, [form, load, loadUntil, t])

      /**
       * Write the whole disabled-model list, derived from the rows the user
       * just changed, so rapid toggles cannot lose each other's edits.
       *
       * The row is updated locally first: the host commits the value before it
       * answers, so the re-read confirms this instead of correcting it, and the
       * switch never appears to snap back to where it was.
       */
      const writeDisabled = useCallback((rows, id, enabled) => {
        const next = new Set(rows.filter(m => !m.enabled).map(m => m.id))
        if (enabled) next.delete(id)
        else next.add(id)
        setModels(current => current?.map(m => m.id === id ? { ...m, enabled } : m))
        return write(fields.disabled, [...next], list => list.some(m => m.id === id && m.enabled === enabled))
      }, [fields.disabled, write])

      /** Write the whole per-model window map, again showing the choice at once. */
      const writeWindow = useCallback((rows, id, window) => {
        const next = {}
        for (const m of rows) if (m.override !== undefined) next[m.id] = m.override
        if (window === undefined) delete next[id]
        else next[id] = window
        setModels(current => current?.map(m => m.id === id
          ? { ...m, override: window, contextWindow: window ?? m.defaultContextWindow }
          : m))
        return write(
          fields.windows,
          next,
          list => list.some(m => m.id === id
            && (window === undefined ? m.override === undefined : m.override === window)),
        )
      }, [fields.windows, write])

      /**
       * Flip every model at once.
       *
       * Enabling all writes an empty deny-list rather than every id, so a model
       * the account publishes later still defaults to on.
       */
      const writeAll = useCallback((enabled) => {
        const ids = (models ?? []).map(m => m.id)
        setModels(current => current?.map(m => ({ ...m, enabled })))
        return write(
          fields.disabled,
          enabled ? [] : ids,
          list => list.every(m => m.enabled === enabled),
        )
      }, [fields.disabled, models, write])

      // ── CLI helper ────────────────────────────────────────────────────────
      // The host runs the script, so the page only asks and then reads what it
      // printed. `setup` stays undefined-shaped until the first answer arrives:
      // a host older than this route simply never answers, and the group still
      // renders with both buttons working.
      const [setup, setSetup] = useState(undefined)
      const [setupError, setSetupError] = useState(undefined)
      const [logOpen, setLogOpen] = useState(false)
      const logRef = useRef(null)

      const pollSetup = useCallback(async () => {
        try {
          setSetup(await api(`/setup?brand=${brand.id}`, { timeout: 10_000 }))
        } catch {
          /* no run to report, or a host without the route */
        }
      }, [brand.id])

      const startCliSetup = useCallback(async (mode) => {
        setSetupError(undefined)
        try {
          setSetup(await api('/setup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ brand: brand.id, mode }),
            timeout: 15_000,
          }))
        } catch (err) {
          setSetupError(`${t('cliStartFailed')}：${String(err?.message ?? err)}`)
        }
      }, [brand.id, t])

      const setupRunning = setup?.running === true
      const setupCode = setup !== undefined && setup.running === false ? setup.code : undefined
      const setupFinishedAt = setup?.finishedAt
      const setupLines = Array.isArray(setup?.lines) ? setup.lines : []

      useEffect(() => { void pollSetup() }, [pollSetup])
      useEffect(() => {
        if (!setupRunning) return undefined
        const timer = setInterval(() => { void pollSetup() }, 1200)
        return () => clearInterval(timer)
      }, [setupRunning, pollSetup])

      /**
       * The output panel follows the run, not the history: open while the
       * script is alive, folded away one second after it ends. Pressing 查看
       * 输出 brings the text back, and a finished run from before a reload is
       * never re-expanded, because the panel starts closed.
       */
      useEffect(() => {
        if (setupRunning) {
          setLogOpen(true)
          return undefined
        }
        if (setupFinishedAt === undefined) return undefined
        const timer = setTimeout(() => setLogOpen(false), 1000)
        return () => clearTimeout(timer)
      }, [setupRunning, setupFinishedAt])

      // The catalog is read from the CLI, so a helper that just installed,
      // signed into, or removed it changes what the list and quota should show —
      // and the host has already dropped its cached answers for that case.
      useEffect(() => {
        if (setupCode !== 0) return
        void load(true)
        setUsageTick(value => value + 1)
      }, [setupCode, setupFinishedAt, load])

      /** Ask before running the destructive CLI action. */
      const uninstallCli = useCallback(() => {
        if (typeof window.confirm !== 'function') return
        if (!window.confirm(t('cliUninstallConfirm'))) return
        void startCliSetup('uninstall')
      }, [startCliSetup, t])

      useEffect(() => {
        const node = logRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [setupLines.length])

      const all = models ?? []
      const enabledTotal = all.filter(m => m.enabled).length

      const shown = useMemo(() => {
        const q = query.trim().toLowerCase()
        return all.filter(m => {
          if (onlyEnabled && !m.enabled) return false
          if (q === '') return true
          return String(m.name).toLowerCase().includes(q) || String(m.id).toLowerCase().includes(q)
        })
      }, [all, query, onlyEnabled])

      const regionalLocked = regional && signedIn !== true
      const authCard = brand.kind === 'codebuddy'
        ? h(CodeBuddyCard, {
            t, ctx, brand, refreshSignal: usageTick,
            onSignedIn: () => { refresh(); setUsageTick(v => v + 1) },
            onAuthChange: handleAuthChange,
            onRegionChange: selectRegion,
          })
        : brand.kind === 'minimax'
          ? h(MinimaxCard, {
              t, ctx, brand, refreshSignal: usageTick,
              onAuthChange: handleAuthChange,
              onRegionChange: selectRegion,
            })
          : null

      // Signed out: do not read or show a catalog that the CLI would refuse.
      if (regionalLocked) {
        return h('div', { style: css.page },
          h('h2', { style: css.h2 }, t(brand.titleKey)),
          h('p', { style: css.intro }, t(brand.introKey)),
          authCard,
          h('div', { style: css.guide },
            h('div', { style: css.guideText }, t(brand.id === 'minimax' ? 'minimaxModelsHint' : 'codebuddyModelsHint')),
          ),
          error !== undefined ? h('div', { style: css.err }, error) : null,
        )
      }

      /**
       * Red guidance for "no models", with the one action that can fix it.
       *
       * An empty list is almost always the machine, not the account: the CLI is
       * missing or signed out, so the catalog has nothing to return. Pointing at
       * the helper and offering to run it beats a grey sentence nobody reads.
       */
      const renderGuide = () => h('div', { style: css.guide },
        h('div', { style: css.guideText }, t(brand.noModelsKey)),
        brand.kind !== 'qoder'
          ? null
          : h('button', {
              style: { ...css.btn, ...css.btnAlert },
              disabled: setupRunning,
              onClick: () => void startCliSetup('configure'),
            }, t('cliRun')),
      )

      if (models === undefined) {
        return h('div', { style: css.page },
          h('h2', { style: css.h2 }, t(brand.titleKey)),
          // Same leading shape as the loaded page: a differing child index
          // remounts the account card and makes it snap back to the region the
          // config still holds while the switch is in flight.
          h('p', { style: css.intro }, t(brand.introKey)),
          regional ? authCard : null,
          error === undefined
            ? h('div', { style: css.note }, t('loading'))
            : h('div', null,
                h('div', { style: css.err }, `${t('loadFailed')}：${error}`),
                h('button', { style: { ...css.btn, marginTop: '8px' }, onClick: () => void load(true) }, t('retry')),
                h('div', { style: { marginTop: '10px' } }, renderGuide()),
              ),
        )
      }

      const rows = shown.map((m, index) => {
        const choices = Array.isArray(m.contextWindows) ? m.contextWindows : []
        return h('div', {
          key: m.id,
          style: { ...css.row, ...(index === 0 ? css.rowFirst : {}), ...(m.enabled ? {} : css.rowOff) },
        },
          h('input', {
            type: 'checkbox',
            style: css.switch,
            checked: m.enabled === true,
            disabled: busy,
            title: t('colEnabled'),
            onChange: event => { void writeDisabled(all, m.id, event.target.checked) },
          }),
          h('div', { style: css.name },
            h('div', { style: css.nameText },
              m.name,
              m.vision === true ? h('span', { key: 'v', style: { ...css.tag, marginLeft: '6px' } }, t('vision')) : null,
              priceSuffix(t, m.priceFactor) !== ''
                ? h('span', { key: 'p', style: css.price }, ` · ${priceSuffix(t, m.priceFactor)}`)
                : null,
            ),
            h('div', { style: css.id }, m.id),
          ),
          h('select', {
            style: css.select,
            value: m.override === undefined ? '' : String(m.override),
            disabled: busy,
            title: t('windowDefaultHint'),
            onChange: event => {
              const value = event.target.value
              void writeWindow(all, m.id, value === '' ? undefined : Number(value))
            },
          },
            h('option', { key: 'default', value: '' }, `${t('windowDefault')} · ${windowLabel(m.defaultContextWindow)}`),
            choices.map(n => h('option', { key: String(n), value: String(n) }, windowLabel(n))),
          ),
        )
      })

      const advanced = buildAdvanced({
        t, form, snapshot,
        fields: ADVANCED[brand.id],
        namespace: describeSnapshot.view?.namespaces?.find(n => n.ns === NS),
        show: showAdvanced,
        onToggle: () => setShowAdvanced(value => !value),
      })

      return h('div', { style: css.page },
        h('h2', { style: css.h2 }, t(brand.titleKey)),
        h('p', { style: css.intro }, t(brand.introKey)),
        regional
          ? authCard
          : h(UsageCard, { t, brand, refreshSignal: usageTick }),

        // Search row: the field grows, the checkbox sits beside it.
        h('div', { style: css.bar },
          h('input', {
            style: { ...css.input, ...css.search },
            placeholder: t('search'),
            value: query,
            onChange: event => setQuery(event.target.value),
          }),
          h('label', { style: { ...css.note, display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' } },
            h('input', { type: 'checkbox', checked: onlyEnabled, onChange: event => setOnlyEnabled(event.target.checked) }),
            t('onlyEnabled'),
          ),
        ),

        // Action row: all four buttons on one line, count pinned to the right.
        // `nowrap` keeps them together; the count takes the remaining space so
        // nothing wraps to a second line.
        h('div', { style: { ...css.bar, flexWrap: 'nowrap' } },
          h('button', { style: css.btn, disabled: busy, onClick: () => void load(true) }, t('refresh')),
          h('button', {
            style: css.btn,
            disabled: busy || all.every(m => m.enabled),
            onClick: () => void writeAll(true),
          }, t('selectAll')),
          h('button', {
            style: css.btn,
            disabled: busy || enabledTotal === 0,
            onClick: () => void writeAll(false),
          }, t('selectNone')),
          h('span', { style: css.count }, `${t('enabledCount')} ${enabledTotal} / ${all.length}`),
        ),

        all.length === 0
          ? renderGuide()
          : h('div', { style: css.list }, rows.length > 0 ? rows : h('div', { style: { ...css.note, padding: '12px 14px' } }, '—')),

        catalogNotice !== undefined ? h('div', { style: css.note }, catalogNotice) : null,
        all.length > 0 ? h('div', { style: css.note }, t('windowWarn')) : null,
        error !== undefined ? h('div', { style: css.err }, error) : null,
        status !== undefined && error === undefined ? h('div', { style: css.note }, status) : null,

        brand.kind !== 'qoder' ? null : h('div', { style: css.group },
          h('h3', { style: css.h3 }, t(brand.cliGroupKey)),
          h('div', { style: css.note }, t(brand.cliHintKey)),
          h('div', { style: { ...css.bar, flexWrap: 'nowrap' } },
            h('button', { style: css.btn, disabled: setupRunning, onClick: () => void startCliSetup('configure') }, t('cliRun')),
            h('button', { style: css.btn, disabled: setupRunning, onClick: () => void startCliSetup('login') }, t('cliLogin')),
            h('button', { style: { ...css.btn, ...css.btnAlert }, disabled: setupRunning, onClick: uninstallCli }, t('cliUninstall')),
            setupLines.length > 0 && !setupRunning
              ? h('button', { style: css.btn, onClick: () => setLogOpen(value => !value) }, logOpen ? t('cliHideLog') : t('cliShowLog'))
              : null,
            h('span', { style: css.count }, setupRunning
              ? (setup?.mode === 'uninstall' ? t('cliUninstalling') : t('cliRunning'))
              : setupError !== undefined
                ? setupError
                : setupCode === 0
                  ? (setup?.mode === 'uninstall' ? t('cliUninstallOk') : t('cliExitOk'))
                  : setupCode === undefined || setupCode === null
                    ? ''
                    : `${t('cliExitFail')} ${setupCode}`),
          ),
          logOpen && setupLines.length > 0
            ? h('pre', { ref: logRef, style: css.log }, setupLines.join('\n'))
            : null,
        ),

        advanced,
      )
    }

    /**
     * The two edition switches, contributed to this bundle's page in the plugin
     * manager (`plugins.bundle.config`).
     *
     * They live here rather than on either settings page because they decide
     * whether those pages exist at all: a page cannot own the switch that
     * removes it. The write goes through the shared config form, so it uses the
     * same revision fence as every other setting.
     */
    function BundleSettings({ ctx, t, view }) {
      const form = ctx.configForms.get(NS)
      const subscribe = useCallback(listener => form.subscribe(listener), [form])
      const read = useCallback(() => form.getSnapshot(), [form])
      const snapshot = useSyncExternalStore(subscribe, read)
      const value = snapshot?.value ?? {}
      const writable = snapshot?.writable !== false
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState(undefined)
      const [error, setError] = useState(undefined)
      const writeTicket = useRef(0)

      const toggle = useCallback(async (key, next) => {
        const mine = ++writeTicket.current
        setBusy(true)
        setStatus(t('saving'))
        setError(undefined)
        try {
          const accepted = await withDeadline(form.set(key, next), WRITE_TIMEOUT_MS, t('timeout'))
          if (accepted === false) throw new Error(t('pluginOptionsRejected'))
          if (mine === writeTicket.current) setStatus(t('saved'))
        } catch (err) {
          if (mine !== writeTicket.current) return
          setError(`${t('saveFailed')}：${String(err?.message ?? err)}`)
          setStatus(undefined)
        } finally {
          if (mine === writeTicket.current) setBusy(false)
        }
      }, [form, t])

      const labelOf = brand => {
        const key = brand.id === 'cn'
          ? 'displayName'
          : brand.id === 'global'
            ? 'intlDisplayName'
            : brand.id === 'minimax' ? 'minimaxDisplayName' : 'codebuddyDisplayName'
        const fallback = brand.id === 'cn'
          ? t('nav')
          : brand.id === 'global'
            ? t('intlNav')
            : brand.id === 'minimax' ? t('minimaxNav') : t('codebuddyNav')
        const stored = value[key]
        return typeof stored === 'string' && stored !== '' ? stored : fallback
      }

      if (view !== undefined && view !== 'page') {
        const names = BRANDS
          .filter(brand => value[brand.fields.enabled] !== false)
          .map(labelOf)
        return h('span', null, names.join(' · '))
      }

      const rows = BRANDS.map((brand, index) => {
        const enabled = value[brand.fields.enabled] !== false
        const name = labelOf(brand)
        return h('div', {
          key: brand.id,
          style: { ...css.optionRow, ...(index === 0 ? css.optionFirst : {}) },
        },
          h('input', {
            type: 'checkbox',
            style: css.switch,
            checked: enabled,
            disabled: busy || !writable,
            title: enabled ? t('pluginOptionsOn') : t('pluginOptionsOff'),
            onChange: event => { void toggle(brand.fields.enabled, event.target.checked) },
          }),
          h('div', { style: css.optionText },
            h('div', { style: css.optionName }, name),
            h('div', { style: css.optionStatus }, enabled ? t('pluginOptionsOn') : t('pluginOptionsOff')),
          ),
        )
      })

      return h('div', { style: css.group },
        h('h3', { style: css.h3 }, t('pluginOptionsTitle')),
        h('div', { style: css.note }, t('pluginOptionsHint')),
        rows,
        !writable ? h('div', { style: css.note }, t('pluginOptionsReadOnly')) : null,
        error !== undefined ? h('div', { style: css.err }, error) : null,
        status !== undefined && error === undefined ? h('div', { style: css.note }, status) : null,
      )
    }

    /**
     * The collapsed advanced block: the remaining scalars, rendered against the
     * host's schema so labels, bounds and defaults stay in one place.
     */
    function buildAdvanced({ t, form, snapshot, fields, namespace, show, onToggle }) {
      const header = h('div', { style: css.bar },
        h('button', { style: css.btn, onClick: onToggle }, show ? t('hide') : t('show')),
        h('span', { style: css.note }, t('advancedHint')),
      )
      if (!show) {
        return h('div', { style: css.group }, h('h3', { style: css.h3 }, t('advanced')), header)
      }

      const value = snapshot?.value ?? {}
      const user = snapshot?.user
      const schema = namespace?.schema
      const refs = schema?.refs
      const root = refs?.[schema?.uid]
      const writable = snapshot?.writable !== false

      const set = (key, next) => {
        const op = next === undefined || next === ''
          ? form.unset(key)
          : form.set(key, next)
        op.catch(() => undefined)
      }

      const rows = fields.map(([key, kind]) => {
        const node = refs?.[root?.dict?.[key]]
        if (node === undefined) return null
        const labels = t('advancedFields') ?? {}
        const help = typeof node?.meta?.description === 'string' ? node.meta.description : undefined
        const current = value[key]
        const overridden = user !== null && typeof user === 'object' && Object.hasOwn(user, key)

        let control
        if (kind === 'json') {
          control = h('input', {
            style: { ...css.input, fontFamily: 'ui-monospace, monospace' },
            defaultValue: current === undefined ? '{}' : JSON.stringify(current),
            disabled: !writable,
            onBlur: event => {
              try { set(key, JSON.parse(event.target.value)) } catch { /* keep the last valid value */ }
            },
          })
        } else {
          control = h('input', {
            style: css.input,
            type: kind === 'number' ? 'number' : 'text',
            value: current === undefined ? '' : String(current),
            min: node?.meta?.min,
            max: node?.meta?.max,
            step: node?.meta?.step,
            disabled: !writable,
            onChange: event => {
              const raw = event.target.value
              if (raw === '') { set(key, undefined); return }
              set(key, kind === 'number' ? Number(raw) : raw)
            },
          })
        }

        return h('div', { key, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('span', { style: css.advLabel }, labels[key] ?? key),
            overridden && writable
              ? h('button', {
                  style: { fontSize: '0.75em', opacity: 0.55, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0, font: 'inherit', color: 'inherit' },
                  onClick: () => set(key, undefined),
                }, t('reset'))
              : null,
          ),
          control,
          help !== undefined ? h('div', { style: css.note }, help) : null,
        )
      }).filter(Boolean)

      return h('div', { style: css.group },
        h('h3', { style: css.h3 }, t('advanced')),
        header,
        rows,
      )
    }

    /**
     * Register the sections that are currently switched on, and keep that set
     * in step with the two edition switches.
     *
     * A section exists only while its edition does: the plugin page's switches
     * decide whether the settings page, its models and its fields are offered at
     * all. They cannot be registered unconditionally and hidden, because a
     * registered `settings.section` is exactly what puts an entry in the nav.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-qoder-cn: dictionaries')

      // The two switches live on this bundle's own page in the plugin manager.
      // That page exists whether or not either edition is currently shown.
      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-agent-sdk-bridge',
        locale: NS,
      }, props => h(BundleSettings, { ...props, ctx, t }))), 'llm-qoder-cn: bundle options')

      ctx.effect(() => ctx.configForms.whileServed([NS], () => {
        const form = ctx.configForms.get(NS)
        const live = new Map()

        const sync = () => {
          const snapshot = form.getSnapshot()
          // Wait for the stored config before deciding what to show. Registering
          // optimistically would flash a page the user already switched off.
          if (snapshot.status !== 'ready') return
          const value = snapshot.value ?? {}
          for (const brand of BRANDS) {
            const enabled = value[brand.fields.enabled] !== false
            const current = live.get(brand.id)
            if (enabled && current === undefined) {
              live.set(brand.id, ctx.slots.inject('settings.section', () => ctx.slots.register({
                name: 'settings.section',
                id: brand.settingsId,
                order: brand.order,
                label: () => t(brand.navKey),
                locale: NS,
              }, props => h(SettingsPage, { ...props, ctx, t, brand }))))
            } else if (!enabled && current !== undefined) {
              current()
              live.delete(brand.id)
            }
          }
        }

        const unsubscribe = form.subscribe(sync)
        sync()
        return () => {
          unsubscribe()
          for (const off of live.values()) off()
          live.clear()
        }
      }), 'llm-qoder-cn: pages')
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-agent-sdk-bridge'
    exports.__test = {
      windowLabel, priceSuffix, ADVANCED, BRANDS, zh, en,
      SettingsPage, BundleSettings, UsageCard, CodeBuddyCard, QuotaLine, creditsOf, neverExpires,
      readCache, writeCache,
    }
    return module.exports
  },
})
