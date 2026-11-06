export * from "./more";

export const compute = (n: number): number => n + 1;

export function twice(n: number): number {
  return n * 2;
}

export class Clock {
  now(): number {
    return 1;
  }
}

export let counter = 0;

export function increment(): void {
  counter++;
}

export default class Greeter {
  greet(): string {
    return "hello";
  }
}
