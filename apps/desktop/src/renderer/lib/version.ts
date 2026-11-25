/** Whether version `a` comes before `b` (« 0.1.0 » before « 0.2.0 »), part by part; false when either is not numbers. */
export function olderVersion(a: string, b: string): boolean {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  if ([...left, ...right].some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}
