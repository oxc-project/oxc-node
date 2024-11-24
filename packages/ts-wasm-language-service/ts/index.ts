import type tsserver from 'typescript/lib/tsserverlibrary'

import { getTypesFromWasm } from '../index.js'

function init({ typescript: ts }: { typescript: typeof tsserver }) {
  function create(info: tsserver.server.PluginCreateInfo) {
    // Set up decorator object
    const proxy: tsserver.LanguageService = Object.create(null)

    const readFile = ts.sys.readFile
    const fileExists = ts.sys.fileExists
    ts.sys.fileExists = (path) => {
      if (path.endsWith('.wasm.d.ts')) {
        return true
      }
      return fileExists.call(ts.sys, path)
    }
    ts.sys.readFile = (filename, encoding) => {
      info.project.log(`readFile: ${filename}`)
      if (filename.endsWith('.wasm.d.ts')) {
        const wasm = readFile.call(ts.sys, filename.slice(0, -5), encoding)
        return wasm ? getTypesFromWasm(wasm) : ''
      }
      return readFile.call(ts.sys, filename, encoding)
    }

    for (let k of Object.keys(info.languageService) as Array<keyof tsserver.LanguageService>) {
      const x = info.languageService[k]!
      if (k === 'getSemanticDiagnostics') {
        proxy[k] = (fileName) => {
          const diagnostics = (x as tsserver.LanguageService['getSemanticDiagnostics']).call(
            info.languageService,
            fileName,
          )
          return diagnostics.filter((diagnostic) => {
            if (diagnostic.code === 2307) {
              for (const statement of diagnostic.file?.statements ?? []) {
                if (statement.kind === ts.SyntaxKind.ImportDeclaration) {
                  return false
                }
              }
            }
            return diagnostic
          })
        }
      } else {
        // @ts-expect-error - JS runtime trickery which is tricky to type tersely
        proxy[k] = (...args: Array<{}>) => x.apply(info.languageService, args)
      }
    }

    return proxy
  }

  return { create }
}

export = init
