import config from 'babel-object';
import * as all from 'babel-object';
import esmDefault from 'esm-esmodule-default';

export const fromDefault = config;
export const fromNamespace = all.default;
export const helper: number = all.helper;
export const lazy = () => import('babel-object').then((m) => m.default);
// A real ES module keeps its default, whatever it holds.
export const esm = esmDefault;
