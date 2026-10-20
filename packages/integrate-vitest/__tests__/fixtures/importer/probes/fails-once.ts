const g = globalThis as { __probeFailed?: boolean };
if (!g.__probeFailed) {
  g.__probeFailed = true;
  throw new Error('first-run');
}
export const ok: boolean = true;
