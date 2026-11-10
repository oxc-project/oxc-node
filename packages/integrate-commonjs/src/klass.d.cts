// A class at runtime; typed as a function with a namespace, which a namespace import
// of `export =` allows.
declare function Klass(): void;
declare namespace Klass {
  function create(): string;
}
export = Klass;
