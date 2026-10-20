// Usage: node host.cjs <path to @oxc-node/core/importer>
// Runs the jiti parity checks from a CommonJS host, which loads the importer with
// require() (require(esm)); prints one JSON line per check.
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const { probeGlobals, runChecks } = await import(pathToFileURL(path.join(__dirname, "checks.mjs")).href);
  const before = await probeGlobals("before");
  try {
    const { createImporter } = require(process.argv[2]);
    const adapter = { create: (parentId, options) => createImporter(parentId, options) };
    await runChecks({ host: "cjs", parentId: __filename, adapter, before });
  } catch (e) {
    console.log(JSON.stringify({ check: "fatal", ok: false, detail: String((e && e.stack) || e) }));
  }
  process.exit(0);
})();
