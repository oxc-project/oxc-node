import { Color, sizeS } from './src/enum';
import { Decorated, seen } from './src/decorated';
import { libValue } from '@lib/util';
import { other } from './src/other';
import data from './src/data.json';
import { tla } from './src/tla';
import cts from './src/helper.cts';
import cjsPkg from './pkg-cjs/index.ts';

type Rule = { name: string; value: unknown };
const rules: Rule[] = [
  { name: 'enum', value: Color.Green },
  { name: 'constEnum', value: sizeS },
  { name: 'decorator', value: new Decorated().method() },
  { name: 'decoratorKey', value: seen.methodKey },
  { name: 'decoratorClass', value: (Decorated as any).tagged === true },
  { name: 'alias', value: libValue },
  { name: 'extensionless', value: other },
  { name: 'json', value: data.name },
  { name: 'tla', value: tla },
  { name: 'cts', value: cts.helper(3) },
  { name: 'cjsPkg', value: cjsPkg.cjsValue },
];
export const metaUrl: string = import.meta.url;
export default rules;
