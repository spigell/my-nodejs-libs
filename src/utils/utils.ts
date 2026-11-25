export function chunk<T>(arr: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error('chunk size must be an integer of at least 1.');
  }

  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
