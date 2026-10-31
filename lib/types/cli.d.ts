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
 * @module dsh-agent-sdk-bridge/cli
 */
import type { Options } from '@qodercn-ai/qodercn-agent-sdk';
import type { QoderBrand } from './brand.ts';
/** The query options that move a session onto the CLI's own process. */
export type QoderCliOptions = Pick<Options, 'pathToQoderCLIExecutable' | 'executable' | 'env'>;
/** A CLI entry that can be spawned, plus the directory of the Node that runs it. */
export interface QoderCli {
    /** Path to the CLI: a native binary, or a script the Node below runs. */
    path: string;
    /** Directory holding the interpreter for a script entry; absent for a binary. */
    nodeDir?: string;
}
/**
 * What the lookup reads. Injectable so a test can describe a machine instead of
 * having to be one, and so a caller can point the search somewhere else.
 */
export interface CliLookup {
    /** Environment to read; defaults to this process's. */
    env?: NodeJS.ProcessEnv;
    /** Platform whose layouts to follow; defaults to this process's. */
    platform?: NodeJS.Platform;
    /** File-existence probe; defaults to the real filesystem. */
    exists?(candidate: string): boolean;
    /** Directory listing; defaults to the real filesystem. */
    readdir?(dir: string): readonly string[];
    /** The running interpreter; defaults to this process's executable. */
    execPath?: string;
    /** Whether that interpreter is Electron rather than Node; defaults to the truth. */
    electron?: boolean;
}
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
export declare function resolveQoderCli(brand?: QoderBrand, lookup?: CliLookup): QoderCli | undefined;
/**
 * Query options that route a session through the CLI's own process.
 *
 * Empty when no CLI was found: the caller spreads this into its options, so an
 * empty answer leaves the SDK's default transport in place.
 *
 * @param brand - which edition's CLI the session speaks to.
 * @param lookup - the machine to inspect; defaults to this process's.
 */
export declare function qoderCliOptions(brand?: QoderBrand, lookup?: CliLookup): QoderCliOptions;
/**
 * Whether a CLI path belongs to the other edition.
 *
 * `QODERCLI_PATH` predates the international edition and is set globally by
 * some CN installs. Both SDKs read that one variable from the parent process
 * before anything else, so an intl session would otherwise spawn the CN CLI and
 * answer with the CN account. A path that names an edition is therefore never
 * offered to the other one; a neutral custom build is still honoured for both.
 */
export declare function isForeignCliPath(brand: QoderBrand, candidate: string): boolean;
/**
 * Why this edition has no usable CLI, when `QODERCLI_PATH` explains it.
 *
 * `QODERCLI_PATH` predates the international edition and some installers
 * export it machine-wide. Both SDKs read it from the parent process before any
 * option this plugin can pass, so a value naming the *other* edition would
 * hand this edition's session the other account. The lookup therefore never
 * offers it ({@link isForeignCliPath}), and this reports the case where it is
 * all the machine has, so the page can ask for the right CLI to be installed.
 *
 * This is a diagnosis, not a second rule: an edition that finds its own CLI is
 * unaffected by the variable. That is what keeps one edition's install from
 * blocking the other's sign-in — the earlier code treated any foreign value as
 * fatal, so a machine that had only the intl CLI installed could not sign in
 * to CN even after installing it if the lookup missed the new package.
 *
 * @param brand - the edition the caller is about to start.
 * @param lookup - the machine to inspect; defaults to this process's.
 * @returns the foreign override when this edition has nothing of its own.
 */
export declare function foreignCliOverride(brand: QoderBrand, lookup?: CliLookup): string | undefined;
/**
 * The environment one session's child process receives.
 *
 * `QODERCLI_PATH` is stripped when it names the other edition: both SDKs read
 * it from the parent before honouring any option, so leaving it in place would
 * hand the intl session the CN CLI (and the CN account). Every other variable
 * is inherited untouched — the CLI keeps its state in `PATH`-relative dirs.
 *
 * @param brand - which edition's child is being started.
 * @param env - the environment to derive from; defaults to this process's.
 */
export declare function cliChildEnv(brand: QoderBrand, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/**
 * The error text for {@link foreignCliOverride}.
 *
 * Deliberately says nothing about the variable or the path that caused it: the
 * page's job here is to tell the user which CLI to install, not to explain the
 * plugin's environment plumbing. The technical reason stays in the lookup.
 */
export declare function cliConflictMessage(brand: QoderBrand): string;
/**
 * Turn a CLI failure into something a user can act on.
 *
 * The SDK reports an outdated CLI as `Qoder CLI process exited with code 42`,
 * which says nothing about the cause: CLI 1.1.81 removed the worker-session
 * handshake the older SDK spoke, and its own log says so
 * (`sdk_worker_removed: … Upgrade to the latest Qoder SDK version, or roll back
 * the CLI`). The only fix available to a user is reinstalling the pair through
 * the bundled helper, so say that instead of echoing the number.
 *
 * @param detail - the error text as the SDK reported it.
 * @param brand - which edition's helper the message should name.
 * @returns the original detail, prefixed with the actionable explanation.
 */
export declare function cliFailureText(detail: string, brand: QoderBrand): string;
/**
 * The CLI version the installed SDK expects, read from its runtime manifest.
 *
 * Each SDK release pins one CLI build: the two speak a wire protocol that
 * changes between them, and a mismatch fails every session with a bare exit
 * code. The bundled helper reads the same file, so the page and the helper
 * agree on which build to install.
 *
 * @param brand - which edition's SDK to inspect.
 * @returns the pinned version, or undefined when the manifest is unreadable.
 */
export declare function requiredCliVersion(brand: QoderBrand): string | undefined;
/**
 * The version of the installed CLI, read from its own package manifest.
 *
 * Read from disk rather than by running `--version`: a settings-page poll must
 * not spawn a process every second, and the npm package always ships a
 * manifest next to its entry. A native build without one answers undefined,
 * which callers treat as "unknown" and never as a mismatch.
 *
 * @param brand - which edition's CLI to inspect.
 * @returns the installed version, or undefined when it cannot be read.
 */
export declare function installedCliVersion(brand: QoderBrand): string | undefined;
