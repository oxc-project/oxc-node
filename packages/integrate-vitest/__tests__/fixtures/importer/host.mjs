// Usage: node host.mjs <path to @oxc-node/core/importer>
// Runs the jiti parity checks from an ES module host; prints one JSON line per check.
import { pathToFileURL } from "node:url";
import { probeGlobals, runChecks } from "./checks.mjs";

const before = await probeGlobals("before"); // before the importer is even loaded
try {
  const { createImporter } = await import(pathToFileURL(process.argv[2]).href);
  const adapter = { create: (parentId, options) => createImporter(parentId, options) };
  await runChecks({ host: "esm", parentId: import.meta.url, adapter, before });
} catch (e) {
  console.log(JSON.stringify({ check: "fatal", ok: false, detail: String(e?.stack ?? e) }));
}
process.exit(0);
