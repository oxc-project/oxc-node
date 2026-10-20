// Waits until the probe lets it go, so that a require() comes while it waits.
await (globalThis as any).__releaseSlowTla;
export const slow: string = 'slow';
