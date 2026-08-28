export const values: number[] = [];

function append(rows: [number, number][]): void {
    for (const [left, right] of rows) {
        values.push(left + right);
    }
}

append([
    [1, 2],
    [3, 4],
]);
