/**
 * The MiniMax Code CLI (`mcode`): locating it and running its installer.
 *
 * MiniMax ships `@minimax-ai/code` as a global npm package whose `mcode`
 * launcher is a Node shim. Its native SQLite dependency is installed by a
 * postinstall script, and npm 12 blocks install scripts unless they are named
 * with `--allow-scripts`; a plain `npm i -g` leaves a CLI that cannot start.
 * The installer below therefore passes the flags the package documents.
 *
 * @module dsh-agent-sdk-bridge/minimax-cli
 */
/** How to invoke the CLI: an executable plus its leading arguments. */
export interface MinimaxCliSpec {
    command: string;
    args: string[];
    /** The JavaScript entry, when the launcher resolves to one. */
    cliPath?: string;
}
/**
 * Locate `mcode`.
 *
 * `MCODE_CLI_PATH` wins (a cli.js path or an executable); otherwise the PATH
 * shims and the global npm prefixes are checked. The explicit cli.js lookup
 * matters on Windows, where spawning a `.cmd` for ACP would put cmd.exe between
 * the protocol streams.
 */
export declare function resolveMinimaxCli(): MinimaxCliSpec | undefined;
/** The spawn argument list for one CLI invocation. */
export declare function minimaxCliArgs(spec: MinimaxCliSpec, args: readonly string[]): string[];
/** What the settings page may ask the installer to do. */
export type MinimaxSetupMode = 'install' | 'uninstall';
/** Whether a value names an installer action. */
export declare function isMinimaxSetupMode(value: unknown): value is MinimaxSetupMode;
/** Snapshot the page polls. */
export interface MinimaxSetupStatus {
    running: boolean;
    mode?: MinimaxSetupMode;
    startedAt?: number;
    finishedAt?: number;
    code?: number | null;
    lines: string[];
    truncated: boolean;
    installed: boolean;
    cliPath?: string;
}
/**
 * Start the npm installer or uninstaller.
 *
 * The command is fixed: the mode is an allow-list and no user input reaches
 * argv. npm itself is run through cmd.exe on Windows because npm is a `.cmd`
 * shim and Node refuses to spawn it directly on recent versions.
 */
export declare function startMinimaxSetup(mode: MinimaxSetupMode, onFinish?: (code: number | null) => void): {
    started: true;
} | {
    started: false;
    reason: 'busy' | 'unsupported';
    error: string;
};
/** The latest installer run, with any not-yet-newlined tail included. */
export declare function readMinimaxSetupStatus(): MinimaxSetupStatus;
/** Abandon a running installer. */
export declare function stopMinimaxSetup(): void;
/** A small object facade for callers that prefer a service shape. */
export declare class MinimaxCliSetup {
    readonly start: typeof startMinimaxSetup;
    readonly status: typeof readMinimaxSetupStatus;
    readonly stop: typeof stopMinimaxSetup;
}
