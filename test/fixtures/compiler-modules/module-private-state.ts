const values: number[] = [];
const target = values;

(() => {
    target.push(3);
    target.push(7);
})();

export function valueAt(index: number): number {
    return values[index]!;
}
