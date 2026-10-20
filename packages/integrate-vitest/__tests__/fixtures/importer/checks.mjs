// jiti v2 parity checks for `@oxc-node/core/importer`, shared by host.mjs and host.cjs.
// Real jiti 2.7.0 passes 57 of the 64 graded checks; `info-*` rows are not graded.
// Adapter contract: export function create(parentId, options) -> { import(id, opts), resolve?(id, opts) }
import { createRequire } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT = path.join(ROOT, 'project');
const ELSEWHERE = path.join(ROOT, 'elsewhere');
const req = createRequire(import.meta.url);
const NOT_FOUND = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
const CHECK_TIMEOUT_MS = 5000;

const short = (v) => {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 300 ? s.slice(0, 300) + '...' : s;
  } catch {
    return String(v);
  }
};
const errInfo = (e) => (e && typeof e === 'object' ? `${e.code ?? e.name}: ${String(e.message).split('\n')[0]}` : String(e));
const fileUrl = (p) => pathToFileURL(p).href;
const toPath = (r) => (typeof r === 'string' && r.startsWith('file:') ? fileURLToPath(r) : r instanceof URL ? fileURLToPath(r) : r);

// ---------- global leak probe (run BEFORE loading the adapter and AFTER all checks) ----------
async function tryIt(fn) {
  try {
    await fn();
    return 'LOADED';
  } catch (e) {
    return e?.code ?? e?.name ?? 'ERROR';
  }
}
export async function probeGlobals(tag) {
  return {
    importEnum: await tryIt(() => import(fileUrl(path.join(ELSEWHERE, `enum-${tag}.ts`)))),
    importExtless: await tryIt(() => import(fileUrl(path.join(ELSEWHERE, `ext-${tag}.ts`)))),
    requireEnum: await tryIt(() => req(path.join(ELSEWHERE, 'cjs', `enum-${tag}.ts`))),
    extKeys: Object.keys(req.extensions).join(','),
    extTs: req.extensions['.ts'],
    extJs: req.extensions['.js'],
    resolveFilename: Module._resolveFilename,
    compile: Module.prototype._compile,
    load: Module._load,
  };
}

