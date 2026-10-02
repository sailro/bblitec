import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

for (const [name, handler, setup] of [
    [
        "default-parameter",
        "(_error: unknown, value = recover()) => console.error(value)",
        "",
    ],
    [
        "property-getter",
        "() => console.error(record.value)",
        "const record = {get value(): number { return recover(); }};",
    ],
    [
        "indexed-getter",
        '() => console.error(record["value"])',
        "const record = {get value(): number { return recover(); }};",
    ],
] as const) {
    test(`entry reporter preserves ${name} recovery effects before realm activation`, (t) => {
        const source = `
            let recovered = 0;
            function recover(): number {
                if (++recovered !== 1) throw new Error("repeated recovery");
                return recovered;
            }
            ${setup}
            async function main(): Promise<void> { throw new Error("expected"); }
            main().catch(${handler})
        `;
        const terminal = compileSource(`${source};`);
        assert.ok(terminal.manifest.features.includes("platform:workers"));
        const result = compileSource(`${source}.then(() => {
            if (recovered !== 1) throw new Error("missing recovery");
            globalThis.close();
        });`);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(tools, `entry-reporter-${name}`, result.cpp, {
            defines: ["BBLITE_WORKERS=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        });
    });
}

test("entry reporters preserve the owned-error destructuring boundary", () => {
    assert.throws(
        () =>
            compileSource(`
        async function main(): Promise<void> { throw new Error("expected"); }
        main().catch(({message}) => console.error(message));
    `),
        /Object destructuring is not supported for data/,
    );
});

test("owned rejection text remains a terminal reporting adaptation", () => {
    const result = compileSource(`
        async function main(): Promise<void> { throw new Error("expected"); }
        main().catch((error) => console.error(String(error)));
    `);
    assert.ok(!result.manifest.features.includes("platform:workers"));
});

test("a local function sharing a realm service name keeps ordinary argument lowering", () => {
    const result = compileSource(`
        export {};
        function close(): number { return 1; }
        async function main(): Promise<void> { throw new Error("expected"); }
        main().catch(() => console.error(close()));
    `);
    assert.ok(result.manifest.features.includes("platform:workers"));
});
