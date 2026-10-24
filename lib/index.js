import { createRequire } from "node:module";
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, ToolCallId, fileHandleText, isContextWindowExceededError, isQuotaExceededError, offloadedImageText, textOnlyImageText } from "@deepseek-ai/dsh-llm";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import * as cnSdk from "@qodercn-ai/qodercn-agent-sdk";
import { createSdkMcpServer, qodercliAuth } from "@qodercn-ai/qodercn-agent-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { isVolatile } from "@deepseek-ai/cosmokit";
import z$1 from "@deepseek-ai/schemastery";
//#region src/brand.ts
/** The CN edition, which the plugin was originally built for. */
const CN_BRAND = {
	id: "cn",
	provider: "qoder-cn",
	defaultDisplayName: "Qoder CN",
	enabledKey: "cnEnabled",
	sdkPackage: "@qodercn-ai/qodercn-agent-sdk",
	cliPackages: [{
		scope: "@qodercn-ai",
		name: "qoderclicn"
	}],
	cliCommands: ["qoderclicn", "qodercn"],
	configDirName: ".qoder-cn",
	setupScript: "setup-qoderclicn.bat",
	staticCatalog: true
};
/**
* The international edition.
*
* The static CN catalog is deliberately NOT reused: model ids differ between
* the two plans, and a fallback the account cannot actually run would put
* unusable entries in the picker. An unreachable intl CLI therefore reports no
* models, and the page's own guidance points at the install helper.
*/
const GLOBAL_BRAND = {
	id: "global",
	provider: "qoder-intl",
	defaultDisplayName: "Qoder 国际版",
	enabledKey: "intlEnabled",
	sdkPackage: "@qoder-ai/qoder-agent-sdk",
	cliPackages: [{
		scope: "@qoder-ai",
		name: "qodercli"
	}],
	cliCommands: ["qodercli", "qoder"],
	configDirName: ".qoder",
	setupScript: "setup-qodercli.bat",
	staticCatalog: false
};
/** Both brands, in the order the settings page lists them. */
const BRANDS = [CN_BRAND, GLOBAL_BRAND];
/** Whether a value names one of the two editions. */
function isQoderBrand(value) {
	return value === "cn" || value === "global";
}
/** The profile for one edition. */
function brandProfile(brand) {
	return brand === "global" ? GLOBAL_BRAND : CN_BRAND;
}
//#endregion
//#region src/catalog.ts
/** Default combined context capacity assumed for Qoder-backed models. */
const DEFAULT_CONTEXT_WINDOW = 2e5;
/** Default per-request output cap assumed for Qoder-backed models. */
const DEFAULT_MAX_TOKENS = 32e3;
/** Every model the account exposed at capture time, in SDK display order. */
const QODER_MODELS = [
	{
		id: "auto",
		name: "Auto",
		description: "Qoder 自动路由"
	},
	{
		id: "ultimate",
		name: "Ultimate",
		description: "最强档位路由"
	},
	{
		id: "performance",
		name: "Performance"
	},
	{
		id: "efficient",
		name: "Efficient"
	},
	{
		id: "lite",
		name: "Lite"
	},
	{
		id: "cmodel",
		name: "Cantus"
	},
	{
		id: "qmodel_38max",
		name: "Qwen3.8-Max"
	},
	{
		id: "qmodel_latest",
		name: "Qwen3.7-Max"
	},
	{
		id: "qmodel",
		name: "Qwen3.7-Plus"
	},
	{
		id: "kmodel_latest",
		name: "Kimi-K3"
	},
	{
		id: "kmodel",
		name: "Kimi-K2.7-Code"
	},
	{
		id: "gmodel",
		name: "GLM-5.3"
	},
	{
		id: "gm51model",
		name: "GLM-5.2"
	},
	{
		id: "dmodel",
		name: "DeepSeek-V4-Pro"
	},
	{
		id: "dfmodel",
		name: "DeepSeek-V4-Flash"
	},
	{
		id: "mmodel",
		name: "MiniMax-M3"
	}
];
/**
* Convenience aliases so a dsh deployment can keep using its own DeepSeek
* model names against the Qoder route.
*/
const MODEL_ALIASES = {
	"deepseek-v4-flash": "dfmodel",
	"deepseek-v4-pro": "dmodel"
};
/**
* Map a dsh-side model id onto a Qoder SDK model value.
*
* Aliases are checked first (config-supplied aliases take precedence over the
* built-in ones), then any `qoder-` prefix is stripped, and an empty result
* falls back to `auto`.
*
* @param model - model id from {@link import('@deepseek-ai/dsh-llm').GenerateOptions.model}.
* @param extraAliases - user-configured aliases, merged over {@link MODEL_ALIASES}.
* @returns the Qoder model value; the CLI falls back to `auto` for unknown values.
*/
function resolveQoderModelId(model, extraAliases) {
	const key = model.toLowerCase();
	const configured = extraAliases?.[key] ?? extraAliases?.[model];
	if (configured !== void 0 && configured.length > 0) return configured;
	const aliased = MODEL_ALIASES[key];
	if (aliased !== void 0) return aliased;
	const stripped = model.startsWith("qoder-") ? model.slice(6) : model;
	return stripped.length > 0 ? stripped : "auto";
}
//#endregion
//#region src/live.ts
/**
* Resolve one {@link Live} option, falling back when it is absent.
*
* @param value - the plain value or thunk, possibly undefined.
* @param fallback - value used when the option is absent or resolves to undefined.
* @returns the option's current value.
*/
function readLive(value, fallback) {
	const current = typeof value === "function" ? value() : value;
	return current === void 0 ? fallback : current;
}
/**
* Resolve one {@link Live} option that may legitimately be undefined.
*
* Separate from {@link readLive} because an option whose "unset" state is
* itself meaningful (`defaultReasoningEffort`: empty means "follow upstream")
* has no fallback to apply.
*
* @param value - the plain value or thunk, possibly undefined.
* @returns the option's current value, or undefined when it is unset.
*/
function readLiveOptional(value) {
	return typeof value === "function" ? value() : value;
}
//#endregion
//#region src/cli.ts
/**
* Finding the local Qoder CLI of one edition, and the Node that has to run it.
*
* The SDK's default transport runs its worker runtime on a Node worker thread,
* which is a thread *inside* the DSH process. On Windows that puts the worker's
* bundled sharp (libvips 8.17) into the same address space as DSH's own sharp
* (libvips 8.18), and the loader satisfies the worker's `libvips-42.dll` import
* from the module already registered under that name. The ABI mismatch that
* follows fails every turn carrying an image, with libvips reporting
* `colourspace: parameter space not set` and the CLI answering
* `image_processing_failed`.
*
* A child process has its own address space, and is how an installed
* `qoderclicn` runs by itself anyway, so sessions hand the SDK an entry it can
* spawn. Naming that entry is all it takes: the SDK picks its process transport
* for any `pathToQoderCLIExecutable` that is not a worker-runtime module, which
* is exactly the transport that must not be used here.
*
* Nothing is invented. The CLI is looked for where the setup helper installs
* it and where the SDK bundles it; the Node to run it is the host's own, DSH's
* shipped runtime, or whatever `PATH` answers. When none of that is present the
* lookup returns nothing and the SDK keeps its default transport — worse for
* images, but not this module's place to fail a session over.
*
* @module dsh-qoder-link/cli
*/
/**
* The switch that makes the CLI report its real token metering.
*
* The CLI prices every provider request, but before a usage record leaves the
* process it zeroes `input_tokens`, `output_tokens` and both cache buckets
* unless this switch is on — its own bundle guards the real values with
* `if (options?.exposeTokenCounts || tokenUsageRequested())`, and otherwise
* emits `{ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
* cache_read_input_tokens: 0 }` while keeping `credits` and the context ratio.
* That is why every counter the harness shows is an estimate here, and why
* `缓存命中` reads 0% no matter how much of a prompt the cache served.
*
* The names are the CLI's own env-catalog entries (`ENV_EXPOSE_TOKEN_USAGE`),
* brand-prefixed per build — the CN CLI reads `QODERCN_…`, the international
* one `QODER_…` — and both are set because which build answers is the lookup's
* decision, not this module's. The value is read as a boolean (`1`/`true`/`yes`).
*/
const EXPOSE_TOKEN_USAGE = {
	QODERCN_EXPOSE_TOKEN_USAGE: "1",
	QODER_EXPOSE_TOKEN_USAGE: "1"
};
/**
* A CLI the SDK can spawn, or nothing when this machine offers none.
*
* Candidates are tried in the order a user's own shell would resolve them:
* an explicit `QODERCLI_PATH` first, then the npm global roots, then the
* native builds the SDK and the CLI's own installer place. Each brand only
* ever sees its own package and state directory — handing the CN SDK the intl
* CLI (or the other way round) would speak one edition's protocol to the other
* edition's account. A worker-runtime module is skipped wherever it turns up,
* since the SDK answers such a path with the in-process worker this module
* exists to avoid.
*
* @param brand - which edition's CLI to look for.
* @param lookup - the machine to inspect; defaults to this process's.
*/
function resolveQoderCli(brand = "cn", lookup = {}) {
	const env = lookup.env ?? process.env;
	const platform = lookup.platform ?? process.platform;
	const exists = lookup.exists ?? existsSync;
	const suffix = platform === "win32" ? ".exe" : "";
	const node = resolveNode(lookup);
	for (const candidate of candidates(brand, env, suffix, node)) {
		if (!exists(candidate) || isWorkerRuntime(candidate)) continue;
		if (!isScript(candidate)) return { path: candidate };
		if (node !== void 0) return {
			path: candidate,
			nodeDir: path.dirname(node)
		};
	}
}
/**
* Query options that route a session through the CLI's own process.
*
* Empty when no CLI was found: the caller spreads this into its options, so an
* empty answer leaves the SDK's default transport in place.
*
* @param brand - which edition's CLI the session speaks to.
* @param lookup - the machine to inspect; defaults to this process's.
*/
function qoderCliOptions(brand = "cn", lookup = {}) {
	const cli = resolveQoderCli(brand, lookup);
	if (cli === void 0) return {};
	if (cli.nodeDir === void 0) return {
		pathToQoderCLIExecutable: cli.path,
		env: {
			...process.env,
			...EXPOSE_TOKEN_USAGE
		}
	};
	return {
		pathToQoderCLIExecutable: cli.path,
		executable: "node",
		env: {
			...process.env,
			PATH: `${cli.nodeDir}${path.delimiter}${process.env.PATH ?? ""}`,
			...EXPOSE_TOKEN_USAGE
		}
	};
}
/**
* Whether a CLI path belongs to the other edition.
*
* `QODERCLI_PATH` predates the international edition and is set globally by
* some CN installs. Both SDKs read that one variable from the parent process
* before anything else, so an intl session would otherwise spawn the CN CLI and
* answer with the CN account. A path that names an edition is therefore never
* offered to the other one; a neutral custom build is still honoured for both.
*/
function isForeignCliPath(brand, candidate) {
	const text = candidate.replace(/\\/g, "/").toLowerCase();
	const chinese = text.includes("qoderclicn") || text.includes("@qodercn-ai") || text.includes("/.qoder-cn/");
	const global = !chinese && (text.includes("@qoder-ai") || text.includes("/.qoder/") || /(^|[/_-])qodercli(\.exe|\.js|$)/.test(text));
	return brand === "global" ? chinese : global;
}
/**
* A `QODERCLI_PATH` that names the other edition, when this one has no CLI.
*
* The SDKs read that variable from the parent process before any option this
* plugin can pass, so when it is foreign and this edition has nothing of its
* own, the only honest answer is a configuration error — spawning the other
* edition's CLI would answer with the other edition's account.
*
* @param brand - the edition the caller is about to start.
* @param lookup - the machine to inspect; defaults to this process's.
*/
function foreignCliOverride(brand, lookup = {}) {
	const override = (lookup.env ?? process.env).QODERCLI_PATH;
	if (override === void 0 || override.length === 0) return void 0;
	if (!isForeignCliPath(brand, override)) return void 0;
	if (resolveQoderCli(brand, lookup) !== void 0) return void 0;
	return override;
}
/**
* The error text for {@link foreignCliOverride}.
*
* Deliberately says nothing about the variable or the path that caused it: the
* page's job here is to tell the user which CLI to install, not to explain the
* plugin's environment plumbing. The technical reason stays in the lookup.
*/
function cliConflictMessage(brand) {
	return `未检测到可用的 ${brandProfile(brand).cliCommands[0]}，请先安装并登录后再使用此版本。`;
}
/** Paths the CLI may live at, most explicit first. */
function candidates(brand, env, suffix, nodePath) {
	const profile = brandProfile(brand);
	const found = [];
	const push = (value) => {
		if (value !== void 0 && value.length > 0 && !found.includes(value)) found.push(value);
	};
	push(brand === "cn" ? env.QODERCN_CLI_PATH : env.QODER_CLI_PATH);
	if (env.QODERCLI_PATH !== void 0 && !isForeignCliPath(brand, env.QODERCLI_PATH)) push(env.QODERCLI_PATH);
	for (const root of nodeModulesRoots(env, nodePath)) for (const pkg of profile.cliPackages) {
		const dir = path.join(root, pkg.scope, pkg.name);
		push(path.join(dir, "bundle", `${pkg.name}.js`));
		push(path.join(dir, `${pkg.name}.js`));
	}
	const sdk = sdkDir(profile.sdkPackage);
	if (sdk !== void 0) for (const pkg of profile.cliPackages) push(path.join(sdk, "dist", "_bundled", `${pkg.name}${suffix}`));
	const home = env.QODER_CLI_HOME === void 0 || env.QODER_CLI_HOME.length === 0 ? homedir() : env.QODER_CLI_HOME;
	for (const pkg of profile.cliPackages) push(path.join(home, profile.configDirName, "local", `${pkg.name}${suffix}`));
	return found;
}
/** `node_modules` roots a global install can land in. */
function nodeModulesRoots(env, nodePath) {
	const roots = [];
	const push = (value) => {
		if (value !== void 0 && value.length > 0 && !roots.includes(value)) roots.push(value);
	};
	push(env.NPM_CONFIG_PREFIX === void 0 ? void 0 : path.join(env.NPM_CONFIG_PREFIX, "node_modules"));
	push(env.APPDATA === void 0 ? void 0 : path.join(env.APPDATA, "npm", "node_modules"));
	push(path.join(homedir(), ".npm-global", "node_modules"));
	if (nodePath !== void 0) push(path.join(path.dirname(path.dirname(nodePath)), "lib", "node_modules"));
	return roots;
}
/**
* The Node that runs a CLI script: this process when it *is* Node, else DSH's
* shipped runtime, else whatever `PATH` answers.
*
* DSH's runtime comes first among the fallbacks because it is the one Node a
* DSH install guarantees, whatever the user's PATH says — an Electron host
* launched from a desktop shortcut inherits an environment that need not carry
* Node at all.
*/
function resolveNode(lookup) {
	const env = lookup.env ?? process.env;
	const platform = lookup.platform ?? process.platform;
	const exists = lookup.exists ?? existsSync;
	const name = platform === "win32" ? "node.exe" : "node";
	const execPath = lookup.execPath ?? process.execPath;
	if (!(lookup.electron ?? process.versions.electron !== void 0) && path.basename(execPath).toLowerCase() === name) return execPath;
	const home = env.DSH_HOME === void 0 || env.DSH_HOME.length === 0 ? path.join(homedir(), ".dsh") : env.DSH_HOME;
	const runtimes = path.join(home, "dsh-runtimes");
	for (const runtime of listDir(runtimes, lookup)) {
		const candidate = path.join(runtimes, runtime, "dependencies", "node", "bin", name);
		if (exists(candidate)) return candidate;
	}
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (dir.length === 0) continue;
		const candidate = path.join(dir, name);
		if (exists(candidate)) return candidate;
	}
}
/**
* Directory of the installed SDK, for the native CLI build it may carry.
*
* The international package is optional, so a missing one answers undefined
* here rather than failing the lookup.
*/
function sdkDir(packageName) {
	try {
		return path.dirname(createRequire(import.meta.url).resolve(packageName));
	} catch {
		return;
	}
}
/** Listing that answers nothing rather than throwing on a missing directory. */
function listDir(dir, lookup) {
	const read = lookup.readdir ?? ((target) => readdirSync(target));
	try {
		return read(dir);
	} catch {
		return [];
	}
}
/** Whether the SDK would run this entry through an interpreter. */
function isScript(entry) {
	return /\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(entry);
}
/**
* Whether the SDK would answer this entry with its in-process worker runtime,
* which is the transport this module exists to avoid. Kept in step with the
* SDK's own recognition rule so a path is never silently routed back in-process.
*/
function isWorkerRuntime(entry) {
	return /^(?:qoder(?:cli|clicn|cn)?-)?worker-runtime(?:\.obf)?\.mjs$/i.test(path.basename(entry));
}
//#endregion
//#region src/sdk.ts
/**
* The SDK package behind each brand.
*
* Both editions publish the same API under different scopes, so the rest of the
* plugin imports this module instead of a package name. The CN SDK is a real
* dependency and is loaded statically; the international one is optional at
* runtime — a deployment that only has a CN account may not have it installed —
* so it is imported on demand and its absence is reported to the settings page
* as a plain error instead of failing the plugin's mount.
*
* The module is typed against the CN package because the two are API-compatible:
* every call site here is shared, and the only thing that changes is which
* process the protocol is spoken to.
*
* @module dsh-qoder-link/sdk
*/
let globalSdk;
/**
* Load the SDK for one brand.
*
* The CN module has no failure mode beyond a broken installation, which makes
* the plugin itself unloadable and is therefore not caught here. The
* international module can legitimately be absent, so its rejection carries an
* actionable message for the settings page.
*
* @param brand - which edition's SDK to load.
* @returns the SDK module.
*/
function loadSdk(brand) {
	if (brand === "cn") return Promise.resolve(cnSdk);
	globalSdk ??= importGlobalSdk();
	return globalSdk;
}
/**
* Import the international SDK by a variable specifier.
*
* A literal specifier would make TypeScript and the bundler require the package
* at build time, which is exactly what an optional edition must not do. The
* specifier is a constant, so no user input can influence it.
*/
async function importGlobalSdk() {
	const specifier = brandProfile("global").sdkPackage;
	try {
		return await import(
			/* @vite-ignore */
			specifier
);
	} catch (error) {
		globalSdk = void 0;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`未安装国际版 SDK（${specifier}）：${detail}`);
	}
}
//#endregion
//#region src/models.ts
/** How long a fetched catalog stays fresh by default. */
const DEFAULT_MODEL_CACHE_TTL_MS = 3e5;
/** Give up on one CLI catalog fetch after this long by default. */
const DEFAULT_FETCH_TIMEOUT_MS = 2e4;
/**
* Last successful catalog per brand, shared by every {@link QoderModelCatalog}
* in this process.
*
* A settings write does NOT restart this plugin — a volatile edit is committed
* into the running cells (see `live.ts`) — so the cache now only has to survive
* a real remount: enabling the plugin, a profile reload, or a DSH restart. It
* matters in exactly those cases, because the first settings read after the
* remount would otherwise cold-start the Qoder CLI and stall the page for
* seconds.
*
* The entry carries its own timestamp and is only used while it is still within
* the requesting catalog's TTL, so normal freshness is unchanged.
*/
const sharedSnapshots = /* @__PURE__ */ new Map();
/** Cached live CLI catalog with a static fallback. */
var QoderModelCatalog = class {
	brand;
	ttlMs;
	fetchTimeoutMs;
	cached;
	inflight;
	/** Why the last refresh failed, for the settings page's guidance. */
	failure;
	/**
	* @param brand - which edition's CLI answers.
	* @param ttlMs - how long a fetched catalog stays fresh before a re-fetch.
	*   Read per use, so a settings edit takes effect on the next read.
	* @param fetchTimeoutMs - how long one CLI catalog fetch may take before the
	*   static fallback takes over.
	*/
	constructor(brand, ttlMs, fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
		this.brand = brand;
		this.ttlMs = ttlMs;
		this.fetchTimeoutMs = fetchTimeoutMs;
	}
	/**
	* Raw live entries; the stale snapshot when a refresh fails, else nothing.
	*
	* Filtered to the subscription's official models here, so the picker and the
	* settings page cannot disagree about what the account has.
	*/
	async liveModels() {
		const ttlMs = readLive(this.ttlMs, DEFAULT_MODEL_CACHE_TTL_MS);
		const fresh = (snapshot) => snapshot !== void 0 && Date.now() - snapshot.at < ttlMs;
		const cached = this.cached ?? sharedSnapshots.get(this.brand);
		if (fresh(cached) && cached !== void 0) {
			this.cached = cached;
			return officialOnly(cached.models);
		}
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = void 0;
		});
		try {
			const models = await this.inflight;
			const snapshot = {
				at: Date.now(),
				models
			};
			this.cached = snapshot;
			sharedSnapshots.set(this.brand, snapshot);
			this.failure = void 0;
			return officialOnly(models);
		} catch (error) {
			this.failure = error instanceof Error ? error.message : String(error);
			return officialOnly((this.cached ?? sharedSnapshots.get(this.brand))?.models ?? []);
		}
	}
	/** Why the last refresh failed, or undefined when it succeeded. */
	get error() {
		return this.failure;
	}
	/**
	* Drop the cached catalog so the next read goes back to the CLI.
	*
	* What the CLI answers depends on state this plugin does not own — whether it
	* is installed at all, and which account is signed in — and an empty answer is
	* cached like any other. So after the setup helper has run, the page's next
	* read must not be served from a snapshot taken before that login existed.
	*/
	invalidate() {
		this.cached = void 0;
		sharedSnapshots.delete(this.brand);
		this.failure = void 0;
	}
	/** dsh catalog entries: the enabled live list, or the static fallback. */
	async models() {
		const live = (await this.liveModels()).filter((model) => model.isEnabled !== false);
		if (live.length === 0) return brandProfile(this.brand).staticCatalog ? QODER_MODELS : [];
		return live.map((model) => ({
			id: model.value,
			name: model.displayName.length > 0 ? model.displayName : model.value,
			...model.description.length > 0 ? { description: model.description } : {},
			...model.isVl === true ? { isVl: true } : {}
		}));
	}
	async fetch() {
		if (foreignCliOverride(this.brand) !== void 0) throw new Error(cliConflictMessage(this.brand));
		const sdk = await loadSdk(this.brand);
		const q = sdk.query({
			prompt: inertInput$1(),
			options: {
				...qoderCliOptions(this.brand),
				auth: sdk.qodercliAuth(),
				tools: [],
				allowedTools: [],
				settingSources: [],
				maxTurns: 1
			}
		});
		try {
			return await withTimeout(q.getAvailableModels({ fetchStrategy: "live" }), readLive(this.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS));
		} finally {
			await q.close().catch(() => void 0);
		}
	}
};
/**
* Keep only the subscription's official models.
*
* The CLI also returns models the account added itself (`source` is `user` or
* `custom`): bring-your-own-key routes, which upstream serves on a separate
* provider. DSH runs on the subscription catalog and has no use for those, so
* they are dropped at this single layer — the picker, the settings page and
* the request path all read from here and cannot diverge.
*
* @param models - entries as the CLI reported them.
* @returns the same list without account-added entries.
*/
function officialOnly(models) {
	return models.filter((model) => model.source !== "user" && model.source !== "custom");
}
/**
* The credit multiplier upstream quotes for one model.
*
* Present on every live entry as `priceFactor`; `0` means the model is free.
* Returned as a number rather than a formatted string so callers decide how to
* render it.
*
* @param entry - one live catalog entry.
* @returns the multiplier, or undefined when upstream did not quote one.
*/
function priceFactorOf(entry) {
	const value = entry.priceFactor;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
/** Streaming prompt that never yields, so no model turn runs during the fetch. */
async function* inertInput$1() {
	await new Promise(() => {});
}
function withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(/* @__PURE__ */ new Error(`qoder request timed out after ${ms}ms`));
		}, ms);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