// ---------- runner ----------
export async function runChecks({ host, parentId, adapter, before, emit = (r) => console.log(JSON.stringify(r)) }) {
  const results = [];
  const rel = (p) => './' + path.relative(path.dirname(toPath(parentId)), p).split(path.sep).join('/');
  const P = (...s) => rel(path.join(PROJECT, ...s));
  const make = (opts, parent = parentId) => adapter.create(parent, opts);
  const def = make();

  async function check(name, fn) {
    let r;
    try {
      let timer;
      const out = await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timeout ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS))),
      ]);
      clearTimeout(timer);
      r = { check: name, ok: out.ok, detail: out.detail ?? '' };
    } catch (e) {
      r = { check: name, ok: false, detail: 'threw ' + errInfo(e) };
    }
    results.push(r);
    emit(r);
  }
  const eq = (got, want) => ({ ok: isDeepStrictEqual(got, want), detail: `got ${short(got)}` + (isDeepStrictEqual(got, want) ? '' : ` want ${short(want)}`) });
  const D = { default: true };
  const rejects = async (p, pred) => {
    try {
      const v = await p;
      return { ok: false, detail: 'resolved ' + short(v) };
    } catch (e) {
      return { ok: pred(e), detail: errInfo(e) };
    }
  };

  // ---- 1. transforms / features ----
  await check('feat-enum', async () => eq(await def.import(P('features/enum.ts'), D), { green: 2, red: 'Red', sizeS: 's' }));
  await check('feat-decorator-legacy', async () => {
    const m = await def.import(P('features/decorator.ts'), D);
    return eq({ method: m.method, tagged: m.tagged, key: m.seen.methodKey }, { method: 'decorated', tagged: true, key: 'method' });
  });
  // tsc experimentalDecorators passes the real PropertyDescriptor as the 3rd argument
  await check('feat-decorator-descriptor', async () => eq((await def.import(P('features/decorator.ts'), D)).seen.hasDescriptor, true));
  await check('feat-tsconfig-paths', async () => eq(await def.import(P('features/alias.ts'), D), 'from-alias'));
  await check('feat-extensionless', async () => eq(await def.import(P('features/extensionless.ts'), D), 'extensionless'));
  await check('feat-json-import', async () => eq(await def.import(P('features/json.ts'), D), { name: 'json-data', n: 5 }));
  await check('feat-json-import-attr', async () => eq(await def.import(P('features/json-attr.ts'), D), { name: 'json-data', n: 5 }));
  await check('feat-json-direct', async () => eq(await def.import(P('src/data.json'), D), { name: 'json-data', n: 5 }));
  await check('feat-tla', async () => eq(await def.import(P('features/tla.ts'), D), 42));
  await check('feat-cts-import', async () => eq(await def.import(P('features/cts.ts'), D), 'cts:3'));
  await check('feat-cts-direct', async () => eq((await def.import(P('src/helper.cts'), D)).helper(4), 'cts:4'));
  await check('feat-mts-import', async () => eq(await def.import(P('features/mts.ts'), D), 'mts'));
  await check('feat-mts-direct', async () => eq((await def.import(P('src/esm-helper.mts'))).mts, 'mts'));
  await check('feat-tsx-ext', async () => eq(await def.import(P('features/tsx.ts'), D), 'tsx'));
  await check('feat-tsx-jsx-factory', async () => eq(await def.import(P('features/jsx.ts'), D), { tag: 'div', props: { id: 'x' }, children: ['hi'] }));
  await check('feat-cjs-no-type-pkg', async () => eq(await def.import(P('features/cjs-pkg.ts'), D), 7));
  await check('feat-cjs-direct', async () => eq((await def.import(P('pkg-cjs/index.ts'), D)).cjsValue, 7));
  await check('feat-export-default-fn', async () => {
    const f = await def.import(P('features/export-default-fn.ts'), D);
    return eq(typeof f === 'function' ? f() : typeof f, 'fn');
  });
  await check('feat-eslint-config', async () => {
    const rules = await def.import(P('eslint.config.ts'), D);
    const got = Array.isArray(rules) ? Object.fromEntries(rules.map((r) => [r.name, r.value])) : rules;
    return eq(got, {
      enum: 2, constEnum: 's', decorator: 'decorated', decoratorKey: 'method', decoratorClass: true,
      alias: 'from-alias', extensionless: 'extensionless', json: 'json-data', tla: 42, cts: 'cts:3', cjsPkg: 7,
    });
  });

  // ---- 2. default interop ----
  await check('interop-call-default', async () => eq(await def.import(P('interop/default-only.ts'), D), { a: 1 }));
  await check('interop-call-default-fallback', async () => eq((await def.import(P('interop/named-only.ts'), D)).n, 3));
  await check('interop-call-default-primitive', async () => eq(await def.import(P('interop/primitive.ts'), D), 'str'));
  await check('interop-call-default-fn', async () => {
    const f = await def.import(P('interop/fn.ts'), D);
    return eq(typeof f === 'function' ? f() : typeof f, 'called');
  });
  await check('interop-on-merges-default-props', async () => {
    const m = await def.import(P('interop/default-only.ts'));
    return eq({ a: m.a, defaultA: m.default?.a }, { a: 1, defaultA: 1 });
  });
  await check('interop-on-mixed', async () => {
    const m = await def.import(P('interop/mixed.ts'));
    return eq({ a: m.a, b: m.b, defaultA: m.default?.a }, { a: 1, b: 2, defaultA: 1 });
  });
  await check('interop-on-fn-extra', async () => {
    const m = await def.import(P('interop/fn.ts'));
    return eq({ extra: m.extra, def: typeof m.default }, { extra: 9, def: 'function' });
  });
  await check('interop-off-plain-namespace', async () => {
    const m = await make({ interopDefault: false }).import(P('interop/default-only.ts'));
    return eq({ a: m.a, defaultA: m.default?.a }, { a: undefined, defaultA: 1 });
  });
  await check('interop-off-call-default', async () => eq(await make({ interopDefault: false }).import(P('interop/default-only.ts'), D), { a: 1 }));

  // ---- 3. module cache ----
  const runsDir = path.join(PROJECT, '_runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const madeDirs = [];
  const copyTemplate = (variant) => {
    const dir = path.join(runsDir, `${host}-${process.pid}-${variant}`);
    madeDirs.push(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    for (const f of ['root.ts', 'dep.ts'])
      fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(PROJECT, 'cache-template', f), 'utf8').replace('__KEY__', dir));
    return dir;
  };
  const editDep = (dir) => {
    const f = path.join(dir, 'dep.ts');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("'v1'", "'v2-edited'"));
    const t = new Date(Date.now() + 2000);
    fs.utimesSync(f, t, t); // avoid same-mtime false negatives in a fast test
  };
  const counts = (dir) => ({ ...(globalThis.__jlCount?.[dir] ?? { root: 0, dep: 0 }) });

  {
    const dir = copyTemplate('nocache');
    const j = make({ moduleCache: false });
    const id = rel(path.join(dir, 'root.ts'));
    let first, second, nm1, nm2, err;
    try {
      first = await j.import(id);
      nm1 = globalThis.__jlNm;
      editDep(dir);
      second = await j.import(id);
      nm2 = globalThis.__jlNm;
    } catch (e) {
      err = e;
    }
    const c = counts(dir);
    const ifErr = (o) => (err ? { ok: false, detail: 'threw ' + errInfo(err) } : o);
    await check('cache-false-root-reruns', async () => ifErr(eq(c.root, 2)));
    await check('cache-false-dep-reruns', async () => ifErr(eq(c.dep, 2)));
    await check('cache-false-dep-edit-seen', async () => ifErr(eq([first?.value, second?.value], ['v1', 'v2-edited'])));
    await check('info-cache-false-node-modules', async () => ({ ok: true, detail: err ? 'n/a' : nm1 === nm2 ? 'node_modules dep stayed cached' : `node_modules dep re-ran (${nm1}->${nm2})` }));
    await check('cache-false-new-module-object', async () => ifErr({ ok: first !== second, detail: first === second ? 'same object' : 'different objects' }));
  }
  {
    const dir = copyTemplate('cache');
    const j = make({ moduleCache: true });
    const id = rel(path.join(dir, 'root.ts'));
    let first, second, err;
    try {
      first = await j.import(id);
      editDep(dir);
      second = await j.import(id);
    } catch (e) {
      err = e;
    }
    const c = counts(dir);
    const ifErr = (o) => (err ? { ok: false, detail: 'threw ' + errInfo(err) } : o);
    await check('cache-true-root-cached', async () => ifErr(eq(c.root, 1)));
    await check('cache-true-dep-cached', async () => ifErr(eq(c.dep, 1)));
    await check('cache-true-edit-not-seen', async () => ifErr(eq([first?.value, second?.value], ['v1', 'v1'])));
    await check('info-cache-true-same-object', async () => ({ ok: true, detail: err ? 'n/a' : first === second ? 'same object' : 'different objects' }));
  }
  {
    // default options must behave as moduleCache:true
    const dir = copyTemplate('default');
    const id = rel(path.join(dir, 'root.ts'));
    await check('cache-default-is-true', async () => {
      await def.import(id);
      await def.import(id);
      return eq(counts(dir).root, 1);
    });
  }

  // ---- 4. import.meta ----
  const metaFile = path.join(PROJECT, 'features/meta.ts');
  await check('meta-url-clean', async () => eq((await def.import(P('features/meta.ts'))).url, fileUrl(metaFile)));
  await check('meta-filename-dirname', async () => {
    const m = await def.import(P('features/meta.ts'));
    return eq([m.filename, m.dirname], [metaFile, path.dirname(metaFile)]);
  });
  await check('meta-url-eslint-config', async () => eq((await def.import(P('eslint.config.ts'))).metaUrl, fileUrl(path.join(PROJECT, 'eslint.config.ts'))));

  // ---- 5. errors and try ----
  await check('err-missing-file', async () => rejects(def.import(P('does-not-exist.ts')), (e) => NOT_FOUND.has(e?.code)));
  await check('err-missing-inner-import', async () =>
    rejects(def.import(P('errors/imports-missing.ts')), (e) => NOT_FOUND.has(e?.code) && String(e.message).includes('really-not-here')));
  await check('err-syntax-useful', async () =>
    rejects(def.import(P('errors/syntax.ts')), (e) => e instanceof Error && /syntax\.ts/.test(`${e.message}\n${e.stack}`)));
  await check('err-runtime-throw', async () => rejects(def.import(P('errors/throws.ts')), (e) => e?.message === 'boom-from-fixture'));
  await check('try-missing-undefined', async () => eq(await def.import(P('does-not-exist.ts'), { try: true }), undefined));
  await check('try-existing-loads', async () => eq((await def.import(P('src/other.ts'), { try: true }))?.other, 'extensionless'));

  // ---- 6. per-call / factory options ----
  await check('opt-parentURL', async () =>
    eq((await def.import('./other.ts', { parentURL: fileUrl(path.join(PROJECT, 'src', 'index.ts')) }))?.other, 'extensionless'));
  await check('opt-conditions', async () =>
    eq(await make(undefined, path.join(PROJECT, 'eslint.config.ts')).import('cond-dep', { conditions: ['jl-custom', 'import', 'node', 'default'], default: true }), 'custom'));
  await check('opt-no-conditions-default', async () =>
    eq(await make(undefined, path.join(PROJECT, 'eslint.config.ts')).import('cond-dep', { default: true }), 'default'));
  const hostPath = toPath(parentId);
  await check('parent-as-path', async () => eq((await make(undefined, hostPath).import(P('src/other.ts')))?.other, 'extensionless'));
  await check('parent-as-url-string', async () => eq((await make(undefined, fileUrl(hostPath)).import(P('src/other.ts')))?.other, 'extensionless'));
  await check('parent-as-URL-object', async () => eq((await make(undefined, pathToFileURL(hostPath)).import(P('src/other.ts')))?.other, 'extensionless'));
  await check('import-absolute-path', async () => eq((await def.import(path.join(PROJECT, 'src/other.ts')))?.other, 'extensionless'));
  await check('import-file-url', async () => eq((await def.import(fileUrl(path.join(PROJECT, 'src/other.ts'))))?.other, 'extensionless'));

  // ---- 7. resolve (optional API) ----
  if (typeof def.resolve === 'function') {
    const inProject = make(undefined, path.join(PROJECT, 'eslint.config.ts'));
    await check('resolve-extensionless', async () => eq(toPath(await def.resolve(P('src/other'))), path.join(PROJECT, 'src/other.ts')));
    await check('resolve-tsconfig-paths', async () => eq(toPath(await inProject.resolve('@lib/util')), path.join(PROJECT, 'lib/util.ts')));
    await check('resolve-try-missing', async () => eq(await def.resolve(P('nope'), { try: true }), undefined));
    await check('resolve-missing-throws', async () => {
      try {
        return { ok: false, detail: 'returned ' + short(await def.resolve(P('nope'))) };
      } catch (e) {
        return { ok: NOT_FOUND.has(e?.code), detail: errInfo(e) };
      }
    });
  } else {
    await check('resolve-api-present', async () => ({ ok: false, detail: 'adapter instance has no resolve()' }));
  }

  // ---- 8. nothing global left installed ----
  const after = await probeGlobals('after');
  const same = (k) => ({ ok: before[k] === after[k], detail: `before ${short(before[k] === undefined ? 'undefined' : typeof before[k] === 'function' ? before[k].name || 'fn' : before[k])}, after ${short(typeof after[k] === 'function' ? (after[k] === before[k] ? 'same fn' : 'CHANGED fn ' + (after[k].name || '')) : after[k] === undefined ? 'undefined' : after[k])}` });
  await check('leak-plain-import-enum', async () => ({ ...same('importEnum'), ok: before.importEnum === after.importEnum && after.importEnum !== 'LOADED' }));
  await check('leak-plain-import-extensionless', async () => ({ ...same('importExtless'), ok: before.importExtless === after.importExtless && after.importExtless !== 'LOADED' }));
  await check('leak-plain-require-enum', async () => ({ ...same('requireEnum'), ok: before.requireEnum === after.requireEnum && after.requireEnum !== 'LOADED' }));
  await check('leak-require-extensions-keys', async () => same('extKeys'));
  await check('leak-require-extensions-ts', async () => same('extTs'));
  await check('leak-require-extensions-js', async () => same('extJs'));
  await check('leak-module-internals', async () => {
    const changed = ['resolveFilename', 'compile', 'load'].filter((k) => before[k] !== after[k]);
    return { ok: changed.length === 0, detail: changed.length ? 'changed: ' + changed.join(',') : 'unchanged' };
  });

  for (const d of madeDirs) fs.rmSync(d, { recursive: true, force: true });
  try { fs.rmdirSync(runsDir); } catch {}
  return results;
}
