export async function viaFn() { const f = new Function('return import("./ns.ts")'); return (await f()).z; }
