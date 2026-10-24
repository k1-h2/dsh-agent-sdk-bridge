/**
 * The settings pages' data source, served same-origin.
 *
 * The pages cannot read the model catalog from the config form: the catalog is
 * fetched live from the provider, while the form only carries what the user
 * stored. So the host answers these JSON routes:
 *
 * - `GET <prefix>/models?brand=cn|global|codebuddy` — the account's models,
 *   each with its enabled state and the windows it may use.
 * - `GET <prefix>/usage?brand=...` — the account reading. Qoder returns quota;
 *   CodeBuddy returns the signed-in account (its SDK exposes no quota call).
 * - `GET/POST <prefix>/setup` — the Qoder CLI install/login/uninstall helper.
 * - `GET/POST <prefix>/auth` — CodeBuddy browser login/logout per region.
 *
 * Config writes deliberately do NOT come through here. The browser half holds
 * a revision-fenced form for this plugin's namespace (`ctx.configForms`), and
 * routing every change through it means one write path and one revision fence.
 *
 * @module dsh-agent-sdk-bridge/api
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { QoderAdapter } from './adapter.ts';
import type { CodeBuddyAdapter } from './codebuddy-adapter.ts';
import type { BrandId, CodeBuddyRegion } from './brand.ts';
/** Route prefix this plugin owns; the client resolves it relative to the page. */
export declare const API_PREFIX = "/api/llm-qoder-cn";
/** One model row as a settings page renders it. */
export interface ModelRow {
    id: string;
    name: string;
    description?: string;
    enabled: boolean;
    vision: boolean;
    contextWindow: number;
    contextWindows: number[];
    defaultContextWindow: number;
    override?: number;
    priceFactor?: number;
    reasoning: boolean;
}
/** The adapters the API can reach, one per provider route. */
export type AdapterMap = Readonly<Record<BrandId, QoderAdapter | CodeBuddyAdapter>>;
/** Build model rows for a Qoder adapter. */
export declare function buildRows(adapter: QoderAdapter): Promise<ModelRow[]>;
/** Build model rows for the CodeBuddy adapter, for one login region. */
export declare function buildCodeBuddyRows(adapter: CodeBuddyAdapter, region?: CodeBuddyRegion): Promise<ModelRow[]>;
/** Handle one request under {@link API_PREFIX}. */
export declare function handleApi(req: IncomingMessage, res: ServerResponse, adapters: AdapterMap): Promise<void>;
