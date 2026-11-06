// `cycle-b` imports this module back while it is still loading.
import { fromB } from "./cycle-b";

export { seenDuringLoad } from "./cycle-b";

export function hoisted(): string {
  return "hoisted";
}

export const late = "late";

export const readB = (): string => fromB;
