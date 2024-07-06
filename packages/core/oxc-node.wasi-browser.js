import {
  instantiateNapiModuleSync as __emnapiInstantiateNapiModuleSync,
  getDefaultContext as __emnapiGetDefaultContext,
  WASI as __WASI,
  createOnMessage as __wasmCreateOnMessageForFsProxy,
} from '@napi-rs/wasm-runtime'

import __wasmUrl from './oxc-node.wasm32-wasi.wasm?url'

const __wasi = new __WASI({
  version: 'preview1',
})

const __emnapiContext = __emnapiGetDefaultContext()

const __sharedMemory = new WebAssembly.Memory({
  initial: 4000,
  maximum: 65536,
  shared: true,
})

const __wasmFile = await fetch(__wasmUrl).then((res) => res.arrayBuffer())

const {
  instance: __napiInstance,
  module: __wasiModule,
  napiModule: __napiModule,
} = __emnapiInstantiateNapiModuleSync(__wasmFile, {
  context: __emnapiContext,
  asyncWorkPoolSize: 4,
  wasi: __wasi,
  onCreateWorker() {
    const worker = new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url), {
      type: 'module',
    })
    
    return worker
  },
  overwriteImports(importObject) {
    importObject.env = {
      ...importObject.env,
      ...importObject.napi,
      ...importObject.emnapi,
      memory: __sharedMemory,
    }
    return importObject
  },
  beforeInit({ instance }) {
    __napi_rs_initialize_modules(instance)
  },
})

function __napi_rs_initialize_modules(__napiInstance) {
  __napiInstance.exports['__napi_register__Output_struct_0']?.()
  __napiInstance.exports['__napi_register__Output_impl_3']?.()
  __napiInstance.exports['__napi_register__ResolveContext_struct_4']?.()
  __napiInstance.exports['__napi_register__ResolveFnOutput_struct_5']?.()
  __napiInstance.exports['__napi_register__resolve_6']?.()
  __napiInstance.exports['__napi_register__LoadContext_struct_7']?.()
  __napiInstance.exports['__napi_register__LoadFnOutput_struct_8']?.()
  __napiInstance.exports['__napi_register__load_9']?.()
}
export const Output = __napiModule.exports.Output
export const load = __napiModule.exports.load
export const resolve = __napiModule.exports.resolve