//#endregion
//#region src/tokens.ts
/**
* Script-aware text pricing, shared by the input and output estimators.
*
* The harness prices text at a flat 4 chars/token (dsh-token-meter's
* `CHARS_PER_TOKEN`). That is close for Latin text but under-prices Chinese by
* about 2.3x, which matters twice over in this plugin: it reports the tokens for
* a turn, and the harness derives `tok/s` from the output half of that report.
* A flat rate therefore made Chinese replies look roughly half as fast as they
* really are.
*
* The rates below were measured against this backend's own tokenizer, by
* least-squares fit over four content sizes per script, each read against the
* CLI's `context_usage_ratio` with a window the CLI had confirmed it honoured:
*
* | script | chars/token | tokens/char |
* |--------|-------------|-------------|
* | CJK    | 1.77        | 0.565       |
* | ASCII  | 5.20        | 0.192       |
*
* A constant offset in that fit (qodercli's own prompt, skills and tool
* definitions, ~127 tokens) is deliberately not modelled here: it belongs to the
* CLI's session, not to the text being priced.
* @module dsh-qoder-link/tokens
*/
/** Characters per token for wide (CJK) text, measured. */
const WIDE_CHARS_PER_TOKEN = 1.77;
/** Characters per token for narrow (Latin, digits, punctuation) text, measured. */
const NARROW_CHARS_PER_TOKEN = 5.2;
/**
* Whether this tokenizer prices a character as wide (CJK) text.
*
* Ranges follow the Unicode blocks that CJK tokenizers treat as one-or-more
* tokens per character, including the fullwidth forms that Chinese punctuation
* uses. Everything else is priced as narrow text.
*/
function isWideChar(character) {
	const code = character.codePointAt(0) ?? 0;
	return code >= 4352 && code <= 4447 || code >= 11904 && code <= 12350 || code >= 12353 && code <= 13311 || code >= 13312 && code <= 19903 || code >= 19968 && code <= 40959 || code >= 40960 && code <= 42191 || code >= 44032 && code <= 55203 || code >= 63744 && code <= 64255 || code >= 65072 && code <= 65135 || code >= 65280 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 131072 && code <= 262141;
}
/** How many of a text's characters are wide (CJK) text. */
function countWideChars(text) {
	let wide = 0;
	for (const character of text) if (isWideChar(character)) wide += 1;
	return wide;
}
/**
* Price text by its script mix, rather than at a flat 4 chars/token.
*
* @param chars - total character count.
* @param wideChars - how many of those characters are wide (CJK) text.
* @returns the estimated token count.
*/
function estimateTextTokens(chars, wideChars) {
	const wide = Math.max(0, Math.min(chars, wideChars));
	return wide / WIDE_CHARS_PER_TOKEN + (chars - wide) / NARROW_CHARS_PER_TOKEN;
}
/**
* The output tokens one turn generated, priced by script.
*
* Everything the model produced belongs here, whatever block carried it: visible
* text, reasoning, and tool-call names and arguments. That last one is easy to
* miss and usually the largest — measured at 86% of the characters in a
* three-call turn — and because the harness derives `tok/s` from the output
* tokens an adapter reports, omitting it under-reports speed several fold on
* exactly the multi-step agentic work where the figure is worth reading.
*
* Reasoning is a SUBSET of the output total, not a separate bucket: the harness
* discards an entire reading whose `reasoningTokens` exceeds its `outputTokens`,
* so {@link usage} clamps it rather than trusting the caller to.
*/
var TurnOutputAccounting = class {
	chars = 0;
	wideChars = 0;
	reasoningChars = 0;
	reasoningWideChars = 0;
	/** Count generated text: visible output, or a tool-call name or arguments. */
	addOutput(text) {
		if (text.length === 0) return;
		this.chars += text.length;
		this.wideChars += countWideChars(text);
	}
	/** Count generated reasoning, which is also part of the output total. */
	addReasoning(text) {
		if (text.length === 0) return;
		this.addOutput(text);
		this.reasoningChars += text.length;
		this.reasoningWideChars += countWideChars(text);
	}
	/** Total generated characters, for diagnostics. */
	get outputChars() {
		return this.chars;
	}
	/** Generated reasoning characters, a subset of {@link outputChars}. */
	get reasoningCharsTotal() {
		return this.reasoningChars;
	}
	/** Discard the turn's counts; called when a turn ends or is retried. */
	reset() {
		this.chars = 0;
		this.wideChars = 0;
		this.reasoningChars = 0;
		this.reasoningWideChars = 0;
	}
	/**
	* The turn's `outputTokens` and, when it reasoned, its `reasoningTokens`.
	*
	* Both are at least 1 so a turn that produced only a tool call still reports a
	* positive count, and reasoning never exceeds output.
	*/
	usage() {
		const outputTokens = Math.max(1, Math.ceil(estimateTextTokens(this.chars, this.wideChars)));
		if (this.reasoningChars === 0) return { outputTokens };
		const reasoningTokens = Math.max(1, Math.ceil(estimateTextTokens(this.reasoningChars, this.reasoningWideChars)));
		return {
			outputTokens,
			reasoningTokens: Math.min(reasoningTokens, outputTokens)
		};
	}
	/**
	* This turn's reasoning tokens, clamped inside a real metered output total.
	*
	* Used when the CLI reports genuine `output_tokens`: the reasoning figure is
	* still the local estimate, but it must stay a subset of what the provider
	* counted or the harness discards the reading.
	*
	* @param meteredOutput - the provider's own output token count.
	* @returns a spreadable `reasoningTokens` field, or nothing when unmeasured.
	*/
	reasoningTokensWithin(meteredOutput) {
		if (this.reasoningChars === 0) return {};
		const reasoningTokens = Math.ceil(estimateTextTokens(this.reasoningChars, this.reasoningWideChars));
		return { reasoningTokens: Math.max(0, Math.min(meteredOutput, reasoningTokens)) };
	}
};
//#endregion
//#region src/render.ts
/**
* Render harness messages into the turns fed to the inner Qoder session.
* Tool calls and results need no protocol here — they travel through the
* in-process MCP server — so this layer handles conversational context: the
* host system prompt, user turns, and (for full rebuilds) prior history as
* compact text.
*
* A feed is plain text unless the *current* turn carries image occurrences,
* in which case it is a part list so those bytes can ride along. Historical
* images stay text: the harness has already replaced them with its own
* placeholder for text-only routes, and re-sending archived pixels on every
* rebuild would price a screenshot into every later request.
* @module dsh-llm-qoder/render
*/
/**
* Image references in block order, skipping occurrences the surface already
* offloaded: an offload is a durable fact the harness renders as path-bearing
* placeholder text on every route, so re-sending those pixels would undo it.
*/
function imageRefs(blocks) {
	const refs = [];
	for (const block of blocks) if (block.type === "image" && block.offloaded !== true) refs.push(block.attachment);
	return refs;
}
/** Render one content-block list as plain text; non-text blocks get handles. */
function renderBlocks(blocks) {
	const parts = [];
	for (const block of blocks) switch (block.type) {
		case "text":
			parts.push(block.text);
			break;
		case "reasoning": break;
		case "image":
			parts.push(block.offloaded === true ? offloadedImageText(block.attachment) : textOnlyImageText(block.attachment));
			break;
		case "file":
			parts.push(fileHandleText(block.attachment, void 0));
			break;
		case "tool-call":
			parts.push(`[调用了工具 ${block.name}(${block.arguments})]`);
			break;
		case "tool-addition":
			parts.push(`[工具启用 ${block.toolName}]`);
			break;
		case "tool-removal":
			parts.push(`[工具停用 ${block.toolName}]`);
			break;
		default: parts.push(JSON.stringify(block));
	}
	return parts.join("\n");
}
/** Role tag {@link renderMessage} uses, without the rendered content. */
function roleTag(message) {
	switch (message.role) {
		case "system": return "系统提示";
		case "developer": return "开发者";
		case "user": return "用户";
		case "assistant": return "助手";
		case "tool": return "工具结果";
	}
}
/**
* Render one request message with its role tag. A request-only user input has
* no durable identity or source, so it reads exactly like a user message.
*/
function renderMessage(message) {
	return `[${roleTag(message)}] ${renderBlocks(message.content)}`;
}
/** Preamble establishing the inner model's role as this agent's LLM backend. */
const BACKEND_ROLE = [
	"你在为一个编码 agent（宿主）充当 LLM API 后端：宿主把它的对话喂给你，你只输出\"下一条助手回复\"本身。",
	"宿主的工具已经通过 MCP 挂进来，需要用工具时直接调用，不要描述你会在别的环境里怎么调。",
	"不要复述对话，不要解释你的角色。"
].join("\n");
/**
* Join feed sections into one feed. While no section carries an image the
* result is the historical text shape, sections separated by a blank line;
* the first image turns the whole feed into parts, with the text around it
* merged into the parts before and after.
*/
function joinFeeds(sections) {
	const parts = [];
	const push = (part) => {
		if (part.type === "text" && part.text.length === 0) return;
		const previous = parts.at(-1);
		if (previous !== void 0 && previous.type === "text" && part.type === "text") {
			previous.text = `${previous.text}\n\n${part.text}`;
			return;
		}
		parts.push(part.type === "text" ? {
			type: "text",
			text: part.text
		} : {
			type: "image",
			attachment: part.attachment
		});
	};
	for (const section of sections) if (typeof section === "string") push({
		type: "text",
		text: section
	});
	else for (const part of section) push(part);
	if (parts.filter((part) => part.type === "image").length > 0) return parts;
	return parts.map((part) => part.type === "text" ? part.text : "").join("\n\n");
}
/** Render a block list as parts, keeping image occurrences as their references. */
function blockParts(blocks) {
	const parts = [];
	let pending = [];
	const flush = () => {
		if (pending.length === 0) return;
		parts.push({
			type: "text",
			text: pending.join("\n")
		});
		pending = [];
	};
	for (const block of blocks) {
		if (block.type === "image" && block.offloaded !== true) {
			flush();
			parts.push({
				type: "image",
				attachment: block.attachment
			});
			continue;
		}
		const text = renderBlocks([block]);
		if (text.length > 0) pending.push(text);
	}
	flush();
	return parts;
}
/** Prefix a label onto a feed, folding it into the leading text when there is any. */
function label(labelText, feed) {
	if (typeof feed === "string") return labelText + feed;
	const first = feed[0];
	if (first === void 0) return [{
		type: "text",
		text: labelText
	}];
	if (first.type === "text") return [{
		type: "text",
		text: `${labelText}${first.text}`
	}, ...feed.slice(1)];
	return [{
		type: "text",
		text: labelText
	}, ...feed];
}
/**
* Index where the message list's current turn starts: everything after the
* last assistant reply is new content the inner session has not seen, so its
* images are worth forwarding as bytes.
*/
function currentTurnStart(messages) {
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "assistant") return i + 1;
	return 0;
}
/** Image references carried by a feed, in order. */
function feedImageRefs(feed) {
	if (typeof feed === "string") return [];
	return feed.filter((part) => part.type === "image").map((part) => part.attachment);
}
/** Flatten a feed back to text, replacing images with the harness handle text. */
function feedToText(feed) {
	if (typeof feed === "string") return feed;
	return feed.map((part) => part.type === "text" ? part.text : textOnlyImageText(part.attachment)).filter((text) => text.length > 0).join("\n\n");
}
/** Literal characters in a feed; images contribute their pixels, not text. */
function feedTextLength(feed) {
	if (typeof feed === "string") return feed.length;
	return feed.reduce((total, part) => total + (part.type === "text" ? part.text.length : 0), 0);
}
/**
* How many of a feed's literal characters are wide (CJK) text.
*
* The token estimate prices wide and narrow text at different rates, so a bare
* character count is not enough to price a feed that mixes Chinese and code.
*/
function feedWideCharCount(feed) {
	if (typeof feed === "string") return countWideChars(feed);
	return feed.reduce((total, part) => total + (part.type === "text" ? countWideChars(part.text) : 0), 0);
}
/**
* Compose the first feed for a fresh session: backend role, the host system
* prompt, and the existing conversation as compact context. Messages of the
* current turn keep their image references; earlier ones are handles.
*/
function renderInitialFeed(system, messages) {
	const from = currentTurnStart(messages);
	const history = [];
	for (const [index, message] of messages.entries()) {
		const entry = index >= from && imageRefs(message.content).length > 0 ? label(`[${roleTag(message)}] `, blockParts(message.content)) : renderMessage(message);
		if (feedToText(entry).length > 0) history.push(entry);
	}
	const sections = [BACKEND_ROLE];
	if (system !== void 0 && system.length > 0) sections.push(`---- 宿主系统提示（作为你的行为准则） ----\n${system}`);
	const first = history[0];
	if (first !== void 0) {
		sections.push(label("---- 宿主对话记录 ----\n", first));
		sections.push(...history.slice(1));
	}
	sections.push("---- 以上是背景。输出下一条助手回复。 ----");
	return joinFeeds(sections);
}
/** Render a brand-new host user turn; images stay references, text-only stays a string. */
function renderUserTurn(blocks) {
	if (imageRefs(blocks).length === 0) return `[用户] ${renderBlocks(blocks)}`;
	return label("[用户] ", blockParts(blocks));
}
/** Render an in-place-updated message (runtime-context snapshots and the like). */
function renderRefreshed(message) {
	return `${renderMessage(message)}\n（宿主原位刷新了这条消息）`;
}
//#endregion
//#region src/jsonschema.ts
/**
* Convert dsh `ToolSchema.parameters` (a JSON Schema object) into a zod raw
* shape for the SDK's in-process MCP `tool()` registration. Fidelity is
* one-directional on purpose: anything the converter does not recognize maps
* to `z.unknown()`, and objects stay loose (zod strips unknown keys instead
* of rejecting them), so a converted tool never rejects arguments the host
* tool would have accepted. Unmapped PROPERTY NAMES still appear in the shape
* (as `z.unknown()`), so nothing the model sends is silently stripped.
* @module dsh-llm-qoder/jsonschema
*/
/**
* Convert one JSON Schema node into one zod schema.
* @param schema - a JSON Schema node (object form expected).
* @param depth - recursion guard; past the cap every node becomes `z.unknown()`.
* @returns a zod schema covering the recognized constructs.
*/
function jsonSchemaToZod(schema, depth = 0) {
	if (schema === void 0 || depth > 6) return z.unknown();
	if (Array.isArray(schema.enum)) {
		const values = schema.enum.filter((v) => typeof v === "string");
		if (values.length === schema.enum.length && values.length > 0) return z.enum(values);
		return z.unknown();
	}
	const type = schema.type;
	const description = typeof schema.description === "string" ? schema.description : void 0;
	let base;
	switch (type) {
		case "string":
			base = z.string();
			break;
		case "number":
			base = z.number();
			break;
		case "integer":
			base = z.number().int();
			break;
		case "boolean":
			base = z.boolean();
			break;
		case "array": {
			const items = schema.items;
			base = z.array(jsonSchemaToZod(typeof items === "object" && items !== null && !Array.isArray(items) ? items : void 0, depth + 1));
			break;
		}
		case "object": {
			const properties = schema.properties;
			const required = Array.isArray(schema.required) ? schema.required.filter((v) => typeof v === "string") : [];
			const shape = {};
			if (typeof properties === "object" && properties !== null) for (const [key, node] of Object.entries(properties)) {
				const nodeSchema = typeof node === "object" && node !== null && !Array.isArray(node) ? node : void 0;
				shape[key] = required.includes(key) ? jsonSchemaToZod(nodeSchema, depth + 1) : jsonSchemaToZod(nodeSchema, depth + 1).optional();
			}
			base = z.object(shape);
			break;
		}
		default: base = z.unknown();
	}
	return description === void 0 ? base : base.describe(description);
}
/**
* Convert a tool's `parameters` JSON Schema into a zod raw shape for `tool()`.
* A non-object schema yields a single catch-all shape so registration stays valid.
* @param parameters - the JSON Schema object from a dsh `ToolSchema`.
* @returns the zod raw shape handed to the SDK MCP `tool()`.
*/
function jsonSchemaToShape(parameters) {
	const properties = parameters.properties;
	if (typeof properties !== "object" || properties === null) return {};
	const shape = {};
	const required = Array.isArray(parameters.required) ? parameters.required.filter((v) => typeof v === "string") : [];
	for (const [key, node] of Object.entries(properties)) {
		const nodeSchema = typeof node === "object" && node !== null && !Array.isArray(node) ? node : void 0;
		shape[key] = required.includes(key) ? jsonSchemaToZod(nodeSchema, 1) : jsonSchemaToZod(nodeSchema, 1).optional();
	}
	return shape;
}
//#endregion
//#region src/session.ts
/**
* One long-lived inner Qoder CLI session per host session id: a channel-fed
* `query()` subprocess whose model continuation streams out as harness
* `StreamChunk`s. Host tool calls travel through an in-process MCP server:
* the handler parks on a promise, the adapter finishes the turn with
* `tool-calls`, and the next host request (carrying tool results) resolves
* the parked promise so the inner model continues with the result in place.
* @module dsh-llm-qoder/session
*/
/** MCP server name this adapter exposes host tools under. */
const MCP_SERVER_NAME = "dsh-host";
/** Prefix qodercli uses for this server's tools inside `canUseTool`. */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
/**
* How long a handler the CLI never announced waits for a result before failing.
*
* Paired handlers are settled by the host request that follows them, not by
* this deadline: a host tool may legitimately run far longer than two minutes,
* and a wall clock cannot tell a slow tool from a lost call.
*/
const DEFAULT_TOOL_RESULT_TIMEOUT_MS = 12e4;
/** How long the inner process gets to acknowledge an abort before the turn is force-ended. */
const DEFAULT_ABORT_GRACE_MS = 5e3;
/** Inner turns allowed for one side-channel (title, compaction) request. */
const DEFAULT_COLD_MAX_TURNS = 4;
/** Minimal push-only async channel feeding the SDK's streaming-input mode. */
function createChannel() {
	const queue = [];
	let resolve = null;
	return {
		push(message) {
			if (resolve !== null) {
				const settle = resolve;
				resolve = null;
				settle({
					value: message,
					done: false
				});
			} else queue.push(message);
		},
		[Symbol.asyncIterator]() {
			return { next() {
				const message = queue.shift();
				if (message !== void 0) return Promise.resolve({
					value: message,
					done: false
				});
				return new Promise((settle) => {
					resolve = settle;
				});
			} };
		}
	};
}
/** Unbounded FIFO the consumer pushes into and the active turn pumps out. */
var TurnQueue = class {
	items = [];
	resolve = null;
	closed = false;
	push(item) {
		if (this.closed) return;
		if (this.resolve !== null) {
			const settle = this.resolve;
			this.resolve = null;
			settle({
				value: item,
				done: false
			});
		} else this.items.push(item);
	}
	close() {
		this.closed = true;
		if (this.resolve !== null) {
			const settle = this.resolve;
			this.resolve = null;
			settle({
				value: void 0,
				done: true
			});
		}
	}
	[Symbol.asyncIterator]() {
		return { next: () => {
			const item = this.items.shift();
			if (item !== void 0) return Promise.resolve({
				value: item,
				done: false
			});
			if (this.closed) return Promise.resolve({
				value: void 0,
				done: true
			});
			return new Promise((settle) => {
				this.resolve = settle;
			});
		} };
	}
	/** Whether the turn already ended; late pushes are dropped. */
	get isClosed() {
		return this.closed;
	}
};
/**
* Whether a usage record carries real metering rather than the CLI's zero filler.
*
* The CLI attaches a usage record to several frames and leaves the four token
* counters at zero on all but one kind; a real request always consumed a prompt
* and produced output, so at least one counter being positive is the whole test.
*/
function carriesTokens(usage) {
	const positive = (value) => typeof value === "number" && value > 0;
	return positive(usage.input_tokens) || positive(usage.output_tokens) || positive(usage.cache_read_input_tokens) || positive(usage.cache_creation_input_tokens);
}
/**
* The occupancy sample one arriving frame may contribute, if any.
*
* Exactly one carrier may: the `message_delta` emitted when a provider request
* finishes, whose usage describes that request's prompt — which is precisely
* what context occupancy means. The other carriers are traps, confirmed against
* a live CLI with a tool the inner model calls four times in one turn:
*
*  - `message_start`, and the assembled `assistant` message, report all four
*    counters as zero; a request's numbers exist only once it finishes.
*  - the `result` frame reports the WHOLE inner turn's total, summed over every
*    provider request that turn made. One host step is one request, but an inner
*    turn ends only when the model stops calling tools, so a long agentic run
*    reports a multiple of any real prompt — that four-request turn ended at
*    `input_tokens` 2 921 where each request had used 608–837. Taking that total
*    as the session's occupancy pegged the harness context meter at 100%
*    (9.8M against a 1M window) and latched it there.
*
* @param message - one arriving SDK message.
* @returns the usage to sample, or undefined when this frame may not supply one.
*/
function requestUsageSample(message) {
	if (message.type !== "stream_event") return void 0;
	const usage = message.event?.usage ?? message.event?.message?.usage;
	return usage !== void 0 && carriesTokens(usage) ? usage : void 0;
}
/**
* One frame's own metering, translated into the harness's token buckets.
*
* Three rules, each measured against a live CLI rather than inferred:
*
* 1. `input_tokens` IS the whole prompt, cache included. The CLI measures its
*    `context_usage_ratio` as `input_tokens / window` (a probe: 9 811 input at
*    a 200 000 window → exactly 0.049055) and subtracts the cached part
*    afterwards for its own telemetry — so the harness's four buckets, which
*    are disjoint, have to take both cache halves back out of `inputTokens`.
* 2. Both cache buckets are always reported, zero included. The harness shows a
*    turn's usage only when its accounting is complete: a missing cache bucket
*    with no `totalTokens` to prove the sum makes the whole disclosure
*    unavailable, so omitting a zero would hide every per-turn usage row.
* 3. `totalTokens` is the sum of the four buckets, so the harness's
*    consistency check (`total - output == input + cacheRead + cacheWrite`)
*    holds by construction.
*
* @param real - the CLI's usage frame, or undefined when it reported none.
* @param reasoning - the local reasoning estimate, clamped inside the provider's
*   own output total (the harness drops a reading whose reasoning exceeds it).
* @returns the harness usage, or undefined when the frame carries no metering.
*/
function meteredUsage(real, reasoning) {
	if (real === void 0 || typeof real.input_tokens !== "number" || typeof real.output_tokens !== "number" || real.input_tokens <= 0 && real.output_tokens <= 0) return void 0;
	const cacheReadTokens = typeof real.cache_read_input_tokens === "number" ? real.cache_read_input_tokens : 0;
	const cacheWriteTokens = typeof real.cache_creation_input_tokens === "number" ? real.cache_creation_input_tokens : 0;
	const inputTokens = Math.max(0, real.input_tokens - cacheReadTokens - cacheWriteTokens);
	const outputTokens = real.output_tokens;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
		...reasoning(outputTokens)
	};
}
/**
* The host tool runtime dispatches by the bare host name; the inner model
* only ever sees the namespaced MCP form, so strip the prefix on the way out.
*/
function hostToolName(name) {
	return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}
