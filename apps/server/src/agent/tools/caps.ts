export function enforceCap(
  count: number,
  cap: number,
  kind: "search" | "fetch",
): void {
  if (count >= cap) throw new Error(`${kind} cap reached`);
}
