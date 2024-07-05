import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('@oxc/node-core/esm', pathToFileURL('./').toString())
