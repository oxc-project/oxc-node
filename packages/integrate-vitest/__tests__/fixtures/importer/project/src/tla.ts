export const tla: number = await new Promise<number>((r) => setTimeout(() => r(42), 5));
