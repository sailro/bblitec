import test from "node:test";
import { runSelfCheckingProgram } from "./self-checking-program.js";

test("a trailing parameter whose type at the call is void may be omitted", (t) => {
    // `place(context: C)` with `C = void` is called as `place()`, as
    // TypeScript allows; the parameter reads undefined.
    const source = `"use strict";
interface Session<C> { place(context: C): number }
function session<C>(run: (context: C) => number): Session<C> {
    return { place: (context) => run(context) };
}
const plain = session<void>(() => 4);
if (plain.place() !== 4) throw new Error("place");
function trailing<T>(value: number, extra: T): number {
    return value + (extra === undefined ? 1 : 0);
}
if (trailing<void>(2) !== 3 || trailing<number>(2, 5) !== 2) throw new Error("trailing");
`;
    return runSelfCheckingProgram(t, "void-parameters", source, {
        expectedOutput: "",
    });
});
