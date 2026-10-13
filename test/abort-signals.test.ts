import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("AbortController signals abort once, in listener order, with DOMException reasons", () => {
    const result = compileSource(`
        const controller = new AbortController();
        const signal = controller.signal;
        if (controller.signal !== signal) throw new Error("signal identity");
        let order = "";
        const first = () => { order += "a"; };
        const removed = () => { order += "x"; };
        signal.addEventListener("abort", first, { once: true });
        signal.addEventListener("abort", () => { order += "b"; signal.removeEventListener("abort", removed); });
        signal.addEventListener("abort", first);
        signal.addEventListener("abort", removed);
        signal.addEventListener("abort", () => { order += "c"; }, true);
        if (signal.aborted || signal.reason !== undefined) throw new Error("initial state");
        signal.throwIfAborted();
        controller.abort();
        controller.abort(new Error("ignored"));
        signal.addEventListener("abort", () => { order += "late"; });
        if (!signal.aborted || order !== "abc") throw new Error("listener order " + order);
        let caught = 0;
        try { signal.throwIfAborted(); } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError" && error instanceof Error) ++caught;
        }
        const reason = signal.reason;
        if (!(reason instanceof DOMException)) throw new Error("reason");
        const other = new AbortController();
        other.abort(new RangeError("why"));
        try { other.signal.throwIfAborted(); } catch (error) {
            if (error instanceof RangeError && !(error instanceof DOMException) && error.message === "why") ++caught;
        }
        const named = new DOMException("m", "SyntaxError");
        if (named instanceof SyntaxError || !(named instanceof DOMException) || named.name !== "SyntaxError" || named.message !== "m") throw new Error("DOMException name");
        const plain = new DOMException();
        if (plain.name !== "Error" || plain.message !== "") throw new Error("DOMException defaults");
        if (new RangeError("r") instanceof DOMException) throw new Error("ECMAScript errors are not DOMExceptions");
        if (caught !== 2) throw new Error("throwIfAborted");
    `);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(tools, "abort-signals/sync", result.cpp, {
        expectedOutput: "",
    });
});

test("abort listeners settle realm promises", () => {
    const result = compileSource(`
        async function waitFor(signal: AbortSignal): Promise<string> {
            return new Promise<string>((resolve, reject) => {
                if (signal.aborted) { reject(new Error("already")); return; }
                const timer = setTimeout(() => resolve("timeout"), 5000);
                signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
            });
        }
        async function run(): Promise<void> {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 0);
            let message = "";
            try { await waitFor(controller.signal); } catch (error) { message = (error as Error).message; }
            if (message !== "aborted" || !controller.signal.aborted) throw new Error("abort settlement " + message);
            globalThis.close();
        }
        run();
    `);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(tools, "abort-signals/realm", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        expectedOutput: "",
        timeoutMs: 15000,
    });
});

test("abort forms without a native representation refuse", () => {
    for (const [source, message] of [
        [
            `const c = new AbortController(); c.abort("text");`,
            /AbortController.abort lowers an Error reason/,
        ],
        [
            `const c = new AbortController(); c.signal.addEventListener("abort", (event) => { if (event.type) throw new Error(); });`,
            /listeners that take the event are not lowered/,
        ],
        [
            `const c = new AbortController(); c.signal.addEventListener("change", () => {});`,
            /dispatches only 'abort' events/,
        ],
        [
            `const s = new AbortSignal();`,
            /AbortSignal has no public constructor/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});
