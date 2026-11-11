import { join } from "node:path";

// A stack trace must report the throw at line 5, column 9.
export function fail(): never {
  throw new Error(join("thrown", "here"));
}
