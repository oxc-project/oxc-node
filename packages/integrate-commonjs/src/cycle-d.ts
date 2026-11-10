import anonymous, * as c from "./cycle-c";

// Read while `cycle-c`, which is imported first, is still loading.
export const snapshot = {
  counter: c.counter,
  service: c.Service,
  settings: c.Settings,
  reexported: c.reexported,
  anonymous: anonymous(),
};
