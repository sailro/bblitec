import type ts from "typescript";
import { libraryGlobal } from "./symbols.js";

/** How a library scheduler runs the callback it is handed: never before it returns. */
export type SchedulerKind =
    "timeout" | "interval" | "microtask" | "frame" | "idle";

const SCHEDULERS: ReadonlyMap<string, SchedulerKind> = new Map([
    ["queueMicrotask", "microtask"],
    ["requestAnimationFrame", "frame"],
    ["requestIdleCallback", "idle"],
    ["setInterval", "interval"],
    ["setTimeout", "timeout"],
]);

const CANCELS: ReadonlyMap<string, SchedulerKind> = new Map([
    ["cancelAnimationFrame", "frame"],
    ["cancelIdleCallback", "idle"],
    ["clearInterval", "interval"],
    ["clearTimeout", "timeout"],
]);

/**
 * The scheduler a callee names as a library global (`setTimeout`), or
 * undefined: a user function or method that shares the name is not one.
 */
export function schedulerOf(
    checker: ts.TypeChecker,
    callee: ts.Expression,
): SchedulerKind | undefined {
    const name = libraryGlobal(checker, callee);
    return name === undefined ? undefined : SCHEDULERS.get(name);
}

/** The scheduler whose registration a library cancel function (`clearTimeout`) undoes. */
export function cancelledSchedulerOf(
    checker: ts.TypeChecker,
    callee: ts.Expression,
): SchedulerKind | undefined {
    const name = libraryGlobal(checker, callee);
    return name === undefined ? undefined : CANCELS.get(name);
}
