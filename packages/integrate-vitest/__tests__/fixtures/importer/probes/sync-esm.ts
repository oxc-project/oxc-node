import { basename } from 'node:path';
import data from './data.json';
import helper from './helper.cts';
import { x } from './esm-dep.ts';
export const out: string = `${basename('/a/b.ts')}:${data.name}:${helper.twice(x)}`;
