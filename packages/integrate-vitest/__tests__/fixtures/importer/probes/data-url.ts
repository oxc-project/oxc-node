export const viaData = async (): Promise<number> =>
  (await import('data:text/javascript,export default 7')).default;
export const resolved: string = import.meta.resolve('data:text/javascript,1');
