export const self: string = import.meta.url;
export const missing: string = import.meta.resolve('./nope.js');
export const missingUrl: string = import.meta.resolve('file:///definitely/missing.ts');
