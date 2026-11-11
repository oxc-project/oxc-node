// `import.meta` has no CommonJS form, so this file stays an ES module where `tsc`
// would reject it.
// @ts-expect-error TS1470
export const url: string = import.meta.url;
