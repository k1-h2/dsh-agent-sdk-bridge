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
import type { QoderBrand } from './brand.ts';
/** File name of the CN helper, shipped under this package's `scripts/` directory. */
export declare const SCRIPT_NAME = "setup-qoderclicn.bat";
/** The helper script for one edition. */
export declare function scriptNameOf(brand: QoderBrand): string;
/** What the page may ask for: install/sign in, only sign in, or uninstall. */
export type SetupMode = 'configure' | 'login' | 'uninstall';
/** Whether a value is one of the modes the page may request. */
export declare function isSetupMode(value: unknown): value is SetupMode;
/** Snapshot the page polls. Always safe to render; empty before the first run. */
export interface SetupStatus {
    running: boolean;
    mode?: SetupMode;
    startedAt?: number;
    finishedAt?: number;
    /** Exit code once finished; `null` when the process could not be started. */
    code?: number | null;
    lines: string[];
    truncated: boolean;
}
/**
 * Locate one edition's helper inside this package.
 *
 * The host half is bundled to `lib/index.js`, and tests import `src/*.ts`, so
 * both layouts resolve to the same `scripts/` directory one level up.
 *
 * @param brand - which edition's script to find.
 */
export declare function setupScriptPath(brand?: QoderBrand): string | undefined;
/** Why a run could not start, so the caller can pick a status of its own. */
export type SetupFailure = 'busy' | 'unsupported' | 'missing-script';
/**
 * Start one edition's helper. Only one run per edition at a time; a finished
 * one stays readable.
 *
 * @param brand - which edition to configure.
 * @param mode - the fixed flag the page may ask for.
 * @param onFinish - called once with the exit code.
 */
export declare function startSetup(brand: QoderBrand, mode: SetupMode, onFinish?: (code: number | null) => void): {
    started: true;
} | {
    started: false;
    reason: SetupFailure;
    error: string;
};
/**
 * The latest run of one edition, with any not-yet-newlined tail included for
 * live display.
 *
 * @param brand - which edition's run to report.
 */
export declare function readSetupStatus(brand?: QoderBrand): SetupStatus;
/**
 * Abandon the running helper, if any.
 *
 * Called when the plugin is disposed. Killing `cmd.exe` does not reap the CLI it
 * already launched, but the helper's own wait is bounded, so nothing hangs on
 * the far end.
 */
export declare function stopSetup(): void;
