import { dep } from './dep';
import { nm } from 'fake-dep';
const g = globalThis as any;
const k: string = '__KEY__';
g.__jlCount ??= {};
g.__jlCount[k] ??= { root: 0, dep: 0 };
g.__jlCount[k].root++;
export const value: string = dep;
export const nmValue: number = nm;
