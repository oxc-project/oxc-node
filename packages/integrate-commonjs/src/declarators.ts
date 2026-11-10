import * as self from "./declarators";

// `tsc` exports `first` before `second`'s initializer runs.
export const first = 1,
  second = self.first;

// …and each binding of a pattern before the next default runs.
const none: number[] = [];
export const [third = 3, fourth = self.third] = none;

function initial(_strings: TemplateStringsArray): string {
  return "initial";
}

export let tag = initial;
tag = function (this: unknown, _strings: TemplateStringsArray): string {
  return this === undefined ? "unbound" : "bound";
};
export const tagged = tag`x`;

// A `var` the loop header declares again is the same binding, and stays live.
var looped = 0;
export { looped };
for (var looped of [1, 2]) {
  void looped;
}
looped++;
