import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("console methods as values erase their output and keep argument effects", (t) => {
    const { cpp } = compileSource(`
        let count = 0;
        function install(label: string, log: (message: string, detail?: unknown) => void = console.error): void {
            log("[" + label + "]", count++);
        }
        install("a");
        install("b", (message) => { count += message.length; });
        const warn = console.warn;
        warn("w", count++);
        if (count !== 6) throw new Error("argument effects " + count);
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "erased-function-values/console", cpp, {
        expectedOutput: "",
    });
});

test("arguments past a callback's parameters run in source order", (t) => {
    const { cpp } = compileSource(`
        const order: string[] = [];
        const note = (name: string): number => { order.push(name); return order.length; };
        function call(run: (first: number) => void): void {
            run(note("a"), note("b"));
        }
        let seen = 0;
        call((first) => { seen = first; });
        if (order.join(",") !== "a,b" || seen !== 1) throw new Error("order " + order.join(","));
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "erased-function-values/arguments", cpp, {
        expectedOutput: "",
    });
});
