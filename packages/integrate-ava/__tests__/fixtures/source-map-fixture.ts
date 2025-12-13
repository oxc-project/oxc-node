export function example(value: number): number {
  if (value < 0) {
    throw new Error("negative value");
  }

  return value * 2;
}
