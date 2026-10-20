export const viaData = async (): Promise<number> =>
  (await import('data:text/javascript,export default 7')).default;
export const resolved: string = import.meta.resolve('data:text/javascript,1');
// A dynamic import's attributes reach Node.js.
export const viaJson = async (): Promise<number> =>
  (await import('data:application/json,{"a":1}', { with: { type: 'json' } })).default.a;
// A URL object is a specifier too.
export const resolvedUrl: string = import.meta.resolve(new URL('data:text/javascript,2') as unknown as string);
