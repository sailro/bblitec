/** Annotated as a document but building Maps, so its result is not round-trip JSON and the fold declines. */
export function seedBindings(): Record<"a" | "b", Map<number, number>> {
    return { a: new Map([[1, 2]]), b: new Map([[3, 4]]) };
}
