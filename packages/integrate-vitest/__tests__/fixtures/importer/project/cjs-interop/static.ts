import config from 'babel-object';
import * as all from 'babel-object';

export const fromDefault = config;
export const fromNamespace = all.default;
export const helper: number = all.helper;
export const lazy = () => import('babel-object').then((m) => m.default);
