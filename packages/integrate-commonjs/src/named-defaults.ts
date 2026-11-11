// A pattern whose default takes its binding's name keeps this file an ES module: as
// `exports` members the functions would lose their names, and published after the
// whole pattern, `seen` would read `fn` through the cycle before it is set.
import * as self from "./named-defaults";

export const [byDefault = function () {}, DefaultClass = class {}] = [];
export const [fn = () => 42, seen = self.fn]: Array<() => number> = [];
export const answer = seen();
