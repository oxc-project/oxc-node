// import 'core-js/modules/esnext.symbol.async-dispose'
// import 'core-js/modules/esnext.symbol.dispose'

import assert from 'node:assert'
// import { createRequire } from 'node:module'
import test from 'node:test'

// import { EntryType } from '@napi-rs/tar'
// import { bar as subBar } from '@subdirectory/bar'
// import { supportedExtensions } from 'file-type'
// import { renderToString } from 'react-dom/server'
// import { simpleGit } from 'simple-git'

// import { common } from './common.cjs'
// import { CompiledClass } from './compiled'
// import { Component } from './component'
import { condition } from 'condition-dev'
// import { foo } from './foo'
// import { bar } from './subdirectory/bar'
// import { baz } from './subdirectory/index'
// import './js-module'
// import babelGeneratedDoubleDefault from './babel-generated-double-default'
// import { exportFromMts } from './enforce-mts/index.mjs'
// import { AppService } from './nestjs/app.service'
// import { bootstrap } from './nestjs/index'

// const { foo: fooWithQuery } = await import(`./foo.js?q=${Date.now()}`)

// await test('file-type should work', () => {
//   assert.ok(supportedExtensions.has('jpg'))
// })

// await test('resolve adjacent file path', () => {
//   assert.equal(foo(), 'foo')
// })

// await test('resolve nested file path', () => {
//   assert.equal(bar(), 'bar')
// })

// await test('resolve nested entry point', () => {
//   assert.equal(baz(), 'baz')
// })

// await test('resolve paths', () => {
//   assert.equal(subBar(), 'bar')
// })

// await test('resolve with query', () => {
//   assert.equal(fooWithQuery(), 'foo')
// })

// await test('compiled js file with .d.ts', () => {
//   const instance = new CompiledClass()
//   assert.equal(instance.name, 'CompiledClass')
// })

// await test('jsx should work', () => {
//   assert.equal(renderToString(Component()), '<div>Component</div>')
// })

// await test('resolve @napi-rs projects', () => {
//   assert.equal(EntryType.GNUSparse, 10)
// })

// await test('resolve simple-git', () => {
//   assert.ok(simpleGit)
// })

// await test('import default from babel-generated cjs file', () => {
//   assert.equal(babelGeneratedDoubleDefault.default(), 'default.default')
// })

// await test('resolve cjs in type module package', () => {
//   assert.equal(common, 'common')
// })

// await test('resolve mts in type commonjs package', () => {
//   assert.equal(exportFromMts, 'exportFromMts')
// })

// await test('resolve nestjs', async () => {
//   const { app } = await bootstrap()
//   const service = app.get(AppService)
//   assert.equal(service.getHello(), 'Hello World!')
//   assert.equal(service.websocket.port, 3001)
//   await app.close()
// })

// await test('using syntax', async () => {
//   await using nest = await bootstrap()
//   const service = nest.app.get(AppService)
//   assert.equal(service.getHello(), 'Hello World!')
// })

await test('resolve correct condition', () => {
  assert.equal(condition, 'dev')
})

// if (!process.versions.node.startsWith('18')) {
//   await test('resolve typescript cjs', () => {
//     const require = createRequire(import.meta.url)
//     const fooCjs = require('./typescript-cjs').foo
//     assert.equal(fooCjs, 'foo')
//   })
// }
