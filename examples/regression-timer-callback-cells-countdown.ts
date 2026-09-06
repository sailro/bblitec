/**
 * A helper whose callback parameter runs from a timer-driven recursive
 * closure, in a module of its own: the racer's countdown shape. The caller's
 * binding flipped from `onGo` must be one shared cell for every closure over
 * it, or the frame callback keeps reading the value it was created with.
 */
export function startCountdown(onGo: () => void): void {
    const steps = ["3", "2", "1", "GO!"];
    let i = 0;
    const tick = (): void => {
        if (i >= steps.length) {
            return;
        }
        if (steps[i] === "GO!") {
            onGo();
        }
        i++;
        setTimeout(tick, 700);
    };
    tick();
}
