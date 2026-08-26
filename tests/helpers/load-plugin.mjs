import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pluginPath = path.join(root, 'plugin.js')

function synthetic(context, identifier, values) {
  const names = Object.keys(values)
  return new vm.SyntheticModule(
    names,
    function initialise() {
      for (const name of names) this.setExport(name, values[name])
    },
    { context, identifier }
  )
}

// The desktop app injects the real `@hermes/plugin-sdk`. Under test we supply
// stubs for exactly the identifiers plugin.js imports — so a typo in an import
// (a ReferenceError at render time in the app) fails the suite instead.
const SDK_DEFAULTS = {
  cn: (...names) => names.filter(Boolean).join(' '),
  host: {
    state: {},
    request: async () => {
      throw new Error('host.request not stubbed')
    },
    onEvent: () => () => {}
  },
  queryClient: { invalidateQueries: () => {} },
  COMPOSER_AREAS: {
    top: 'composer.top',
    bottom: 'composer.bottom',
    underside: 'composer.underside',
    leading: 'composer.leading',
    actions: 'composer.actions'
  },
  STATUSBAR_AREAS: { left: 'statusBar.left', right: 'statusBar.right' },
  Tip: 'Tip',
  useQuery: () => ({ data: undefined }),
  useValue: () => null
}

const JSX_RUNTIME_DEFAULTS = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props })
}

export async function loadPlugin({ sdk = {}, react = {}, jsxRuntime = {} } = {}) {
  const source = await fs.readFile(pluginPath, 'utf8')
  const context = vm.createContext({
    AbortController,
    console,
    clearTimeout,
    setTimeout
  })
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: pluginPath
  })
  const modules = new Map([
    [
      '@hermes/plugin-sdk',
      synthetic(context, '@hermes/plugin-sdk', { ...SDK_DEFAULTS, ...sdk })
    ],
    ['react', synthetic(context, 'react', react)],
    [
      'react/jsx-runtime',
      synthetic(context, 'react/jsx-runtime', { ...JSX_RUNTIME_DEFAULTS, ...jsxRuntime })
    ]
  ])

  await module.link(async specifier => {
    const dependency = modules.get(specifier)
    if (!dependency) throw new Error(`Unexpected import: ${specifier}`)
    return dependency
  })
  await module.evaluate()
  return module.namespace
}
