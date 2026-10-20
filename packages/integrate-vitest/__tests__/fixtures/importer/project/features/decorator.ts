import { Decorated, seen } from '../src/decorated.ts';
export default { method: new Decorated().method(), tagged: (Decorated as any).tagged === true, seen };
