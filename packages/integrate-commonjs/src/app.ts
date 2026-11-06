import { Clock, compute, twice } from "./lib";

export const answer = (): number => compute(41);

export const doubled = (): number => twice(21);

export const time = (): number => new Clock().now();
