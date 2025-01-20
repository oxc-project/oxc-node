import assert from 'node:assert'
import test from 'node:test'

import { EntryType } from '@napi-rs/tar'
import { bar as subBar } from '@subdirectory/bar'
import { supportedExtensions } from 'file-type'
import { renderToString } from 'react-dom/server'
import { simpleGit } from 'simple-git'

import { CompiledClass } from './compiled'
import { common } from './common.cjs'
import { foo } from './foo'
import { bar } from './subdirectory/bar'
import { baz } from './subdirectory/index'
import { Component } from './component'
import './js-module'
import babelGeneratedDoubleDefault from './babel-generated-double-default'
import { exportFromMts } from './enforce-mts/index.mjs'
const { foo: fooWithQuery } = await import(`./foo.js?q=${Date.now()}`)

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
  assert.equal(EntryType.GNUSparse, 10)
})

await test('resolve simple-git', () => {
  assert.ok(simpleGit)
})

await test('import default from babel-generated cjs file', () => {
  assert.equal(babelGeneratedDoubleDefault.default(), 'default.default')
})

await test('resolve cjs in type module package', () => {
  assert.equal(common, 'common')
})

await test('resolve mts in type commonjs package', () => {
  assert.equal(exportFromMts, 'exportFromMts')
})