/** Deny native tools, allow this adapter's MCP tools. */
async function gateTools(toolName, _input, options) {
	const echo = options.toolUseID !== void 0 ? { toolUseID: options.toolUseID } : {};
	if (toolName.startsWith(MCP_TOOL_PREFIX)) return {
		behavior: "allow",
		...echo
	};
	return {
		behavior: "deny",
		message: "本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。",
		...echo
	};
}
/** Message the inner model reads when a host turn superseded a parked call. */
const SUPERSEDED_CALL_TEXT = "[宿主取消了这次工具执行]";
/** Payload for a call the host request that followed it did not answer. */
function unansweredCall(toolUseId) {
	return {
		content: [{
			type: "text",
			text: `宿主未返回这次工具调用的结果（toolUseId=${toolUseId}），本次工具调用已取消`
		}],
		isError: true
	};
}
/**
* The tool-result bridge between the inner CLI and the host.
*
* qodercli announces a tool call twice, under two different identities:
* `canUseTool` receives the CLI's own tool-use id *before* the call runs, while
* the MCP `tools/call` handler that actually needs the host's result receives no
* id at all. The two arrive in the same order, so a FIFO pairs them — and the
* handler then parks under the exact id the host's result was filed under.
*
* ## Why that FIFO belongs to the session, not to a turn
*
* Measured against a live CLI, the handler can fire *after* the turn it belongs
* to has already ended. The host answers a tool call as soon as it sees the
* block, so the adapter's `deliverToolResults` files the result while nothing is
* parked yet, and only then does the CLI get around to dispatching the MCP call:
*
* ```
* 6198ms  [endTurn] kind=tool-calls
* 6198ms  [host] no parked handler -> BUFFERED under key=call_80d292a7…
* 6217ms  [mcp handler] ENTER | shifted toolUseId=undefined
* 6217ms  [mcp handler] PARKING under key=anonymous-1
* 14226ms [mcp handler] TIMED OUT after 8009ms
* ```
*
* Clearing the announcements at the turn boundary therefore threw away the very
* id the handler was about to claim. The handler fell through to a fallback key
* nothing could resolve, parked for the whole tool-result timeout, and the turn
* stalled — 120 s by default, which the user reads as "the model stopped
* answering" and works around by stopping the conversation and resending. The
* stall is probabilistic because a *slow* host tool (a shell command) parks its
* handler before the turn ends and takes the other path, while a fast one
* (`read`, `ask_user_question`) loses the race.
*
* ## Why a parked call must not have a wall-clock deadline
*
* A host result can only arrive on the next host request: the host runs every
* tool of the round first, then sends one request carrying all their results.
* A host tool is allowed to run for minutes (a build, a directory scan, a long
* shell command), and one slow tool delays the results of its whole batch. A
* fixed 120 s deadline therefore cancels calls whose real result is still on
* its way:
*
* ```
* 10:07:53  [mcp handler] PARK call_00_QFqbaum… (write — result ready at once)
* 10:07:53  [host]         pwsh starts (its own timeout: 300 s)
* 10:09:53  [mcp handler] TIMED OUT after 120s   <- write cancelled for nothing
* 10:10:38  [host]         first request arrives with all three results
* ```
*
* The request boundary is the real signal: the request that continues a tool
* round carries a result for every call the host answered; a call it did not
* answer in that request will never be answered. {@link beginHostRequest}
* settles those, so a slow host never loses a result it was about to send.
* Only a handler with no announced id — where no result can be matched at all
* — keeps a bounded park as the last-resort recovery.
*
* ## Why the boundary alone is not enough
*
* The boundary settles what is *already* parked when it runs, and an
* announcement that arrives after it is not touched by it. That leaves one
* shape a wall clock used to break and nothing else could: the CLI dispatches
* an MCP call whose tool-use block never reached the host. No result can be
* filed for that id, and the boundary that would settle it needs the next host
* request — which needs this turn to end first, and this turn is blocked on the
* handler. The turn hangs until the user stops it. {@link claim} therefore
* checks {@link ToolResultPairing.hostVisible} before parking: a call the host
* was never shown fails at once, exactly as the boundary would have failed it.
*
* Announcements are dropped only where the CLI provably cancels its pending
* dispatch — {@link forgetUnclaimed} on an aborted or failed turn, and
* {@link clear} when the session dies.
*/
var ToolResultPairing = class {
	/** Handlers parked under the tool-use id their host result will arrive as. */
	parked = /* @__PURE__ */ new Map();
	/** Results that arrived before their handler did, by tool-use id. */
	buffered = /* @__PURE__ */ new Map();
	/** Tool-use ids `canUseTool` allowed, in execution order, awaiting a handler. */
	announced = [];
	/**
	* Announcements a host request has moved past without answering.
	*
	* A handler for one of these can still fire (the CLI decides when to dispatch
	* the MCP call), but no result will ever arrive for it; {@link claim} settles
	* it immediately instead of parking it for the fallback timeout.
	*/
	abandoned = [];
	/**
	* Host callId (`qoder-N`) → qodercli tool-use id, from the content-block ids.
	*
	* Keyed by a per-session nonce, so a stale entry can never be reached by a
	* later call and is safe to keep across turns; it is dropped with the session.
	*/
	hostCallIds = /* @__PURE__ */ new Map();
	/**
	* Tool-use ids the host was actually shown, and has not answered yet.
	*
	* A host result is filed under a tool-use id only because the adapter emitted
	* that call's block to the host, so these — and only these — are calls the
	* host can still answer. {@link claim} refuses to park on any other id; see
	* the deadlock it prevents there. Mirrors the values of {@link hostCallIds}
	* and is cleared everywhere that map is.
	*/
	hostVisible = /* @__PURE__ */ new Set();
	/** Suffix for a handler that claimed no announcement, so keys stay distinct. */
	anonymous = 0;
	/** Record the tool-use id `canUseTool` allowed, in execution order. */
	announce(toolUseId) {
		this.announced.push(toolUseId);
	}
	/** Record which tool-use id a model-emitted tool-call block belongs to. */
	mapHostCall(hostCallId, toolUseId) {
		this.hostCallIds.set(hostCallId, toolUseId);
		this.hostVisible.add(toolUseId);
	}
	/**
	* Hand one MCP handler the result the host already delivered, or park it until
	* the host delivers one.
	*
	* A paired call is NOT timed out. The host can only answer on its next
	* request, and a host tool may legitimately run for minutes; the next request
	* settles it instead — see {@link beginHostRequest}. `timeoutMs` is therefore
	* reached only by a handler the CLI never announced, where no id exists to
	* match a result against and a bounded park remains the last resort.
	*
	* Parking forever is safe only for a call the host was shown; an announced id
	* the host never received fails at once rather than hanging the turn. See the
	* measurement in the body.
	*
	* @param timeoutMs - how long an *unpaired* handler waits before failing.
	* @returns the host's result, a cancellation, or a timeout payload.
	*/
	async claim(timeoutMs) {
		const toolUseId = this.announced.shift();
		if (toolUseId !== void 0) {
			const ready = this.buffered.get(toolUseId);
			if (ready !== void 0) {
				this.buffered.delete(toolUseId);
				return ready;
			}
			if (!this.hostVisible.has(toolUseId)) return unansweredCall(toolUseId);
			return await this.park(toolUseId);
		}
		const abandoned = this.abandoned.shift();
		if (abandoned !== void 0) return unansweredCall(abandoned);
		if (this.parked.size === 0 && this.buffered.size === 1) {
			const only = this.buffered.entries().next();
			if (only.done !== true) {
				this.buffered.delete(only.value[0]);
				return only.value[1];
			}
		}
		return await this.park(`anonymous-${++this.anonymous}`, timeoutMs);
	}
	/**
	* Park one handler under `key` until the host answers, the request boundary
	* settles it, or — for an unpaired key only — the fallback timeout expires.
	*/
	async park(key, timeoutMs) {
		return await new Promise((resolve) => {
			let timer;
			if (timeoutMs !== void 0) timer = setTimeout(() => {
				this.parked.delete(key);
				resolve({
					content: [{
						type: "text",
						text: `宿主在 ${timeoutMs / 1e3}s 内未返回工具结果（toolUseId=${key}），本次工具调用已取消`
					}],
					isError: true
				});
			}, timeoutMs);
			this.parked.set(key, (payload) => {
				if (timer !== void 0) clearTimeout(timer);
				resolve(payload);
			});
		});
	}
	/**
	* File one host tool result against the call it answers.
	*
	* Resolves the handler already parked under that tool-use id, or buffers the
	* result for the handler that has not fired yet — which is the ordinary case
	* for a host tool that returns quickly.
	*
	* @param hostCallId - the host-facing call id from the tool-result message.
	* @param payload - the rendered result.
	* @returns the tool-use id the result was filed under, for the request
	*   boundary that settles the rest of the round.
	*/
	deliver(hostCallId, payload) {
		const key = this.hostCallIds.get(hostCallId) ?? hostCallId;
		this.hostCallIds.delete(hostCallId);
		this.hostVisible.delete(key);
		const resolve = this.parked.get(key);
		if (resolve !== void 0) {
			this.parked.delete(key);
			resolve(payload);
			return key;
		}
		this.buffered.set(key, payload);
		return key;
	}
	/**
	* Settle the pairing against one arriving host request.
	*
	* The host runs every tool of a round before it sends the request that
	* continues the conversation, and that request carries a result for every
	* call it answered. A call it did not answer there will never be answered,
	* so this boundary — not a wall clock — decides that a handler is stranded:
	*
	*  - a handler parked under an unanswered id is released now;
	*  - an announcement whose handler has not fired yet is marked abandoned, so
	*    that handler settles as soon as it does arrive;
	*  - a buffered result from an earlier round whose handler never arrived is
	*    dropped, because no later request can produce that handler.
	*
	* A fresh user turn is handled by the same rules: the results the request
	* still carries are delivered, and the calls it left unanswered are
	* superseded. It differs only in the cancellation text the model reads.
	*
	* `delivered` is what protects the fast-handler race: a result can arrive
	* before the CLI dispatches the MCP handler, and a runtime-context snapshot
	* can make the same request look like a new user turn. Keeping everything
	* this request answered, in both cases, is what lets that handler collect
	* the real result instead of a cancellation.
	*
	* @param delivered - tool-use ids the host just delivered a result for.
	* @param freshUserTurn - whether the request carries a new user message.
	*/
	beginHostRequest(delivered, freshUserTurn) {
		if (this.announced.length === 0 && this.parked.size === 0) this.abandoned.length = 0;
		for (const [key, resolve] of [...this.parked.entries()]) {
			if (delivered.has(key)) continue;
			this.parked.delete(key);
			resolve(freshUserTurn ? {
				content: [{
					type: "text",
					text: SUPERSEDED_CALL_TEXT
				}],
				isError: true
			} : unansweredCall(key));
		}
		const kept = this.announced.filter((id) => delivered.has(id));
		for (const id of this.announced) if (!delivered.has(id)) this.abandoned.push(id);
		this.announced.length = 0;
		this.announced.push(...kept);
		for (const key of [...this.buffered.keys()]) if (!delivered.has(key)) this.buffered.delete(key);
		this.hostCallIds.clear();
		this.hostVisible.clear();
	}
	/**
	* Release every parked handler: the host started a fresh user turn while their
	* calls were still outstanding, so those calls can never be answered.
	*/
	cancelParked() {
		const stale = [...this.parked.entries()];
		this.parked.clear();
		for (const [, resolve] of stale) resolve({
			content: [{
				type: "text",
				text: SUPERSEDED_CALL_TEXT
			}],
			isError: true
		});
	}
	/**
	* Drop announcements no handler can still claim, and release parked handlers.
	*
	* An aborted or failed turn is one where the CLI cancels its pending tool
	* dispatch, so an id it announced but never dispatched would otherwise shift
	* the pairing of the NEXT turn's handler by one slot and park it under a key
	* nothing resolves — reintroducing the very stall this class exists to fix.
	* A handler that was already dispatched still needs an answer, so parked
	* handlers settle here, and announcements move to the abandoned queue in case
	* their dispatch was already in flight when the turn died.
	*/
	forgetUnclaimed() {
		this.abandoned.push(...this.announced);
		this.announced.length = 0;
		this.cancelParked();
		this.buffered.clear();
		this.hostCallIds.clear();
		this.hostVisible.clear();
	}
	/** Drop all pairing state; the session is being torn down. */
	clear() {
		this.cancelParked();
		this.announced.length = 0;
		this.abandoned.length = 0;
		this.hostCallIds.clear();
		this.hostVisible.clear();
		this.buffered.clear();
	}
	/** How many handlers are waiting for a host result. */
	get parkedCount() {
		return this.parked.size;
	}
};
/**
* One warm inner session. All mutation happens on the consumer fiber except
* the documented turn lifecycle driven by {@link stream}.
*/
var QoderSession = class {
	sessionId;
	channel = createChannel();
	/**
	* Lazy: the MCP SDK refuses tool registration after the transport connects,
	* so the inner process only spawns once {@link ensureTools} has registered
	* the host tools (the adapter does that immediately before each stream).
	*/
	q = null;
	/**
	* Tool-result pairing state. Owned by the session rather than the turn,
	* because a handler can fire after its turn has ended — see
	* {@link ToolResultPairing} for the measurement that proves it.
	*/
	pairing = new ToolResultPairing();
	mcp = createSdkMcpServer({
		name: MCP_SERVER_NAME,
		tools: []
	});
	registered = /* @__PURE__ */ new Map();
	queue = null;
	model;
	reasoningEffort;
	callCounter = 0;
	/**
	* Per-instance suffix for emitted host call ids. Ids must stay unique across
	* the whole host session log: a history divergence rebuilds this class, LRU
	* eviction recreates it, and the harness keys tool-call blocks by id, so a
	* fresh `qoder-1` would collide with the one its predecessor already stored.
	*/
	callNonce = randomUUID().slice(0, 8);
	abortPending = false;
	disposed = false;
	/**
	* How the active turn ended, so its cleanup can tell a completed turn (whose
	* unclaimed announcements may still belong to a handler about to fire) from an
	* aborted or failed one (where the CLI cancelled that dispatch).
	*/
	turnEndKind = void 0;
	/** Previous request's messages for delta feeding. */
	fedMessages;
	fedSystem;
	/** This turn's fed characters, reset per turn for per-call token accounting. */
	turnInputChars = 0;
	/** Host system prompt captured before spawn for the boot-time systemPrompt. */
	hostSystem;
	/** Host session workspace; qodercli runs there so its preset reports the session cwd. */
	sessionCwd;
	blockIndex = 0;
	textBlock;
	reasoningBlock;
	openTool;
	toolCalls = [];
	/**
	* This turn's generated output, priced by script.
	*
	* Counts visible text, reasoning, and tool-call names and arguments — see
	* {@link TurnOutputAccounting} for why the last one matters.
	*/
	output = new TurnOutputAccounting();
	/**
	* Metering of the last provider request that finished in the active turn.
	*
	* Never the `result` frame's usage, which totals the whole inner turn across
	* every request it made — see {@link requestUsageSample}.
	*/
	lastUsage;
	/**
	* The active turn's feed as plain text, when that feed carries image bytes.
	* Kept so a CLI that refuses to decode those bytes can be retried without
	* them instead of failing the turn. Cleared with the turn.
	*/
	feedFallback;
	/**
	* Session-level input token estimate for the CURRENT request, priced by
	* script mix over the rendered conversation the inner session actually
	* receives. It is the last-resort tier of {@link usage}: a turn whose frames
	* carry no metering at all would otherwise read ~0% on the context meter and
	* never trigger auto-compaction, and the CLI's own context ratio is preferred
	* over this whenever the turn reported one.
	*/
	estimatedInputTokens;
	/**
	* The window this route publishes, i.e. the denominator the harness meter
	* divides by. The CLI's context ratio is turned into tokens against this same
	* number, so the meter and the ratio always describe one window.
	*/
	contextWindow;
	/**
	* The window the CLI will actually run with, when that is known to differ
	* from {@link contextWindow} because the model does not advertise the
	* declared one. This is the denominator the CLI itself measures its context
	* ratio against, so it is what the ratio must be multiplied by.
	*/
	cliContextWindow;
	/** Per-session runtime knobs, resolved from the plugin config at creation. */
	toolResultTimeoutMs;
	abortGraceMs;
	/** Which edition's CLI (and SDK) this session runs on. */
	brand;
	constructor(sessionId, initialModel, runtime = {}) {
		this.sessionId = sessionId;
		this.model = initialModel;
		this.toolResultTimeoutMs = readLive(runtime.toolResultTimeoutMs, DEFAULT_TOOL_RESULT_TIMEOUT_MS);
		this.abortGraceMs = readLive(runtime.abortGraceMs, DEFAULT_ABORT_GRACE_MS);
		this.brand = runtime.brand ?? "cn";
	}
	/** Spawn the inner process (first stream only) and attach the consumer. */
	async ensureStarted() {
		if (this.q !== null) return this.q;
		if (foreignCliOverride(this.brand) !== void 0) throw new Error(cliConflictMessage(this.brand));
		const q = (await loadSdk(this.brand)).query({
			prompt: this.channel,
			options: {
				...qoderCliOptions(this.brand),
				auth: qodercliAuth(),
				tools: [],
				allowedTools: [],
				canUseTool: this.canUseTool,
				settingSources: [],
				includePartialMessages: true,
				resolveModel: () => ({
					model: this.model,
					...this.reasoningEffort === void 0 && this.contextWindow === void 0 ? {} : { parameters: {
						...this.reasoningEffort === void 0 ? {} : { reasoningEffort: this.reasoningEffort },
						...this.contextWindow === void 0 ? {} : { contextWindow: this.contextWindow }
					} }
				}),
				mcpServers: { [MCP_SERVER_NAME]: this.mcp },
				allowedMcpServerNames: [MCP_SERVER_NAME],
				...this.hostSystem === void 0 ? {} : { systemPrompt: this.hostSystem },
				...this.sessionCwd === void 0 ? {} : { cwd: this.sessionCwd }
			}
		});
		this.q = q;
		this.consume(q);
		return q;
	}
	/** Point the session at a model and its per-request policy. */
	setModel(model, policy) {
		this.model = model;
		this.reasoningEffort = policy?.reasoningEffort;
		this.contextWindow = policy?.contextWindow;
		this.cliContextWindow = policy?.cliContextWindow;
	}
	/** Record the host system prompt; effective only before the process spawns. */
	setSystem(system) {
		this.hostSystem = system;
	}
	/**
	* Record the host session workspace; effective only before the process
	* spawns. qodercli inherits the host process cwd otherwise, which would
	* make its preset report the server's launch directory instead of the
	* session's workspace.
	*/
	setCwd(cwd) {
		this.sessionCwd = cwd;
	}
	/**
	* Permission gate for the inner process. Native tools are denied; MCP host
	* tools are allowed, and each allowed call's qodercli tool-use id is recorded
	* so the matching MCP handler can park under the exact id (qodercli asks once
	* per call, in execution order, before dispatching the MCP message).
	*/
	canUseTool = (toolName, _input, options) => {
		if (toolName.startsWith(MCP_TOOL_PREFIX)) {
			if (options.toolUseID !== void 0) this.pairing.announce(options.toolUseID);
			return Promise.resolve({
				behavior: "allow",
				...options.toolUseID === void 0 ? {} : { toolUseID: options.toolUseID }
			});
		}
		return Promise.resolve({
			behavior: "deny",
			message: "本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。",
			...options.toolUseID === void 0 ? {} : { toolUseID: options.toolUseID }
		});
	};
	/** Register any host tools whose schema this session's MCP server lacks. */
	ensureTools(tools) {
		for (const schema of tools) {
			const hash = JSON.stringify(schema.parameters ?? {});
			if (this.registered.get(schema.name) === hash) continue;
			const shape = jsonSchemaToShape(schema.parameters ?? {});
			try {
				this.mcp.instance.registerTool(schema.name, {
					description: schema.description.length > 0 ? schema.description : schema.name,
					inputSchema: shape
				}, async (args) => {
					const result = await this.pairing.claim(this.toolResultTimeoutMs);
					return {
						content: result.content,
						...result.isError ? { isError: true } : {}
					};
				});
			} catch {
				continue;
			}
			this.registered.set(schema.name, hash);
		}
	}
	/**
	* Deliver host tool results to parked or buffered handlers, keyed by call id,
	* and settle the previous round at this request boundary.
	* @param tail - the host messages appended since the previous request.
	* @param images - adapter-resolved request images keyed by attachment id; an
	*   id missing from the map degrades to handle text.
	*/
	deliverToolResults(tail, images) {
		let freshUserTurn = false;
		const delivered = /* @__PURE__ */ new Set();
		for (const message of tail) {
			if (message.role === "user") {
				freshUserTurn = true;
				continue;
			}
			if (message.role !== "tool") continue;
			delivered.add(this.pairing.deliver(String(message.toolCallId), {
				content: renderResultContent(message.content, images),
				isError: message.isError === true
			}));
		}
		this.pairing.beginHostRequest(delivered, freshUserTurn);
	}
	/**
	* Run one inner turn: feed (if any) then pump consumer chunks until finish.
	* @param options - the host request (signal; tools already registered).
	* @param feed - literal text, resolved content blocks (a vision turn), or
	*   null for a pure tool-result continuation.
	* @param fallback - the same feed rendered as text. Used only if the inner
	*   CLI refuses the turn's image bytes, in which case the turn is resent
	*   without them rather than failing (see {@link retryWithoutImages}).
	*/
	async *stream(options, feed, fallback) {
		if (this.queue !== null) throw new LlmError(`qoder session ${this.sessionId} already has a turn in flight`, "CONFLICT");
		if (this.disposed) throw new LlmError(`qoder session ${this.sessionId} was disposed`, "TRANSPORT");
		const q = await this.ensureStarted();
		this.queue = new TurnQueue();
		this.resetTurnState();
		if (feed !== null) {
			const content = typeof feed === "string" ? [{
				type: "text",
				text: feed
			}] : [...feed];
			this.feedFallback = fallback !== void 0 && content.some((block) => block.type === "image") ? fallback : void 0;
			this.turnInputChars += contentChars(content);
			this.channel.push({
				type: "user",
				message: {
					role: "user",
					content
				},
				parent_tool_use_id: null
			});
		}
		const signal = options.signal;
		let abortTimer;
		const onAbort = () => {
			this.abortPending = true;
			q.interrupt().catch(() => void 0);
			abortTimer = setTimeout(() => this.endTurn({
				kind: "aborted",
				failure: {
					message: "qoder session aborted by host",
					code: "ABORTED"
				}
			}), this.abortGraceMs);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			for await (const item of this.queue) {
				if (item.kind === "chunk") {
					yield item.chunk;
					continue;
				}
				if (item.usage !== void 0) yield {
					type: "usage",
					usage: this.usage()
				};
				yield {
					type: "finish",
					reason: item.reason
				};
				return;
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (abortTimer !== void 0) clearTimeout(abortTimer);
			if (this.turnEndKind === "aborted" || this.turnEndKind === "error") this.pairing.forgetUnclaimed();
			this.queue = null;
			this.abortPending = false;
			this.feedFallback = void 0;
		}
	}
	/**
	* Resend the current turn without its images after the CLI refused them.
	*
	* The inner CLI decodes every image before the model sees the turn, and a
	* decode it cannot do fails that whole turn — the host would surface an error
	* for a question whose only problem was the pixels. The failed turn never
	* reached the model, so the same turn goes out again with the images replaced
	* by the harness's own handle text, the same text a text-only route renders,
	* and the user still gets an answer.
	*
	* @param detail - the failed result frame's subtype and errors.
	* @returns whether a retry was started, in which case the turn must not be
	*   ended: the retry's own result frame settles it.
	*/
	retryWithoutImages(detail) {
		const fallback = this.feedFallback;
		if (fallback === void 0 || !isImageAttachFailure(detail)) return false;
		if (this.textBlock !== void 0 || this.reasoningBlock !== void 0 || this.toolCalls.length > 0 || this.output.outputChars > 0) return false;
		this.feedFallback = void 0;
		this.resetTurnState();
		this.turnInputChars += fallback.length;
		this.channel.push({
			type: "user",
			message: {
				role: "user",
				content: [{
					type: "text",
					text: fallback
				}]
			},
			parent_tool_use_id: null
		});
		return true;
	}
	/** Tear the inner process down; parked calls die with it. */
	close() {
		if (this.disposed) return;
		this.disposed = true;
		this.pairing.clear();
		if (this.q !== null) this.q.close().catch(() => void 0);
	}
	/**
	* Reset the per-turn assembly state.
	*
	* Pairing state is deliberately NOT touched here. It looks turn-scoped, but a
	* `tools/call` handler can fire only after the turn that announced it has
	* already ended — the host answers a tool call the moment it sees the block,
	* and the CLI dispatches the MCP message some milliseconds later. Clearing
	* announcements at this boundary made that handler claim nothing, park under a
	* fallback key, and wait out the whole tool-result timeout; see
	* {@link ToolResultPairing}. {@link QoderSession.close} drops it with the
	* session, and an aborted turn drops what it can no longer claim.
	*/
	resetTurnState() {
		this.blockIndex = 0;
		this.textBlock = void 0;
		this.reasoningBlock = void 0;
		this.openTool = void 0;
		this.toolCalls = [];
		this.turnInputChars = 0;
		this.output.reset();
		this.lastUsage = void 0;
		this.turnEndKind = void 0;
	}
	emit(chunk) {
		this.queue?.push({
			kind: "chunk",
			chunk
		});
	}
	/** Count generated text toward this turn's output tokens. */
	countOutput(text) {
		this.output.addOutput(text);
	}
	/**
	* Price this turn's generated text, by script rather than at a flat rate.
	*
	* {@link TurnOutputAccounting} owns the counters and the harness invariant
	* that `reasoningTokens` is a subset of `outputTokens` — the harness discards
	* a whole reading when it is not.
	*/
	outputUsage() {
		return this.output.usage();
	}
	usage() {
		const metered = meteredUsage(this.lastUsage, (output) => this.output.reasoningTokensWithin(output));
		if (metered !== void 0) return metered;
		const ratioWindow = this.cliContextWindow ?? this.contextWindow;
		const ratio = this.lastUsage?.context_usage_ratio;
		if (typeof ratio === "number" && ratio > 0 && typeof ratioWindow === "number" && ratioWindow > 0) return this.estimatedUsage(Math.min(ratioWindow, Math.max(1, Math.ceil(ratio * ratioWindow))));
		if (this.estimatedInputTokens !== void 0 && this.estimatedInputTokens > 0) return this.estimatedUsage(this.estimatedInputTokens);
		return this.estimatedUsage(Math.max(1, Math.ceil(this.turnInputChars / 4)));
	}
	/**
	* One estimated turn reading, shaped exactly like a metered one.
	*
	* The cache buckets are present and zero rather than omitted: this estimate
	* prices the prompt as a single uncached block, and a missing bucket would
	* make the harness withhold the turn's usage disclosure entirely.
	*
	* @param inputTokens - the estimated prompt size, uncached by definition.
	* @returns the harness usage for the turn.
	*/
	estimatedUsage(inputTokens) {
		const output = this.outputUsage();
		return {
			inputTokens,
			...output,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: inputTokens + output.outputTokens
		};
	}
	/**
	* Record the input-token estimate for the CURRENT request, priced by script
	* mix over the rendered conversation (system + messages) the inner session
	* receives. This is the fallback {@link usage} reaches for only when a turn
	* reported no metering and no context ratio — without it such a turn would
	* read ~0% on the context meter and never trigger auto-compaction.
	* @param system - the host system prompt included in this request.
	* @param messages - the full host message list included in this request.
	*/
	recordRequestInput(system, messages) {
		const rendered = renderInitialFeed(system, messages);
		const imageTokens = feedImageRefs(rendered).reduce((total, ref) => total + estimateImageTokens(ref.width, ref.height), 0);
		this.estimatedInputTokens = Math.max(1, Math.ceil(estimateTextTokens(feedTextLength(rendered), feedWideCharCount(rendered))) + imageTokens);
	}
	endTurn(reason, usage) {
		if (this.queue === null) return;
		this.turnEndKind = reason.kind;
		if (this.textBlock !== void 0) this.emit({
			type: "block-end",
			index: this.textBlock.index,
			block: {
				type: "text",
				text: this.textBlock.text
			}
		});
		if (this.reasoningBlock !== void 0) this.emit({
			type: "block-end",
			index: this.reasoningBlock.index,
			block: {
				type: "reasoning",
				text: this.reasoningBlock.text
			}
		});
		this.queue.push({
			kind: "turn-end",
			reason,
			usage: usage ?? this.usage()
		});
		this.queue.close();
	}
	async consume(q) {
		try {
			const iterator = q[Symbol.asyncIterator]();
			while (true) {
				const next = await iterator.next();
				if (next.done) break;
				try {
					this.handle(next.value);
				} catch (error) {
					this.endTurn({
						kind: "error",
						failure: {
							message: `qoder session consumer failed: ${String(error)}`,
							code: "BACKEND_ERROR"
						}
					});
				}
			}
			this.endTurn({
				kind: "error",
				failure: {
					message: "qoder session stream ended unexpectedly",
					code: "STREAM_CLOSED"
				}
			});
		} catch (error) {
			this.endTurn({
				kind: "error",
				failure: {
					message: `qoder session died: ${String(error)}`,
					code: "TRANSPORT"
				}
			});
		}
	}
	handle(message) {
		if (message.type === "stream_event") {
			const event = message.event;
			if (event === void 0) return;
			const sample = requestUsageSample(message);
			if (sample !== void 0) this.lastUsage = sample;
			switch (event.type) {
				case "content_block_start": {
					const block = event.content_block;
					if (block?.type === "tool_use") {
						if (this.queue === null || this.queue.isClosed) break;
						const callId = `qoder-${this.callNonce}-${++this.callCounter}`;
						if (typeof block.id === "string" && block.id.length > 0) this.pairing.mapHostCall(callId, block.id);
						const chunkIndex = this.blockIndex++;
						const initialArguments = block.input !== void 0 && block.input !== null && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : "";
						this.openTool = {
							chunkIndex,
							callId,
							name: hostToolName(block.name ?? ""),
							arguments: initialArguments
						};
						this.countOutput(this.openTool.name);
						this.countOutput(initialArguments);
						this.emit({
							type: "block-start",
							index: chunkIndex,
							blockType: "tool-call"
						});
						this.emit({
							type: "tool-call-delta",
							index: chunkIndex,
							id: ToolCallId(callId),
							name: this.openTool.name,
							argumentsDelta: ""
						});
					}
					break;
				}
				case "content_block_delta": {
					const delta = event.delta;
					if (delta === void 0) return;
					if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
						if (this.textBlock === void 0) {
							this.textBlock = {
								index: this.blockIndex++,
								text: ""
							};
							this.emit({
								type: "block-start",
								index: this.textBlock.index,
								blockType: "text"
							});
						}
						this.textBlock.text += delta.text;
						this.countOutput(delta.text);
						this.emit({
							type: "text-delta",
							index: this.textBlock.index,
							text: delta.text
						});
					} else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
						if (this.reasoningBlock === void 0) {
							this.reasoningBlock = {
								index: this.blockIndex++,
								text: ""
							};
							this.emit({
								type: "block-start",
								index: this.reasoningBlock.index,
								blockType: "reasoning"
							});
						}
						this.reasoningBlock.text += delta.thinking;
						this.output.addReasoning(delta.thinking);
						this.emit({
							type: "reasoning-delta",
							index: this.reasoningBlock.index,
							text: delta.thinking
						});
					} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && this.openTool !== void 0) {
						this.openTool.arguments += delta.partial_json;
						this.countOutput(delta.partial_json);
						this.emit({
							type: "tool-call-delta",
							index: this.openTool.chunkIndex,
							id: ToolCallId(this.openTool.callId),
							argumentsDelta: delta.partial_json
						});
					}
					break;
				}
				case "content_block_stop":
					if (this.openTool !== void 0) {
						this.emit({
							type: "block-end",
							index: this.openTool.chunkIndex,
							block: {
								type: "tool-call",
								id: ToolCallId(this.openTool.callId),
								name: this.openTool.name,
								arguments: this.openTool.arguments
							}
						});
						this.toolCalls.push(this.openTool);
						this.openTool = void 0;
					}
					break;
				case "message_stop": if (this.toolCalls.length > 0) this.endTurn({ kind: "tool-calls" });
			}
			return;
		}
		if (message.type === "assistant") {
			if (this.textBlock === void 0 && this.toolCalls.length === 0) {
				const content = message.message?.content ?? [];
				for (const block of content) {
					if (block.type !== "tool_use") continue;
					this.countOutput(block.name ?? "");
					this.countOutput(JSON.stringify(block.input ?? ""));
				}
				const text = content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
				if (text.length > 0) {
					this.textBlock = {
						index: this.blockIndex++,
						text
					};
					this.countOutput(text);
					this.emit({
						type: "block-start",
						index: this.textBlock.index,
						blockType: "text"
					});
					this.emit({
						type: "text-delta",
						index: this.textBlock.index,
						text
					});
				}
			}
			return;
		}
		if (message.type === "result") {
			if (this.abortPending) {
				this.endTurn({
					kind: "aborted",
					failure: {
						message: "qoder turn aborted by host",
						code: "ABORTED"
					}
				});
				return;
			}
			if (this.toolCalls.length > 0) {
				this.endTurn({ kind: "tool-calls" });
				return;
			}
			if (message.subtype === "success" || message.subtype === void 0) {
				if (this.textBlock === void 0 && this.reasoningBlock === void 0) this.endTurn({
					kind: "error",
					failure: {
						message: "qoder model returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				});
				else this.endTurn({ kind: "stop" });
				return;
			}
			const detail = `${message.subtype} ${safeErrors(message.errors)}`;
			if (this.retryWithoutImages(detail)) return;
			this.endTurn({
				kind: "error",
				failure: {
					message: `qoder turn failed: ${detail}`,
					code: classifyTurnError(detail)
				}
			});
		}
	}
};
/**
* Render tool-result content blocks into the MCP content the inner model
* reads: text passes through, an image resolves from {@link images} into the
* MCP image shape or degrades to the harness's own handle text, and anything
* else is serialized.
*/
function renderResultContent(blocks, images) {
	const content = [];
	for (const block of blocks) if (block.type === "text") content.push({
		type: "text",
		text: block.text
	});
	else if (block.type === "image") {
		const resolved = images?.get(String(block.attachment.attachmentId));
		if (resolved !== void 0) content.push({
			type: "image",
			data: resolved.data,
			mimeType: resolved.mediaType
		});
		else content.push({
			type: "text",
			text: textOnlyImageText(block.attachment)
		});
	} else content.push({
		type: "text",
		text: JSON.stringify(block)
	});
	return content;
}
/**
* Vision tokens for one image, estimated with the tile formula the
* Claude-compatible wire shape this backend follows uses (width x height / 750).
* The inner CLI reports no usage for the pixels it consumed, so this estimate is
* the only image occupancy the harness context meter and compaction threshold
* can see. It is an estimate, not a provider metering figure.
*/
function estimateImageTokens(width, height) {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
	return Math.max(1, Math.ceil(width * height / 750));
}
/** Literal characters one channel content list contributes to the fallback estimate. */
function contentChars(content) {
	return content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
}
/** Safely stringify the SDK error payload for turn diagnostics. */
function safeErrors(errors) {
	if (errors === void 0) return "";
	if (typeof errors === "string") return errors;
	try {
		return JSON.stringify(errors);
	} catch {
		return String(errors);
	}
}
/**
* Classify an inner result-frame failure into a harness-routable code. The
* qoder backend reports context-window and quota rejections as generic
* per-turn errors, so their message text must be recognized through the shared
* dsh-llm classifiers; only then does the harness overflow recovery (or quota
* surfacing) fire instead of a dead-end BACKEND_TURN_ERROR.
*/
function classifyTurnError(detail) {
	if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
	if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
	return "BACKEND_TURN_ERROR";
}
/**
* Whether a failed turn is the CLI refusing an image it could not decode.
*
* qodercli decodes every attached image before the model sees the turn, and
* reports such a failure with a fixed set of phrasings: the sentence it shows
* the user, its terminal reason, and the error code underneath. The turn itself
* is fine — only the pixels are not, which is what makes it safe to resend.
*
* @param detail - the failed result frame's subtype and errors.
*/
function isImageAttachFailure(detail) {
	return /image_processing_failed|unable to attach image|invalid or unsupported image data/i.test(detail);
}
/**
* Warm-session registry with insertion-order LRU eviction, plus the cold
* one-shot path for side-channel requests (titles, compaction).
*/
var QoderSessionManager = class {
	maxSessions;
	runtime;
	sessions = /* @__PURE__ */ new Map();
	/**
	* @param maxSessions - warm-session cap; read per eviction so a settings edit
	*   applies to the next session that overflows the pool.
	* @param runtime - per-session knobs, resolved when each session is created.
	*/
	constructor(maxSessions = 8, runtime = {}) {
		this.maxSessions = maxSessions;
		this.runtime = runtime;
	}
	/** Existing or fresh warm session for one host session id. */
	forSession(sessionId, model) {
		const existing = this.sessions.get(sessionId);
		if (existing !== void 0) {
			this.sessions.delete(sessionId);
			this.sessions.set(sessionId, existing);
			return existing;
		}
		const session = new QoderSession(sessionId, model, this.runtime);
		this.sessions.set(sessionId, session);
		const cap = readLive(this.maxSessions, 8);
		while (this.sessions.size > cap) {
			const oldest = this.sessions.keys().next();
			if (oldest.done === true) break;
			const victim = this.sessions.get(oldest.value);
			this.sessions.delete(oldest.value);
			victim?.close();
		}
		return session;
	}
	/** Drop one session (history diverged); the next request rebuilds it cold. */
	dispose(sessionId) {
		const session = this.sessions.get(sessionId);
		if (session === void 0) return;
		this.sessions.delete(sessionId);
		session.close();
	}
	closeAll() {
		for (const session of this.sessions.values()) session.close();
		this.sessions.clear();
	}
	/** One-shot turn with no warm state: side channels and cold rebuilds. */
	async *coldStream(options, prompt, model) {
		const systemPrompt = options.system;
		const brand = this.runtime.brand ?? "cn";
		if (foreignCliOverride(brand) !== void 0) throw new Error(cliConflictMessage(brand));
		const q = (await loadSdk(brand)).query({
			prompt,
			options: {
				...qoderCliOptions(brand),
				auth: qodercliAuth(),
				tools: [],
				allowedTools: [],
				canUseTool: gateTools,
				settingSources: [],
				maxTurns: readLive(this.runtime.coldMaxTurns, DEFAULT_COLD_MAX_TURNS),
				...systemPrompt === void 0 ? {} : { systemPrompt },
				...model === void 0 ? {} : { model }
			}
		});
		const signal = options.signal;
		const onAbort = () => {
			q.interrupt().catch(() => void 0);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			let text = "";
			let failure;
			try {
				for await (const message of q) {
					const msg = message;
					if (msg.type === "assistant") {
						const chunk = (msg.message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
						if (chunk.length > 0) text += chunk;
					} else if (msg.type === "result" && msg.subtype !== "success" && msg.subtype !== void 0) {
						const detail = `${msg.subtype} ${safeErrors(msg.errors)}`;
						failure = {
							message: `qoder side-channel turn failed: ${detail}`,
							code: classifyTurnError(detail)
						};
					}
				}
			} catch (error) {
				if (signal?.aborted !== true) throw error;
			}
			if (signal?.aborted === true) {
				yield {
					type: "finish",
					reason: {
						kind: "aborted",
						failure: {
							message: "aborted by host",
							code: "ABORTED"
						}
					}
				};
				return;
			}
			if (failure !== void 0) {
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure
					}
				};
				return;
			}
			if (text.length === 0) {
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							message: "qoder side-channel returned no content",
							code: EMPTY_RESPONSE_CODE
						}
					}
				};
				return;
			}
			yield {
				type: "block-start",
				index: 0,
				blockType: "text"
			};
			for (let i = 0; i < text.length; i += 192) yield {
				type: "text-delta",
				index: 0,
				text: text.slice(i, i + 192)
			};
			yield {
				type: "block-end",
				index: 0,
				block: {
					type: "text",
					text
				}
			};
			yield {
				type: "usage",
				usage: {
					inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
					outputTokens: Math.max(1, Math.ceil(text.length / 4))
				}
			};
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
		} finally {
			signal?.removeEventListener("abort", onAbort);
			await q.close().catch(() => void 0);
		}
	}
};
//#endregion
//#region src/usage.ts
/** How long one quota reading stays fresh by default. */
const DEFAULT_USAGE_CACHE_TTL_MS = 6e4;
/** Upper bound on one quota round trip. */
const DEFAULT_USAGE_TIMEOUT_MS = 2e4;
/** Streaming prompt that never yields, so no model turn runs during the read. */
async function* inertInput() {
	await new Promise(() => {});
}
/** Cached quota reader for one brand. */
var QoderUsage = class {
	brand;
	ttlMs;
	timeoutMs;
	cached;
	inflight;
	/**
	* @param brand - which edition's CLI answers.
	* @param ttlMs - how long a reading stays fresh; read per use.
	* @param timeoutMs - how long one round trip may take.
	*/
	constructor(brand, ttlMs = DEFAULT_USAGE_CACHE_TTL_MS, timeoutMs = DEFAULT_USAGE_TIMEOUT_MS) {
		this.brand = brand;
		this.ttlMs = ttlMs;
		this.timeoutMs = timeoutMs;
	}
	/**
	* Read the quota, or serve the cached reading while it is still fresh.
	*
	* @param fresh - ignore the cache; the page's refresh button.
	* @returns the reading; `error` carries a failed lookup instead of throwing.
	*/
	async read(fresh = false) {
		const ttlMs = readLive(this.ttlMs, DEFAULT_USAGE_CACHE_TTL_MS);
		if (!fresh && this.cached !== void 0 && Date.now() - this.cached.at < ttlMs) return this.cached;
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = void 0;
		});
		const snapshot = await this.inflight;
		this.cached = snapshot;
		return snapshot;
	}
	/** Drop the cached reading. */
	invalidate() {
		this.cached = void 0;
	}
	async fetch() {
		const at = Date.now();
		try {
			if (foreignCliOverride(this.brand) !== void 0) return {
				at,
				error: cliConflictMessage(this.brand)
			};
			const sdk = await loadSdk(this.brand);
			const timeoutMs = readLive(this.timeoutMs, DEFAULT_USAGE_TIMEOUT_MS);
			const q = sdk.query({
				prompt: inertInput(),
				options: {
					...qoderCliOptions(this.brand),
					auth: sdk.qodercliAuth(),
					tools: [],
					allowedTools: [],
					settingSources: [],
					maxTurns: 1
				}
			});
			try {
				const usage = await withTimeout(q.getUsageInfo(), timeoutMs);
				const account = await withTimeout(q.accountInfo(), timeoutMs).catch(() => void 0);
				return {
					at,
					...usage === null || usage === void 0 ? { error: "CLI 未返回额度信息" } : { usage },
					...account === void 0 ? {} : { account }
				};
			} finally {
				await q.close().catch(() => void 0);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const command = brandProfile(this.brand).cliCommands[0];
			return {
				at,
				error: /ENOENT|not found|Cannot find package|未安装国际版 SDK/i.test(detail) ? `未检测到可用的 ${command}，请先安装并登录后再读取额度。` : detail
			};
		}
	}
};
//#endregion
//#region src/adapter.ts
/**
* `QoderAdapter`: route the harness LLM seam onto a local Qoder CLI account
* through the qoder-agent-sdk. One warm inner session per host session id
* carries the conversation (model turns and tool rounds live inside it); host
* tool schemas are exposed to the inner model through an in-process MCP
* server whose handlers park until the host delivers tool results on the next
* request. Side-channel requests (titles, compaction) run cold one-shots.
* @module dsh-llm-qoder/adapter
*/
/** Shared empty values, so an unset list or map allocates nothing per read. */
const NO_MODELS = [];
const NO_WINDOWS = {};
const NO_ALIASES = {};
/** The primary provider route (the CN account's own models). */
const QODER_PROVIDER = "qoder-cn";
/** The international edition's route; a second adapter instance serves it. */
const QODER_INTL_PROVIDER = "qoder-intl";
/**
* Decide the context window to report for one live model.
*
* A per-model override wins when the user chose one; otherwise upstream's own
* `defaultContextWindow` is used, which is the window that model's session
* actually runs with. `maxInputTokens` is NOT a substitute — it is the ceiling
* for a single request and is often lower than the session window (e.g. 180 000
* against a 200 000 session), so falling back to it would understate capacity.
*
* @param live - the live catalog entry, when the CLI answered.
* @param override - the user's chosen window for this model, if any.
* @param fallback - window used when the catalog has nothing for this model.
* @returns the window in tokens.
*/
function pickContextWindow(live, override, fallback) {
	if (override !== void 0 && Number.isFinite(override) && override > 0) return override;
	if (live === void 0) return fallback;
	return live.defaultContextWindow ?? largestWindow(live.availableContextWindows) ?? live.maxInputTokens ?? fallback;
}
/** The largest window in a catalog entry's selectable list, or undefined. */
function largestWindow(available) {
	if (available === void 0 || available.length === 0) return void 0;
	return Math.max(...available);
}
/**
* The window the CLI will actually run this route with.
*
* Not the same thing as the window the harness is told about. A deployment may
* declare any window it likes — `modelContextWindows` accepts arbitrary numbers
* — but the CLI only honours one the model advertises in
* `availableContextWindows`; anything else it silently ignores and keeps its own
* default. Since the CLI measures `context_usage_ratio` against the window it is
* really using, this is the only correct multiplier for that ratio: using the
* declared window instead inflates every reading by
* `declared / actually-honoured` (5x for a 1M override on a 200K-only model).
*
* @param live - the live catalog entry, when the CLI answered.
* @param declared - the window this route publishes to the harness.
* @returns the window the CLI runs with, or undefined when unknown.
*/
function cliContextWindow(live, declared) {
	if (live === void 0) return void 0;
	const available = live.availableContextWindows;
	if (available !== void 0 && available.includes(declared)) return declared;
	return live.defaultContextWindow ?? largestWindow(available) ?? live.maxInputTokens;
}
function modelInfo(provider, entry) {
	return {
		provider,
		id: entry.id,
		name: entry.name,
		...entry.description === void 0 ? {} : { description: entry.description },
		inputModalities: entry.isVl === true ? ["text", "image"] : ["text"]
	};
}
/**
* Default selectable reasoning efforts for a Qoder model. The CLI catalog
* reports per-model `efforts`; this is the fallback when a model (or the
* static catalog) discloses none.
*/
const DEFAULT_REASONING_EFFORTS = [
	"low",
	"medium",
	"high",
	"max"
];
/** Human display name for the default effort ids. */
const EFFORT_NAMES = {
	low: "Low",
	medium: "Medium",
	high: "High",
	max: "Max"
};
/**
* Build the `reasoning` metadata block for a resolved model, or undefined
* when the model does not support reasoning.
* @param efforts - CLI-reported effort ids (absent for reasoning-less models).
* @param defaultEffort - CLI-reported default effort id.
* @param isReasoning - whether the model supports reasoning per the CLI.
* @returns the harness reasoning metadata, or undefined to omit it.
*/
function reasoningInfo(efforts, defaultEffort, isReasoning) {
	if (efforts === void 0 && isReasoning === false) return void 0;
	const ids = efforts !== void 0 && efforts.length > 0 ? efforts : DEFAULT_REASONING_EFFORTS;
	return {
		efforts: ids.map((id) => ({
			id: ReasoningEffortId(id),
			name: EFFORT_NAMES[id] ?? id
		})),
		...defaultEffort !== void 0 && ids.includes(defaultEffort) ? { defaultEffort: ReasoningEffortId(defaultEffort) } : {}
	};
}
/**
* The Qoder-backed adapter. Session continuity, tool parking, and feed
* planning live here; chunk synthesis lives in the session's consumer.
*/
var QoderAdapter = class extends LlmAdapter {
	/**
	* The options as given, read where they are used rather than copied here.
	*
	* A `.volatile()` field is a live cell DSH updates in place, and such an edit
	* does not restart the plugin, so a value captured in the constructor would
	* stay frozen for the lifetime of the process (see `src/live.ts`).
	*/
	options;
	sessions;
	catalog;
	usage;
	readImage;
	brand;
	/**
	* Memoized `Set` view of the disabled-model list.
	*
	* `updateVolatile` stores the freshly parsed array, so identity changes only
	* when the value does: caching on that identity keeps the per-model lookup a
	* hash probe instead of rebuilding a set per call, with no staleness.
	*/
	disabledCache;
	constructor(options = {}) {
		super();
		this.options = options;
		this.brand = options.brand ?? "cn";
		this.sessions = new QoderSessionManager(options.maxSessions ?? 8, {
			toolResultTimeoutMs: options.toolResultTimeoutMs,
			abortGraceMs: options.abortGraceMs,
			coldMaxTurns: options.coldMaxTurns,
			brand: this.brand
		});
		this.catalog = new QoderModelCatalog(this.brand, options.modelCacheTtlMs ?? 3e5, options.catalogFetchTimeoutMs ?? 2e4);
		this.usage = new QoderUsage(this.brand, options.usageCacheTtlMs);
		this.readImage = options.readImage;
	}
	get defaultMaxTokens() {
		return readLive(this.options.defaultMaxTokens, DEFAULT_MAX_TOKENS);
	}
	get modelContextWindows() {
		return readLive(this.options.modelContextWindows, NO_WINDOWS);
	}
	get disabledModels() {
		const source = readLive(this.options.disabledModels, NO_MODELS);
		const cached = this.disabledCache;
		if (cached !== void 0 && cached.source === source) return cached.set;
		const set = new Set(source);
		this.disabledCache = {
			source,
			set
		};
		return set;
	}
	get modelAliases() {
		return readLive(this.options.modelAliases, NO_ALIASES);
	}
	get defaultReasoningEffort() {
		return readLiveOptional(this.options.defaultReasoningEffort);
	}
	get displayName() {
		return readLive(this.options.displayName, brandProfile(this.brand).defaultDisplayName);
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.displayName
		};
	}
	/**
	* Whether one catalog entry is enabled for the picker.
	*
	* Only the user's off-switch is consulted: a model the account adds later
	* appears enabled by default, which a stored allow-list could not do.
	*/
	isVisible(id) {
		return !this.disabledModels.has(id);
	}
	/**
	* The user's chosen window for one catalog id, honouring aliases.
	*
	* A window may be stored under either the Qoder id or a harness-side alias,
	* so both spellings are checked before giving up.
	*/
	windowOverride(id) {
		const direct = this.modelContextWindows[id];
		if (direct !== void 0) return direct;
		for (const [key, value] of Object.entries(this.modelContextWindows)) if (resolveQoderModelId(key, this.modelAliases) === id) return value;
	}
	/**
	* The live catalog as the page renders it.
	*
	* Unlike {@link listModels}, this is not filtered by the user's on/off
	* choices: the page must show a switched-off model in order to switch it
	* back on.
	*
	* @returns live catalog entries in upstream order.
	*/
	async describeCatalog() {
		return this.catalog.liveModels();
	}
	/** Forget the cached catalog; the next read asks the CLI again. */
	invalidateCatalog() {
		this.catalog.invalidate();
	}
	/** Why the last catalog refresh failed, for the settings page's guidance. */
	catalogError() {
		return this.catalog.error;
	}
	/**
	* Read the account's quota and usage, as the Qoder clients display it.
	*
	* @param fresh - ignore the cached reading.
	*/
	async usageInfo(fresh = false) {
		return this.usage.read(fresh);
	}
	/** Forget the cached quota reading; the next read asks the CLI again. */
	invalidateUsage() {
		this.usage.invalidate();
	}
	/** Whether the user switched one model off. */
	isModelDisabled(id) {
		return this.disabledModels.has(id);
	}
	/** The stored disabled-model set, as a list for rewriting the field. */
	disabledModelIds() {
		return [...this.disabledModels];
	}
	/** The user's window for one model, or undefined when following upstream. */
	contextWindowFor(id) {
		return this.windowOverride(id);
	}
	/** The stored per-model window map, for rewriting the field. */
	modelWindowChoices() {
		return this.modelContextWindows;
	}
	async listModels(provider) {
		return (await this.catalog.models()).filter((entry) => this.isVisible(entry.id)).map((entry) => modelInfo(provider, entry));
	}
	async resolveModel(provider, model, _signal) {
		const target = resolveQoderModelId(model, this.modelAliases);
		const live = (await this.catalog.liveModels()).find((entry) => entry.value === target);
		if (live !== void 0) {
			const reasoning = reasoningInfo(live.efforts, live.defaultEffort ?? this.defaultReasoningEffort, live.isReasoning);
			return {
				provider,
				id: model,
				name: live.displayName.length > 0 ? live.displayName : live.value,
				...live.description.length > 0 ? { description: live.description } : {},
				inputModalities: live.isVl === true ? ["text", "image"] : ["text"],
				context: { contextWindow: pickContextWindow(live, this.windowOverride(target), DEFAULT_CONTEXT_WINDOW) },
				defaultMaxTokens: live.maxOutputTokens ?? this.defaultMaxTokens,
				...reasoning === void 0 ? {} : { reasoning }
			};
		}
		const configured = brandProfile(this.brand).staticCatalog ? QODER_MODELS.find((entry) => entry.id === target) : void 0;
		const reasoning = reasoningInfo(void 0, this.defaultReasoningEffort, true);
		return Promise.resolve({
			...configured === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text"]
			} : {
				...modelInfo(provider, configured),
				id: model
			},
			context: { contextWindow: this.windowOverride(target) ?? 2e5 },
			defaultMaxTokens: this.defaultMaxTokens,
			...reasoning === void 0 ? {} : { reasoning }
		});
	}
	/**
	* Bind one resolution generation to its dispatch, as the seam requires of a
	* dynamic adapter: the live catalog and the CLI login can change between the
	* harness preparing a call and the inner session running it, and a turn must
	* not mix one generation's declared capabilities with another's endpoint.
	*/
	async prepareCall(provider, model, signal) {
		const generation = await this.capture(provider, model, signal);
		return {
			model: generation.info,
			stream: (options) => this.dispatch(options, generation)
		};
	}
	async *stream(options) {
		yield* this.dispatch(options, await this.capture(options.provider, options.model, options.signal));
	}
	/** Resolve the exact route once and derive the capability facts from it. */
	async capture(provider, model, signal) {
		const info = await this.resolveModel(provider, model, signal);
		const target = resolveQoderModelId(model, this.modelAliases);
		const live = (await this.catalog.liveModels()).find((entry) => entry.value === target);
		const declared = info.context?.contextWindow;
		return {
			info,
			vision: info.inputModalities?.includes("image") === true,
			cliContextWindow: declared === void 0 ? void 0 : cliContextWindow(live, declared)
		};
	}
	async *dispatch(options, generation) {
		const model = resolveQoderModelId(options.model, this.modelAliases);
		if (options.sessionId === void 0 || options.purpose !== void 0) {
			const prompt = feedToText(renderInitialFeed(options.system, options.messages)) + "\n（这是一次性旁路请求，直接输出下一条助手回复。）";
			yield* this.sessions.coldStream(options, prompt, model);
			return;
		}
		const sessionId = String(options.sessionId);
		const declaredWindow = generation.info.context?.contextWindow;
		const policy = {
			...options.reasoningEffort === void 0 ? {} : { reasoningEffort: options.reasoningEffort },
			...declaredWindow === void 0 ? {} : { contextWindow: declaredWindow },
			...generation.cliContextWindow === void 0 ? {} : { cliContextWindow: generation.cliContextWindow }
		};
		let session = this.sessions.forSession(sessionId, model);
		if (session.fedMessages === void 0) {
			yield* this.firstTurn(session, options, model, policy, generation.vision);
			return;
		}
		const tail = options.messages.slice(session.fedMessages.length);
		const images = await this.resolveTurnImages(tail, generation.vision, options.signal);
		session.deliverToolResults(tail, images);
		const plan = planContinuation(session.fedMessages, options.messages);
		if (plan.rebuild) {
			this.sessions.dispose(sessionId);
			session = this.sessions.forSession(sessionId, model);
			yield* this.firstTurn(session, options, model, policy, generation.vision);
			return;
		}
		session.setModel(model, policy);
		session.ensureTools(options.tools ?? []);
		session.recordRequestInput(options.system, options.messages);
		session.fedMessages = options.messages;
		session.fedSystem = options.system;
		const feed = plan.feed === null ? null : await this.buildFeed(plan.feed, generation.vision, images);
		yield* session.stream(options, feed, plan.feed === null ? void 0 : feedToText(plan.feed));
	}
	async *firstTurn(session, options, model, policy, vision) {
		session.setModel(model, policy);
		session.setSystem(options.system);
		const cwd = options.cwd;
		session.setCwd(cwd);
		session.ensureTools(options.tools ?? []);
		session.recordRequestInput(options.system, options.messages);
		session.fedMessages = options.messages;
		session.fedSystem = options.system;
		const feed = renderInitialFeed(options.system, options.messages);
		const images = await this.resolveImages(feedImageRefs(feed), vision, options.signal);
		yield* session.stream(options, await this.buildFeed(feed, vision, images), feedToText(feed));
	}
	/** Image references carried by a message tail, skipping assistant content. */
	async resolveTurnImages(tail, vision, signal) {
		const refs = tail.flatMap((message) => message.role === "assistant" ? [] : imageRefs(message.content));
		return this.resolveImages(refs, vision, signal);
	}
	/** Resolve image references into base64 request bytes; absent reader → none. */
	async resolveImages(refs, vision, signal) {
		const map = /* @__PURE__ */ new Map();
		if (!vision || this.readImage === void 0 || refs.length === 0) return map;
		for (const ref of refs) {
			const key = String(ref.attachmentId);
			if (map.has(key)) continue;
			try {
				const image = await this.readImage(ref, signal);
				if (image !== void 0) map.set(key, {
					data: Buffer.from(image.bytes).toString("base64"),
					mediaType: image.mediaType
				});
			} catch {}
		}
		return map;
	}
	/**
	* Turn a feed into channel content. A text feed passes through; a non-vision
	* feed flattens to the harness's own image handle text; an image the host
	* could not read keeps a note naming what was dropped, so the inner model
	* still knows the attachment was there.
	*/
	async buildFeed(feed, vision, images) {
		if (typeof feed === "string") return feed;
		if (!vision) return feedToText(feed);
		const content = [];
		let pixels = 0;
		for (const part of feed) {
			if (part.type === "text") {
				if (part.text.length > 0) content.push({
					type: "text",
					text: part.text
				});
				continue;
			}
			const resolved = images.get(String(part.attachment.attachmentId));
			if (resolved === void 0) {
				content.push({
					type: "text",
					text: `[图片附件 ${String(part.attachment.attachmentId)} 本次未能读取，请基于文字内容继续]`
				});
				continue;
			}
			pixels += 1;
			content.push({
				type: "image",
				source: {
					type: "base64",
					media_type: resolved.mediaType,
					data: resolved.data
				}
			});
		}
		return pixels === 0 ? content.map((block) => block.type === "text" ? block.text : "").join("\n\n") : content;
	}
	/** Tear down every warm inner session (plugin dispose). */
	close() {
		this.sessions.closeAll();
	}
};
/**
* Decide what to feed on a continuation request. The previous list must be a
* prefix (same length growth, index 0 untouched, at most two in-place
* mutations — the host refreshes runtime-context snapshots in place every
* turn). Tail tool-result messages were already resolved into parked handlers
* and never feed; fresh user turns and mutated messages do.
*/
function planContinuation(previous, current) {
	if (current.length <= previous.length) return {
		feed: null,
		rebuild: true
	};
	const mutated = [];
	for (let i = 0; i < previous.length; i++) if (JSON.stringify(previous[i]) !== JSON.stringify(current[i])) mutated.push(i);
	if (mutated.includes(0) || mutated.length > 2) return {
		feed: null,
		rebuild: true
	};
	const freshUser = current.slice(previous.length).filter((m) => m.role === "user");
	if (freshUser.length === 0 && mutated.length === 0) return {
		feed: null,
		rebuild: false
	};
	const parts = [];
	for (const index of mutated) {
		const message = current[index];
		if (message !== void 0) parts.push(renderRefreshed(message));
	}
	for (const message of freshUser) parts.push(renderUserTurn(message.content));
	const feed = joinFeeds(parts);
	return {
		feed: typeof feed === "string" && feed.length === 0 ? null : feed,
		rebuild: false
	};
}
//#endregion
//#region src/setup.ts
/**
* Runs the bundled Windows helper that installs and signs into a Qoder CLI
* (one helper per edition: `qoderclicn` for CN, `qodercli` for international).
*
* The settings page cannot do this by itself: a browser has no way to start a
* local process, and the plugin's own process is the one that already talks to
* the CLI. So the page asks this module, and this module spawns
* {@link SCRIPT_NAME} — the same script a user can double-click — with one of
* two fixed flags, and buffers its output so the page can show progress while
* the browser sign-in is still open.
*
* Nothing user-supplied reaches the command line: the mode is an allow-list of
* two keys mapped to two literal flags, and the script path comes from this
* package's own layout. The helper is idempotent, so a second press re-checks
* rather than reinstalling.
*
* @module dsh-qoder-link/setup
*/
/** File name of the CN helper, shipped under this package's `scripts/` directory. */
const SCRIPT_NAME = "setup-qoderclicn.bat";
/** The helper script for one edition. */
function scriptNameOf(brand) {
	return brandProfile(brand).setupScript;
}
/** The one command-line flag each mode maps to. Never a user-supplied string. */
const FLAGS = {
	configure: "--gui",
	login: "--login",
	uninstall: "--uninstall"
};
/** Whether a value is one of the modes the page may request. */
function isSetupMode(value) {
	return value === "configure" || value === "login" || value === "uninstall";
}
/** Cap on kept output, so a chatty `npm install` cannot grow without bound. */
const MAX_LINES = 400;
/** The latest run per edition: the two installers may run independently. */
const current = /* @__PURE__ */ new Map();
/**
* Locate one edition's helper inside this package.
*
* The host half is bundled to `lib/index.js`, and tests import `src/*.ts`, so
* both layouts resolve to the same `scripts/` directory one level up.
*
* @param brand - which edition's script to find.
*/
function setupScriptPath(brand = "cn") {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const script = scriptNameOf(brand);
	for (const candidate of [path.resolve(here, "..", "scripts", script), path.resolve(here, "scripts", script)]) if (existsSync(candidate)) return candidate;
}
/** Append decoded text to a run, splitting it into displayable lines. */
function absorb(run, chunk, done) {
	run.pending += run.decoder.decode(chunk, { stream: !done });
	const parts = run.pending.split(/\r\n|\r|\n/);
	run.pending = done ? "" : parts.pop() ?? "";
	for (const part of parts) {
		if (part.trim() === "") continue;
		run.lines.push(part);
	}
	if (done && run.pending.trim() !== "") run.lines.push(run.pending.trim());
	while (run.lines.length > MAX_LINES) {
		run.lines.shift();
		run.truncated = true;
	}
}
/**
* Start one edition's helper. Only one run per edition at a time; a finished
* one stays readable.
*
* @param brand - which edition to configure.
* @param mode - the fixed flag the page may ask for.
* @param onFinish - called once with the exit code.
*/
function startSetup(brand, mode, onFinish) {
	const previous = current.get(brand);
	if (previous !== void 0 && previous.finishedAt === void 0) return {
		started: false,
		reason: "busy",
		error: "已经有一次配置在跑了，请等它结束。"
	};
	if (process.platform !== "win32") {
		const command = brandProfile(brand).cliCommands[0];
		return {
			started: false,
			reason: "unsupported",
			error: `一键${mode === "uninstall" ? "卸载" : "配置"}只支持 Windows，请在 CLI 所在机器上手动处理 ${command}。`
		};
	}
	const script = setupScriptPath(brand);
	if (script === void 0) return {
		started: false,
		reason: "missing-script",
		error: `插件包里没有 ${scriptNameOf(brand)}，缺少 scripts/ 目录。`
	};
	const run = {
		child: void 0,
		brand,
		mode,
		startedAt: Date.now(),
		lines: [],
		pending: "",
		decoder: new TextDecoder("utf-8"),
		truncated: false
	};
	const child = spawn(process.env.ComSpec ?? "cmd.exe", [
		"/d",
		"/c",
		script,
		FLAGS[mode]
	], {
		cwd: homedir(),
		windowsHide: true,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	run.child = child;
	current.set(brand, run);
	const finish = (code) => {
		if (run.finishedAt !== void 0) return;
		run.finishedAt = Date.now();
		run.code = code;
		try {
			onFinish?.(code);
		} catch (error) {
			run.lines.push(`收尾回调失败：${error instanceof Error ? error.message : String(error)}`);
		}
	};
	child.stdout?.on("data", (chunk) => absorb(run, chunk, false));
	child.stderr?.on("data", (chunk) => absorb(run, chunk, false));
	child.on("error", (error) => {
		run.lines.push(`无法启动 ${scriptNameOf(brand)}：${error instanceof Error ? error.message : String(error)}`);
		finish(null);
	});
	child.on("close", (code) => {
		absorb(run, /* @__PURE__ */ new Uint8Array(), true);
		finish(code);
	});
	return { started: true };
}
/**
* The latest run of one edition, with any not-yet-newlined tail included for
* live display.
*
* @param brand - which edition's run to report.
*/
function readSetupStatus(brand = "cn") {
	const run = current.get(brand);
	if (run === void 0) return {
		running: false,
		lines: [],
		truncated: false
	};
	const lines = run.pending.trim() === "" ? run.lines : [...run.lines, run.pending.trim()];
	return {
		running: run.finishedAt === void 0,
		mode: run.mode,
		startedAt: run.startedAt,
		...run.finishedAt === void 0 ? {} : {
			finishedAt: run.finishedAt,
			code: run.code ?? null
		},
		lines,
		truncated: run.truncated
	};
}
/**
* Abandon the running helper, if any.
*
* Called when the plugin is disposed. Killing `cmd.exe` does not reap the CLI it
* already launched, but the helper's own wait is bounded, so nothing hangs on
* the far end.
*/
function stopSetup() {
	for (const run of current.values()) if (run.finishedAt === void 0) run.child.kill();
}
//#endregion
//#region src/api.ts
/** Route prefix this plugin owns; the client resolves it relative to the page. */
const API_PREFIX = "/api/llm-qoder-cn";
/** Answer one request with JSON. */
function send(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/**
* Build the model rows: the live catalog joined with the user's choices.
*
* @param adapter - the adapter owning the live catalog and the resolved config.
* @returns one row per model the account exposes, in catalog order.
*/
async function buildRows(adapter) {
	return (await adapter.describeCatalog()).map((entry) => {
		const override = adapter.contextWindowFor(entry.value);
		const upstream = entry.defaultContextWindow ?? (entry.availableContextWindows !== void 0 && entry.availableContextWindows.length > 0 ? Math.max(...entry.availableContextWindows) : entry.maxInputTokens) ?? 2e5;
		const choices = new Set(entry.availableContextWindows ?? []);
		choices.add(upstream);
		if (override !== void 0) choices.add(override);
		const priceFactor = priceFactorOf(entry);
		return {
			id: entry.value,
			name: entry.displayName.length > 0 ? entry.displayName : entry.value,
			...entry.description.length > 0 ? { description: entry.description } : {},
			enabled: !adapter.isModelDisabled(entry.value),
			vision: entry.isVl === true,
			contextWindow: override ?? upstream,
			contextWindows: [...choices].sort((a, b) => a - b),
			defaultContextWindow: upstream,
			...override === void 0 ? {} : { override },
			...priceFactor === void 0 ? {} : { priceFactor },
			reasoning: entry.isReasoning !== false
		};
	});
}
/**
* Largest request body this route accepts. The only body in the API is a
* two-key JSON object, so anything bigger is either a bug or an attack.
*/
const MAX_BODY_BYTES = 1024;
/** Read and parse a small JSON request body. */
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const part of req) {
		const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") throw new Error("缺少请求体");
	return JSON.parse(text);
}
/** The brand a query-string or body selected, or undefined when it named none. */
function brandFrom(value) {
	if (value === null || value === void 0 || value === "") return "cn";
	return isQoderBrand(value) ? value : void 0;
}
/**
* Handle one request under {@link API_PREFIX}.
*
* @param req - the incoming request.
* @param res - the response this handler owns.
* @param adapters - one adapter per edition; `brand` selects which answers.
*/
async function handleApi(req, res, adapters) {
	try {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname.slice(17) || "/";
		const method = req.method ?? "GET";
		const queryBrand = brandFrom(url.searchParams.get("brand"));
		if (queryBrand === void 0) {
			send(res, 400, { error: "brand 只接受 cn 或 global" });
			return;
		}
		const adapter = adapters[queryBrand];
		if (path === "/models" && method === "GET") {
			if (url.searchParams.get("fresh") === "1") adapter.invalidateCatalog();
			const models = await buildRows(adapter);
			const notice = models.length === 0 ? adapter.catalogError() : void 0;
			send(res, 200, {
				brand: queryBrand,
				models,
				...notice === void 0 ? {} : { notice }
			});
			return;
		}
		if (path === "/usage" && method === "GET") {
			send(res, 200, {
				brand: queryBrand,
				...await adapter.usageInfo(url.searchParams.get("fresh") === "1")
			});
			return;
		}
		if (path === "/setup") {
			if (method === "GET") {
				send(res, 200, readSetupStatus(queryBrand));
				return;
			}
			if (method === "POST") {
				let body;
				try {
					body = await readJson(req) ?? {};
				} catch (error) {
					send(res, 400, { error: `请求体无法解析：${error instanceof Error ? error.message : String(error)}` });
					return;
				}
				const parsed = body;
				const postBrand = brandFrom(parsed.brand);
				if (postBrand === void 0) {
					send(res, 400, { error: "brand 只接受 cn 或 global" });
					return;
				}
				if (!isSetupMode(parsed.mode)) {
					send(res, 400, { error: "mode 只接受 configure、login 或 uninstall" });
					return;
				}
				const result = startSetup(postBrand, parsed.mode, (code) => {
					if (code === 0) {
						adapters[postBrand].invalidateCatalog();
						adapters[postBrand].invalidateUsage();
					}
				});
				if (!result.started) {
					send(res, result.reason === "busy" ? 409 : result.reason === "unsupported" ? 501 : 500, { error: result.error });
					return;
				}
				send(res, 200, readSetupStatus(postBrand));
				return;
			}
		}
		send(res, method === "GET" ? 404 : 405, { error: method === "GET" ? "not found" : "只支持读取，以及 POST /setup" });
	} catch (error) {
		send(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}
//#endregion
//#region src/config.ts
/**
* The plugin's configuration surface.
*
* DSH's settings service reads a plugin's exported `Config` schema and, when no
* custom page is registered for that entry, auto-generates a settings page from
* it (`autoGenerate` defaults to true in `dsh-settings`). That makes this schema
* the single source of truth for both runtime behaviour and the settings UI —
* every field documented here appears as a labelled control, and its
* `description` becomes the help text under it.
*
* Field order matters: the generated form renders in declaration order, so the
* groups below are arranged the way a user reads them (identity → capacity →
* context → timeouts → models → aliases).
*
* @module dsh-qoder-link/config
*/
/**
* The configuration schema. This is what DSH turns into the settings page, so
* the defaults and bounds here are user-visible documentation.
*
* ## Why every field is `.volatile()`
*
* DSH's settings service builds its form from `volatileForm(schema)`, which
* keeps a field ONLY when the node (or an ancestor) carries `meta.volatile`;
* an object whose fields are all non-volatile collapses to `undefined` and the
* whole namespace is dropped from `describe()` before any client sees it. A
* plugin with a plain schema therefore registers successfully, streams models
* correctly, and still shows no settings page anywhere — the namespace never
* reaches the wire.
*
* ## What `.volatile()` costs: read every field at use
*
* A volatile-only edit does not restart the plugin. The loader writes the new
* value into the *same* `Volatile` cell the running plugin already holds and
* skips the rest of the update lifecycle, so `apply()` is never called again
* (`Entry.update` → `_commitVolatile` in `cordis-plugin-loader`). Capturing a
* field in `apply()` therefore freezes it for the lifetime of the process, and
* the plugin answers with mount-time values while the settings page and the
* profile patch on disk show the new ones.
*
* That is why the whole plugin consumes its config through {@link liveConfig},
* which returns a thunk per field: the value is unwrapped from its volatile
* reference at every read, so an in-place edit is visible immediately. See
* `src/live.ts` for the full mechanism.
*/
const Config$1 = z$1.object({
	cnEnabled: z$1.boolean().default(true).description("启用 Qoder CN。关闭后该设置页、模型列表与 provider 路由都会移除；已保存的模型选择会保留。").volatile(),
	intlEnabled: z$1.boolean().default(true).description("启用 Qoder 国际版。关闭后该设置页、模型列表与 provider 路由都会移除；已保存的模型选择会保留。").volatile(),
	disabledModels: z$1.array(z$1.string()).default([]).description("已关闭的模型 ID 列表（以 Qoder 模型 ID 为准）。关闭的模型不会出现在模型选择器里。").volatile(),
	modelContextWindows: z$1.dict(z$1.number()).default({}).description("按模型指定上下文窗口（token 数）。未指定的模型使用上游声明的窗口。").volatile(),
	intlDisabledModels: z$1.array(z$1.string()).default([]).description("国际版已关闭的模型 ID 列表。与 CN 列表分开，因为两边的模型目录不同。").volatile(),
	intlModelContextWindows: z$1.dict(z$1.number()).default({}).description("国际版按模型指定的上下文窗口（token 数）。").volatile(),
	intlModelAliases: z$1.dict(z$1.string()).default({}).description("国际版额外的模型别名映射：DSH 侧名称 → Qoder 模型 ID。").volatile(),
	intlDisplayName: z$1.string().default("Qoder 国际版").description("模型选择器里国际版分组的名称。").volatile(),
	displayName: z$1.string().default("Qoder CN").description("模型选择器里主分组的名称。同时使用多个 Qoder 账号时可区分。").volatile(),
	maxSessions: z$1.number().step(1).min(1).max(64).default(8).description("同时保持的内层会话数上限，超出后按最久未使用关闭。每个会话是一个子进程。").volatile(),
	modelCacheTtlSeconds: z$1.number().step(1).min(10).max(86400).default(300).description("模型列表缓存时长（秒）。调小可更快看到账号侧变化。").volatile(),
	modelAliases: z$1.dict(z$1.string()).default({}).description("额外的模型别名映射：DSH 侧名称 → Qoder 模型 ID。内置 deepseek-v4-* 别名仍然生效。").volatile(),
	defaultReasoningEffort: z$1.string().default("").description("请求未指定思考档位时使用的默认档位；留空则用上游默认。").volatile(),
	defaultMaxTokens: z$1.number().step(1).min(1).default(32e3).description("模型未声明输出上限时使用的输出上限。").volatile(),
	toolResultTimeoutSeconds: z$1.number().step(1).min(5).max(3600).default(120).description("仅用于未配对 handler 的兜底时限（秒）：正常工具调用会等宿主下一次请求携带结果，不按此超时。").volatile(),
	catalogFetchTimeoutSeconds: z$1.number().step(1).min(1).max(300).default(20).description("拉取模型列表的时限（秒），超时后回退到内置列表。").volatile(),
	abortGraceSeconds: z$1.number().step(1).min(1).max(120).default(5).description("内层进程确认中断的宽限时间（秒）。").volatile(),
	coldMaxTurns: z$1.number().step(1).min(1).max(32).default(4).description("旁路请求（生成标题、压缩摘要）允许的最大内层轮次。").volatile()
});
/**
* Wrap a parsed config as {@link LiveConfig}.
*
* Every normalizer {@link resolveConfig} applies is applied here too — the live
* wrapper is the same interpretation of the same raw fields, just deferred —
* and `resolveConfig` is implemented on top of it, so the two can never
* disagree about what a given input means.
*
* @param config - the parsed plugin config, possibly partial or absent.
* @returns one thunk per resolved field, each reading the live cell.
*/
function liveConfig(config) {
	const source = config ?? {};
	/**
	* One field's current value.
	*
	* The volatile unwrap happens on every call rather than once, which is the
	* entire point: the reference object outlives an edit, only its contents
	* change.
	*/
	const field = (key) => {
		const value = source[key];
		return isVolatile(value) ? value.get() : value;
	};
	return {
		cnEnabled: () => bool(field("cnEnabled"), true),
		intlEnabled: () => bool(field("intlEnabled"), true),
		displayName: () => nonEmpty(field("displayName"), "Qoder CN"),
		maxSessions: () => positive(field("maxSessions"), 8),
		modelCacheTtlMs: () => positive(field("modelCacheTtlSeconds"), 300) * 1e3,
		defaultMaxTokens: () => positive(field("defaultMaxTokens"), 32e3),
		toolResultTimeoutMs: () => positive(field("toolResultTimeoutSeconds"), 120) * 1e3,
		catalogFetchTimeoutMs: () => positive(field("catalogFetchTimeoutSeconds"), 20) * 1e3,
		abortGraceMs: () => positive(field("abortGraceSeconds"), 5) * 1e3,
		coldMaxTurns: () => positive(field("coldMaxTurns"), 4),
		disabledModels: () => stringList(field("disabledModels")),
		modelContextWindows: () => numberMap(field("modelContextWindows")),
		modelAliases: () => stringMap(field("modelAliases")),
		defaultReasoningEffort: () => {
			const raw = field("defaultReasoningEffort");
			const effort = typeof raw === "string" ? raw.trim() : "";
			return effort.length > 0 ? effort : void 0;
		},
		intlDisplayName: () => nonEmpty(field("intlDisplayName"), "Qoder 国际版"),
		intlDisabledModels: () => stringList(field("intlDisabledModels")),
		intlModelContextWindows: () => numberMap(field("intlModelContextWindows")),
		intlModelAliases: () => stringMap(field("intlModelAliases"))
	};
}
/**
* Apply defaults to a parsed config.
*
* A one-shot snapshot of {@link liveConfig}, for a caller that genuinely wants
* the values as they are right now (a report, a test) rather than a view that
* keeps following edits. The running plugin does not use it: every option it
* hands downstream is a thunk, so a volatile edit is never missed.
*
* @param config - the parsed plugin config, possibly partial.
* @returns the same values with every default filled in.
*/
function resolveConfig(config) {
	const live = liveConfig(config);
	return {
		cnEnabled: live.cnEnabled(),
		intlEnabled: live.intlEnabled(),
		displayName: live.displayName(),
		maxSessions: live.maxSessions(),
		modelCacheTtlMs: live.modelCacheTtlMs(),
		defaultMaxTokens: live.defaultMaxTokens(),
		toolResultTimeoutMs: live.toolResultTimeoutMs(),
		catalogFetchTimeoutMs: live.catalogFetchTimeoutMs(),
		abortGraceMs: live.abortGraceMs(),
		coldMaxTurns: live.coldMaxTurns(),
		disabledModels: live.disabledModels(),
		modelContextWindows: live.modelContextWindows(),
		modelAliases: live.modelAliases(),
		defaultReasoningEffort: live.defaultReasoningEffort(),
		intlDisplayName: live.intlDisplayName(),
		intlDisabledModels: live.intlDisabledModels(),
		intlModelContextWindows: live.intlModelContextWindows(),
		intlModelAliases: live.intlModelAliases()
	};
}
function nonEmpty(value, fallback) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}
function positive(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** A boolean with a default for a value the form has not supplied yet. */
function bool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
function stringList(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}
/**
* Keep only the positive, finite entries of a map.
*
* A window of zero or a negative number would be passed straight to the
* harness as a capacity, so invalid entries are dropped here rather than
* rejected — one bad row must not discard the user's other choices.
*/
function numberMap(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "number" && Number.isFinite(entry) && entry > 0) out[key] = entry;
	return out;
}
function stringMap(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string" && entry.trim().length > 0) out[key] = entry.trim();
	return out;
}
//#endregion
//#region src/index.ts
/** Cordis plugin name; must match the `id` used by `cordis.patch.yml`. */
const name = "llm-qoder-cn";
/** The LLM registry must exist before an adapter can be registered on it. */
const inject = ["llm"];
/**
* Configuration namespace: the profile entry id this plugin is mounted under.
* The settings service and the configurable-provider directory both address the
* plugin by this key, and the exported {@link ConfigSchema} is the form source,
* so no page has to be registered by hand.
*/
const NS = "llm-qoder-cn";
/** Encoded-byte ceiling for one forwarded request image, before base64 expansion. */
const REQUEST_IMAGE_MAX_BYTES = 1048576;
/**
* Config fields whose value decides a registration shape rather than a runtime
* behaviour, and which therefore cannot be read lazily.
*
* The edition switches decide which routes exist at all; the two display names
* are copied into the picker directory. Everything else is read where it is
* used, so a change to these fields is the only thing that needs a republish.
*/
const STRUCTURAL_FIELDS = /* @__PURE__ */ new Set([
	"cnEnabled",
	"intlEnabled",
	"displayName",
	"intlDisplayName"
]);
/** The configurable-provider directory rows for the enabled editions. */
function directoryFor(live) {
	const rows = [];
	if (live.cnEnabled()) rows.push({
		provider: QODER_PROVIDER,
		displayName: live.displayName(),
		settingsNs: NS,
		settingsPath: []
	});
	if (live.intlEnabled()) rows.push({
		provider: QODER_INTL_PROVIDER,
		displayName: live.intlDisplayName(),
		settingsNs: NS,
		settingsPath: []
	});
	return rows;
}
/**
* The plugin's configuration schema, re-exported under the name the loader
* looks for. DSH reads `runtime.Config` off the plugin fiber to build the
* settings page, so this must stay the exported `Config` binding.
*
* Every field is `.volatile()`, which is what makes the namespace appear in
* `settings.describe()` at all — see the note on {@link ConfigSchema}.
*/
const Config = Config$1;
/**
* Mount the adapter for the lifetime of the plugin.
*
* @param ctx - the plugin's cordis context.
* @param config - parsed plugin config, whose volatile fields arrive as
*   references. {@link liveConfig} wraps them as thunks the adapter reads where
*   it uses them, so an edit applies without this function running again; an
*   empty object is a valid deployment.
*/
function apply(ctx, config) {
	const live = liveConfig(config);
	let attachments;
	/**
	* Everything both editions share.
	*
	* Images reach the inner model only through the host attachment store, so
	* this stays a lazy lookup. An unmounted store leaves the adapter with no
	* reader, and images degrade to the harness's own handle text instead of
	* failing the turn — which is also why `attachments` is not a hard inject:
	* the provider routes must register even on a deployment without one.
	*/
	const shared = {
		maxSessions: live.maxSessions,
		modelCacheTtlMs: live.modelCacheTtlMs,
		toolResultTimeoutMs: live.toolResultTimeoutMs,
		abortGraceMs: live.abortGraceMs,
		coldMaxTurns: live.coldMaxTurns,
		catalogFetchTimeoutMs: live.catalogFetchTimeoutMs,
		defaultMaxTokens: live.defaultMaxTokens,
		defaultReasoningEffort: live.defaultReasoningEffort,
		readImage: (ref, signal) => {
			const store = attachments;
			if (store === void 0) return Promise.resolve(void 0);
			return store.readImageRequest(ref, {
				width: ref.width,
				height: ref.height,
				maxBytes: REQUEST_IMAGE_MAX_BYTES
			}, signal).then((image) => ({
				bytes: image.data,
				mediaType: image.mediaType
			}));
		}
	};
	/**
	* One adapter per edition.
	*
	* Two instances, not one instance on two routes: each carries its own model
	* catalog, warm-session pool, quota reading and user choices, so an intl
	* request can never be resolved against a CN catalog or share a CN session.
	*/
	const adapters = {
		cn: new QoderAdapter({
			...shared,
			brand: "cn",
			displayName: live.displayName,
			disabledModels: live.disabledModels,
			modelContextWindows: live.modelContextWindows,
			modelAliases: live.modelAliases
		}),
		global: new QoderAdapter({
			...shared,
			brand: "global",
			displayName: live.intlDisplayName,
			disabledModels: live.intlDisabledModels,
			modelContextWindows: live.intlModelContextWindows,
			modelAliases: live.intlModelAliases
		})
	};
	ctx.inject(["attachments"], (scope) => {
		attachments = scope.attachments;
		scope.effect(() => () => {
			attachments = void 0;
		}, "llm-qoder-cn.attachments");
	});
	const routes = {};
	let directory;
	/**
	* Bring the registered routes and the picker directory in line with the
	* current switches and labels.
	*
	* `registerAdapter` refuses an empty provider list, which is why a disabled
	* edition is *not registered* instead of being registered and then hidden:
	* the route itself has to disappear so no request can reach it and no model
	* list is offered for it. Turning it back on registers a fresh handle.
	*/
	const syncRegistration = () => {
		for (const brand of BRANDS) {
			const enabled = brand.id === "cn" ? live.cnEnabled() : live.intlEnabled();
			const current = routes[brand.id];
			if (enabled && current === void 0) routes[brand.id] = ctx.llm.registerAdapter([brand.provider], adapters[brand.id]);
			else if (!enabled && current !== void 0) {
				current();
				delete routes[brand.id];
			}
		}
		const entries = directoryFor(live);
		if (entries.length === 0) {
			directory?.();
			directory = void 0;
		} else if (directory === void 0) directory = ctx.llm.registerConfigurableProviders(entries);
		else directory.replace(entries);
	};
	syncRegistration();
	/**
	* React to a structural config edit.
	*
	* A volatile-only edit does not re-run `apply()`, so this is the only place
	* the route set, the picker labels and the enabled editions can follow it.
	*/
	ctx.on("loader/volatile-update", (paths) => {
		if (!paths.some((path) => STRUCTURAL_FIELDS.has(String(path[0])))) return;
		try {
			syncRegistration();
		} catch (error) {
			ctx.logger?.warn(`llm-qoder-cn: 重新发布模型分组失败：${String(error)}`);
		}
	});
	ctx.effect(() => () => {
		adapters.cn.close();
		adapters.global.close();
	}, "llm-qoder-cn.sessions");
	ctx.effect(() => () => stopSetup(), "llm-qoder-cn.setup");
	ctx.inject(["webServer"], (scope) => {
		const server = scope.webServer;
		if (server === void 0) return;
		scope.effect(() => server.register({
			kind: "prefix",
			path: API_PREFIX,
			handler: (req, res) => {
				handleApi(req, res, adapters);
			}
		}), "llm-qoder-cn: settings api");
		ctx.logger?.info(`llm-qoder-cn: 设置接口已挂载于 ${API_PREFIX}`);
	});
}
//#endregion
export { API_PREFIX, BRANDS, CN_BRAND, Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_USAGE_CACHE_TTL_MS, DEFAULT_USAGE_TIMEOUT_MS, GLOBAL_BRAND, MODEL_ALIASES, NARROW_CHARS_PER_TOKEN, QODER_INTL_PROVIDER, QODER_MODELS, QODER_PROVIDER, QoderAdapter, QoderModelCatalog, QoderSession, QoderSessionManager, QoderUsage, SCRIPT_NAME, ToolResultPairing, WIDE_CHARS_PER_TOKEN, apply, brandProfile, buildRows, cliContextWindow, countWideChars, estimateTextTokens, handleApi, inject, isSetupMode, isWideChar, liveConfig, loadSdk, name, pickContextWindow, priceFactorOf, readLive, readLiveOptional, readSetupStatus, resolveConfig, resolveQoderModelId, setupScriptPath, startSetup, stopSetup };
