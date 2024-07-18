import assert from 'node:assert'
import test from 'node:test'

import { RepositoryState } from '@napi-rs/simple-git'
import { transform } from '@oxc-node/core'
import { bar as subBar } from '@subdirectory/bar.mjs'
import { supportedExtensions } from 'file-type'
import { renderToString } from 'react-dom/server'
import { simpleGit } from 'simple-git'
import ipaddr from 'ipaddr.js'
import postgres from 'postgres'
import canvaskit from 'canvaskit-wasm'

import { CompiledClass } from './compiled.js'
import { foo } from './foo.mjs'
import { bar } from './subdirectory/bar.mjs'
import { baz } from './subdirectory/index.mjs'
import { Component } from './component.js'
import './js-module.mjs'
import pkgJson from '../package.json'
import { version } from '../package.json'

const { foo: fooWithQuery } = await import(`./foo.mjs?q=${Date.now()}`)

await test('file-type should work', () => {
  assert.ok(supportedExtensions.has('jpg'))
})

await test('resolve adjacent file path', () => {
  assert.equal(foo(), 'foo')
})

await test('resolve nested file path', () => {
  assert.equal(bar(), 'bar')
})

await test('resolve nested entry point', () => {
  assert.equal(baz(), 'baz')
})

await test('resolve paths', () => {
  assert.equal(subBar(), 'bar')
})

await test('resolve with query', () => {
  assert.equal(fooWithQuery(), 'foo')
})

await test('compiled js file with .d.ts', () => {
  const instance = new CompiledClass()
  assert.equal(instance.name, 'CompiledClass')
})

await test('jsx should work', () => {
  assert.equal(renderToString(Component()), '<div>Component</div>')
})

await test('resolve @napi-rs projects', () => {
  assert.equal(RepositoryState.ApplyMailbox, 10)
})

await test('resolve simple-git', () => {
  assert.ok(simpleGit)
})

await test('resolve package.json', () => {
  assert.equal(pkgJson.name, 'integrate-module')
})

await test('named import from json', () => {
  assert.equal(version, '0.0.0')
})

await test('resolve ipaddr.js', () => {
  assert.ok(ipaddr.isValid('::1'))
})

await test('resolve postgres', () => {
  const sql = postgres()
  assert.ok(sql)
})

await test('resolve canvaskit-wasm', async () => {
  if (process.arch === 's390x') {
    assert.ok('skipping test on s390x')
    return
  }
  // @ts-expect-error
  const canvas = await canvaskit()
  assert.ok(canvas.MakeSurface(100, 100))
})

await test('should resolve native addon', async () => {
  const result = await transform('index.ts', 'const a: number = 1')
  assert.equal(result.source(), 'const a = 1;\n')
})
