/**
 * Where a session runs its Qoder CLI, and when a turn survives unusable pixels.
 *
 * The lookup is driven entirely through its injectable {@link CliLookup}, so
 * these cases describe machines — an Electron host with no Node on `PATH`, an
 * npm-global install, a native build, a stray worker runtime — instead of
 * asserting whatever the test machine happens to have. What matters is that a
 * found CLI is spawnable (never a worker-runtime module, which the SDK would
 * answer with the in-process worker the lookup exists to avoid), that a script
 * entry always comes with an interpreter, and that finding nothing leaves the
 * SDK's own defaults alone.
 */
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { foreignCliOverride, qoderCliOptions, resolveQoderCli, type CliLookup } from '../src/cli.ts'
import { cliContextWindow } from '../src/adapter.ts'
import { isImageAttachFailure } from '../src/session.ts'

const EXE = process.platform === 'win32' ? '.exe' : ''
const BASE = path.resolve('/machine')
const NPM_PREFIX = path.join(BASE, 'npm')
const APPDATA = path.join(BASE, 'appdata')
const QODER_CLI_HOME = path.join(BASE, 'home')
const DSH_HOME = path.join(BASE, 'dsh')
const RUNTIMES = path.join(DSH_HOME, 'dsh-runtimes')

/** A Node this process runs as, when it is Node and not Electron. */
const HOST_NODE = path.join(BASE, 'node', `node${EXE}`)
/** The Node DSH ships, which an install guarantees whatever `PATH` says. */
const RUNTIME_NODE = path.join(RUNTIMES, 'dsh-primary-runtime', 'dependencies', 'node', 'bin', `node${EXE}`)
/** An Electron binary: present, but not able to run a CLI script. */
const ELECTRON = path.join(BASE, 'DeepSeek Harness.exe')

