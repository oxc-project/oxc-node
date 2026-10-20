type Unused = { a: number };
interface AlsoUnused { b: string }

const value: Unused = { a: 1 };
export const a = value.a;
    throw new Error('top-level-boom');
