const STEPS_PER_SECOND = 60;
export function stepCount(seconds: number): number {
    return Math.round(seconds * STEPS_PER_SECOND);
}
export function nextCount(value: number): number {
    value += 1;
    return value;
}
