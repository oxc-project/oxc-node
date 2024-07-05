import { load, resolve as oxcResolve } from './index.js'

const resolve = async (request, context, next) => {
  const result = await oxcResolve(request, context, next)
  result.shortCircuit = true
  return result
}

export { load, resolve }
