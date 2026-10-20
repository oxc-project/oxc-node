export async function later() { const m = await import('./lazy-enum.ts'); return m.v; }
export async function laterExt() { const m = await import('./lazy-ext'); return m.w; }
