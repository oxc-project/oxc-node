// Top-level await has no CommonJS form, so this file stays an ES module where `tsc`
// would reject it.
// @ts-expect-error TS1309
export const answer: number = await Promise.resolve(42);
