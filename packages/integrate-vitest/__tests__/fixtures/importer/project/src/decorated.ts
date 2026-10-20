// Legacy (experimentalDecorators) semantics: method decorator gets (target, key, descriptor).
export const seen: { classTagged?: boolean; methodKey?: unknown; hasDescriptor?: boolean } = {};
function tag(target: any): void { target.tagged = true; seen.classTagged = true; }
function log(target: any, key: any, desc?: PropertyDescriptor): any {
  seen.methodKey = key;
  seen.hasDescriptor = !!desc && typeof desc.value === 'function';
  return desc;
}
@tag
export class Decorated {
  @log
  method(): string { return 'decorated'; }
}
