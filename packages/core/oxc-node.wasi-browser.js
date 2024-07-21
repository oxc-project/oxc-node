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
  __napiInstance.exports['__napi_register__init_tracing_0']?.()
  __napiInstance.exports['__napi_register__Output_struct_1']?.()
  __napiInstance.exports['__napi_register__Output_impl_4']?.()
  __napiInstance.exports['__napi_register__transform_5']?.()
  __napiInstance.exports['__napi_register__TransformTask_impl_6']?.()
  __napiInstance.exports['__napi_register__transform_async_7']?.()
  __napiInstance.exports['__napi_register__ResolveContext_struct_8']?.()
  __napiInstance.exports['__napi_register__ResolveFnOutput_struct_9']?.()
  __napiInstance.exports['__napi_register__OxcResolveOptions_struct_10']?.()
  __napiInstance.exports['__napi_register__create_resolve_11']?.()
  __napiInstance.exports['__napi_register__LoadContext_struct_12']?.()
  __napiInstance.exports['__napi_register__LoadFnOutput_struct_13']?.()
  __napiInstance.exports['__napi_register__load_14']?.()
}
export const Output = __napiModule.exports.Output
export const createResolve = __napiModule.exports.createResolve
export const initTracing = __napiModule.exports.initTracing
export const load = __napiModule.exports.load
export const transform = __napiModule.exports.transform
export const transformAsync = __napiModule.exports.transformAsync
