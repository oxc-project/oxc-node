export const self: string = import.meta.url;
export const missing: string = import.meta.resolve('./nope.js');
export const missingUrl: string = import.meta.resolve('file:///definitely/missing.ts');
export const main: unknown = import.meta.main;
export const hasMain: boolean = Object.hasOwn(import.meta, 'main');
