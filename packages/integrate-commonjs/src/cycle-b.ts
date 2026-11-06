import * as a from "./cycle-a";

// Read while `cycle-a`, which is imported first, is still loading.
export const seenDuringLoad = { hoisted: a.hoisted(), late: a.late };

export const fromB = "b";
