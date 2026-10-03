import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("stored texture collection keys retain each producer's object identity", (t) => {
    const result = compileSource(`
        import type {Texture2D} from "@babylonjs/lite";
        function retain(texture: Texture2D): number {
            const values = new Map<Texture2D, number>();
            const keys = new Set<Texture2D>();
            values.set(texture, 3);
            keys.add(texture);
            if (!keys.has(texture)) throw new Error("texture key");
            return values.get(texture)!;
        }
        const callbacks: Array<typeof retain> = [retain];
        if (callbacks.length !== 1) throw new Error("stored signature");
    `);
    assert.match(result.cpp, /Map<bbl::StoredTexture, double>/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    runGeneratedProgram(
        tools,
        "native-texture-key-storage",
        `#define main generated_main\n${result.cpp}\n#undef main\n` +
            readFileSync("test/fixtures/native-texture-key-check.cpp", "utf8"),
        { timeoutMs: 10000, expectedOutput: "" },
    );
});

for (const type of ["MediaQueryList", "MutationObserver"]) {
    test(`retained ${type} storage includes its declaration without activating a Window`, (t) => {
        const result = compileSource(`
            interface Slot { value: ${type} | null; }
            const cached: Array<${type} | null> = [null];
            function retain(value: ${type} | null): () => ${type} | null {
                const slot: Slot = {value};
                return () => slot.value;
            }
            const callbacks: Array<typeof retain> = [retain];
            const read = callbacks[0]!(cached[0]!);
            if (read() !== null || cached[0] !== null) throw new Error("absent owner");
        `);
        assert.match(result.cpp, /#include <bblite\/pal_window_objects.hpp>/);
        assert.ok(!result.manifest.features.includes("platform:window"));
        assert.doesNotMatch(result.cpp, /run_window_application/);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Requires the Windows native fixture compiler.");
            return;
        }
        runGeneratedProgram(tools, `native-stored-${type}`, result.cpp, {
            timeoutMs: 10000,
            expectedOutput: "",
        });
    });
}
