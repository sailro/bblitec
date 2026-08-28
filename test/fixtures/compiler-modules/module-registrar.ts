import { values } from "./module-registered-state.js";

values.push(11);

export function firstValue(): number {
    return values[0]!;
}
