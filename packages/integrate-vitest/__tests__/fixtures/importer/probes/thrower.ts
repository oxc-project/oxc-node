enum Color { Red, Green }
interface Foo { a: number }
type Bar = string;
const unused: Foo = { a: 1 };
export function boom(): never {
  // line 6
  throw new Error('boom-here'); // line 7
}
