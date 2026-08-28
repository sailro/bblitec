import { values } from "./module-seed.js";

export const index = new Map<string, number>();

for (let i = 0; i < values.length; i++) {
    index.set(`v${i}`, values[i]!);
}
