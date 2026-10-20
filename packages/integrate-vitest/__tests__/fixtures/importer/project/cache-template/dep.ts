const g = globalThis as any;
const k: string = __KEY__;
g.__jlCount ??= {};
g.__jlCount[k] ??= { root: 0, dep: 0 };
g.__jlCount[k].dep++;
export const dep: string = 'v1';