const CN_PACKAGE = path.join(NPM_PREFIX, 'node_modules', '@qodercn-ai', 'qoderclicn')
const CN_BUNDLE = path.join(CN_PACKAGE, 'bundle', 'qoderclicn.js')
const INTL_BUNDLE = path.join(NPM_PREFIX, 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js')
const NATIVE = path.join(QODER_CLI_HOME, '.qoder-cn', 'local', `qoderclicn${EXE}`)
const WORKER = path.join(BASE, 'worker', 'qoderclicn-worker-runtime.mjs')

const ENV: NodeJS.ProcessEnv = {
  NPM_CONFIG_PREFIX: NPM_PREFIX,
  APPDATA,
  QODER_CLI_HOME,
  DSH_HOME,
  PATH: '',
}

/** The switch a spawned CLI is handed so its usage frames carry real tokens. */
const EXPOSED_USAGE: NodeJS.ProcessEnv = {
  QODERCN_EXPOSE_TOKEN_USAGE: '1',
  QODER_EXPOSE_TOKEN_USAGE: '1',
}

/** A machine holding exactly these files, seen through the lookup's own eyes. */
function machine(files: readonly string[], overrides: Partial<CliLookup> = {}): CliLookup {
  const present = new Set(files.map(file => path.normalize(file)))
  return {
    env: { ...ENV },
    exists: candidate => present.has(path.normalize(candidate)),
    readdir: () => [],
    execPath: HOST_NODE,
    electron: false,
    ...overrides,
  }
}

/** The same machine, but for the environment variable a case needs to set. */
function withEnv(plus: NodeJS.ProcessEnv, files: readonly string[], overrides: Partial<CliLookup> = {}): CliLookup {
  return machine(files, { ...overrides, env: { ...ENV, ...plus } })
}

describe('qoder CLI lookup', () => {
  it('takes an explicit QODERCLI_PATH before anything it could find itself', () => {
    const custom = path.join(BASE, 'custom', 'qoderclicn.js')
    const lookup = withEnv({ QODERCLI_PATH: custom }, [custom, CN_BUNDLE])
    expect(resolveQoderCli('cn', lookup)?.path).toBe(custom)
  })

  it('answers a native build with a path and no interpreter', () => {
    expect(resolveQoderCli('cn', machine([NATIVE]))).toEqual({ path: NATIVE })
    // Nothing to prepend to PATH: the binary is its own entry point. The
    // environment still rides along, because the metering switch does.
    expect(qoderCliOptions('cn', machine([NATIVE]))).toEqual({
      pathToQoderCLIExecutable: NATIVE,
      env: { ...process.env, ...EXPOSED_USAGE },
    })
  })

  it('pairs an installed script with the Node that runs it', () => {
    const lookup = machine([CN_BUNDLE])
    expect(resolveQoderCli('cn', lookup)).toEqual({ path: CN_BUNDLE, nodeDir: path.dirname(HOST_NODE) })

    const options = qoderCliOptions('cn', lookup)
    expect(options.pathToQoderCLIExecutable).toBe(CN_BUNDLE)
    expect(options.executable).toBe('node')
    // The SDK reads `env` as the child's whole environment, not as a delta: the
    // interpreter's directory must be prepended to the environment the CLI
    // inherits, never take its place.
    const prefix = `${path.dirname(HOST_NODE)}${path.delimiter}`
    expect(options.env).toEqual({ ...process.env, PATH: `${prefix}${process.env.PATH ?? ''}`, ...EXPOSED_USAGE })
  })

  it('asks the CLI to report its real token metering', () => {
    // The CLI zeroes input/output and both cache buckets on every usage frame
    // unless this switch is set, which leaves the harness with estimates and a
    // structurally 0% cache hit. Both brand prefixes are set because either
    // package can answer the lookup.
    for (const lookup of [machine([CN_BUNDLE]), machine([NATIVE])]) {
      const options = qoderCliOptions('cn', lookup)
      expect(options.env?.QODERCN_EXPOSE_TOKEN_USAGE).toBe('1')
      expect(options.env?.QODER_EXPOSE_TOKEN_USAGE).toBe('1')
    }
    // A machine with no CLI keeps the SDK's default transport, which this
    // module cannot hand an environment to.
    expect(qoderCliOptions('cn', machine([]))).toEqual({})
  })

  it('keeps each edition on its own CLI and state directory', () => {
    // The intl brand finds its own package and native install root…
    expect(resolveQoderCli('global', machine([INTL_BUNDLE]))?.path).toBe(INTL_BUNDLE)
    const intlNative = path.join(QODER_CLI_HOME, '.qoder', 'local', `qodercli${EXE}`)
    expect(resolveQoderCli('global', machine([intlNative]))).toEqual({ path: intlNative })

    // …and never the other edition's, because that CLI answers with the other
    // account's credentials and protocol build.
    expect(resolveQoderCli('global', machine([CN_BUNDLE, NATIVE]))).toBeUndefined()
    expect(resolveQoderCli('cn', machine([INTL_BUNDLE, intlNative]))).toBeUndefined()
  })

  it('never lends the CN CLI override to the international route', () => {
    // `QODERCLI_PATH` predates the intl edition and is set globally by some CN
    // installs. Both SDKs read it from the parent process before any option, so
    // the lookup must refuse it for the other brand — and the caller must be
    // able to explain why the brand has no usable CLI.
    const cnOnly = withEnv({ QODERCLI_PATH: CN_BUNDLE }, [CN_BUNDLE])
    expect(resolveQoderCli('global', cnOnly)).toBeUndefined()
    expect(foreignCliOverride('global', cnOnly)).toBe(CN_BUNDLE)
    expect(foreignCliOverride('cn', cnOnly)).toBeUndefined()

    // With an intl build of its own, the foreign override is ignored and the
    // brand's own CLI wins.
    const both = withEnv({ QODERCLI_PATH: CN_BUNDLE }, [CN_BUNDLE, INTL_BUNDLE])
    expect(resolveQoderCli('global', both)?.path).toBe(INTL_BUNDLE)
    expect(foreignCliOverride('global', both)).toBeUndefined()
    // The explicit option wins over the SDK's own QODERCLI_PATH lookup, which
    // would otherwise still resolve to the CN CLI.
    expect(qoderCliOptions('global', both).pathToQoderCLIExecutable).toBe(INTL_BUNDLE)
  })

  it('honours brand-specific CLI overrides', () => {
    const custom = path.join(BASE, 'custom', 'qodercli.js')
    const lookup = withEnv({ QODER_CLI_PATH: custom }, [custom])
    expect(resolveQoderCli('global', lookup)?.path).toBe(custom)
    expect(resolveQoderCli('cn', lookup)).toBeUndefined()

    const cnCustom = path.join(BASE, 'custom', 'qoderclicn.js')
    const cnLookup = withEnv({ QODERCN_CLI_PATH: cnCustom }, [cnCustom])
    expect(resolveQoderCli('cn', cnLookup)?.path).toBe(cnCustom)
    expect(resolveQoderCli('global', cnLookup)).toBeUndefined()
  })

  it('prefers a real Node over DSH\'s shipped one', () => {
    const lookup = machine([CN_BUNDLE, HOST_NODE, RUNTIME_NODE])
    expect(resolveQoderCli('cn', lookup)?.nodeDir).toBe(path.dirname(HOST_NODE))
  })

  it('falls back to DSH\'s shipped runtime when the host is Electron', () => {
    const lookup = machine([CN_BUNDLE, RUNTIME_NODE], {
      execPath: ELECTRON,
      electron: true,
      readdir: dir => (path.normalize(dir) === path.normalize(RUNTIMES) ? ['dsh-primary-runtime'] : []),
    })
    expect(resolveQoderCli('cn', lookup)).toEqual({ path: CN_BUNDLE, nodeDir: path.dirname(RUNTIME_NODE) })
  })

  it('falls back to PATH when neither the host nor DSH offers a Node', () => {
    const bin = path.join(BASE, 'usr', 'bin')
    const lookup = machine([CN_BUNDLE, path.join(bin, `node${EXE}`)], {
      execPath: ELECTRON,
      electron: true,
      env: { ...ENV, PATH: bin },
    })
    expect(resolveQoderCli('cn', lookup)).toEqual({ path: CN_BUNDLE, nodeDir: bin })
  })

  it('skips the worker runtime the SDK would answer in-process', () => {
    // Alone it is unusable: the SDK would run it on a thread inside DSH, which
    // is the transport that fails every image turn.
    expect(resolveQoderCli('cn', withEnv({ QODERCLI_PATH: WORKER }, [WORKER]))).toBeUndefined()

    // Alongside a spawnable build, the build wins.
    const lookup = withEnv({ QODERCLI_PATH: WORKER }, [WORKER, CN_BUNDLE])
    expect(resolveQoderCli('cn', lookup)?.path).toBe(CN_BUNDLE)
    expect(qoderCliOptions('cn', machine([WORKER]))).toEqual({})
  })

  it('drops a script it has no interpreter for rather than only half-answering', () => {
    const lookup = machine([CN_BUNDLE], { execPath: ELECTRON, electron: true })
    expect(resolveQoderCli('cn', lookup)).toBeUndefined()
    expect(qoderCliOptions('cn', lookup)).toEqual({})
  })

  it('finds nothing on a bare machine, leaving the SDK\'s default transport', () => {
    expect(resolveQoderCli('cn', machine([]))).toBeUndefined()
    expect(resolveQoderCli('global', machine([]))).toBeUndefined()
    expect(qoderCliOptions('cn', machine([]))).toEqual({})
    expect(qoderCliOptions('global', machine([]))).toEqual({})
  })
})

describe('image attach failure', () => {
  it('recognizes the CLI refusing image bytes', () => {
    // The sentence the CLI shows, its reason code, and the libvips line under it.
    expect(isImageAttachFailure(
      'error_during_execution ["Unable to attach image because it could not be decoded completely or read from its source.'
      + ' Export the original image as a new JPEG or PNG file and try again. Image processing error:'
      + ' Invalid or unsupported image data: colourspace: parameter space not set"]',
    )).toBe(true)
    expect(isImageAttachFailure('error_during_execution image_processing_failed')).toBe(true)
    expect(isImageAttachFailure('Invalid or unsupported image data')).toBe(true)
  })

  it('leaves every other turn failure alone', () => {
    const others = [
      '',
      'error_during_execution []',
      'error_max_turns',
      'Prompt is too long',
      'Rate limit exceeded',
      'Unable to attach file because it does not exist',
    ]
    for (const detail of others) expect(isImageAttachFailure(detail)).toBe(false)
  })
})

/**
 * The window the CLI runs with, which the context ratio is a fraction of.
 *
 * The CLI honours a requested window only when the model advertises it and
 * keeps its own default otherwise. Getting this wrong inflates every token
 * reading by the ratio of the two windows, so the rule is pinned here.
 */
describe('cli context window', () => {
  const withWindows = (available?: readonly number[], fallback: { defaultContextWindow?: number, maxInputTokens?: number } = {}) => ({
    ...fallback,
    ...available === undefined ? {} : { availableContextWindows: available },
  })

  it('keeps a declared window the model advertises', () => {
    expect(cliContextWindow(withWindows([200_000, 400_000, 1_000_000], { defaultContextWindow: 200_000 }), 1_000_000))
      .toBe(1_000_000)
    expect(cliContextWindow(withWindows([200_000, 400_000, 1_000_000], { defaultContextWindow: 200_000 }), 400_000))
      .toBe(400_000)
  })

  it('falls back to the model\'s own window when the declared one is not advertised', () => {
    // The reported bug: a 1M declaration on a 200K-only model. The CLI ignores
    // it, so multiplying its ratio by 1M read five times too high.
    expect(cliContextWindow(withWindows([200_000], { defaultContextWindow: 200_000 }), 1_000_000))
      .toBe(200_000)
    // A declared window below every advertised one is equally unhonoured.
    expect(cliContextWindow(withWindows([200_000, 1_000_000], { defaultContextWindow: 200_000 }), 150_000))
      .toBe(200_000)
  })

  it('answers nothing when the catalog said nothing, rather than guessing', () => {
    expect(cliContextWindow(undefined, 1_000_000)).toBeUndefined()
    expect(cliContextWindow({}, 1_000_000)).toBeUndefined()
  })

  it('prefers the declared default and the largest advertised window as fallbacks', () => {
    expect(cliContextWindow(withWindows(undefined, { defaultContextWindow: 200_000 }), 1_000_000)).toBe(200_000)
    expect(cliContextWindow(withWindows([200_000, 400_000]), 1_000_000)).toBe(400_000)
    expect(cliContextWindow(withWindows(undefined, { maxInputTokens: 180_000 }), 1_000_000)).toBe(180_000)
  })
})
