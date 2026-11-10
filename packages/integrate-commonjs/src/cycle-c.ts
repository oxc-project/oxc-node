// `cycle-d` imports this module back while it is still loading. Under `tsc`, what it
// reads then is `undefined`, apart from the function declarations; none of it throws.
import { snapshot } from "./cycle-d";

export let counter = 0;

export function bump(): number {
  return ++counter;
}

function tag(target: unknown): void {
  void target;
}

@tag
export class Service {}

export namespace Settings {
  export const level = 1;
}

export { more as reexported } from "./more";

export default function () {
  return "anonymous default";
}

export const seen = snapshot;
