import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { assertAsyncSourceCloses } from "./async-oracle.js";
import {
    headlessRealmHost,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("typeof a member of a primitive reads its wrapper prototype: a thenable test on a number", async (t) => {
    // A generic helper accepts a value or a promise of it and tests for a
    // thenable; specialized for numbers and strings the test is false.
    const source = `"use strict";
function createPrepared<Choice>(prepare: () => Choice | Promise<Choice>): () => Promise<Choice> {
    let pending!: Promise<Choice>;
    let current: Choice | null = null;
    const prepared = prepare();
    if (prepared && typeof (prepared as PromiseLike<Choice>).then === "function") {
        pending = Promise.resolve(prepared).then((choice) => { current = choice; return choice; });
    } else {
        current = prepared as Choice;
        pending = Promise.resolve(current);
    }
    return () => pending;
}
async function main(): Promise<string> {
    const count = createPrepared(() => 3);
    const name = createPrepared(() => "x");
    if (typeof (7 as unknown as { then?: unknown }).then !== "undefined") throw new Error("then");
    if (typeof ("s" as unknown as { trim: unknown }).trim !== "function") throw new Error("trim");
    if (typeof (true as unknown as { valueOf: unknown }).valueOf !== "function") throw new Error("valueOf");
    return [String(await count()), await name()].join();
}
main().then((words) => {
    if (words !== "3,x") throw new Error(words);
    // The native application ends as a page does, when its window closes.
    globalThis.close();
});
`;
    await assertAsyncSourceCloses(source);
    const { cpp } = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    // The awaited generic helper runs in the application realm.
    runGeneratedProgram(
        tools,
        "primitive-member-typeof",
        cpp + headlessRealmHost(),
        {
            flags: ["/DBBLITE_WORKERS=1"],
            timeoutMs: 20000,
            expectedOutput: "",
        },
    );
});
