/**
 * Truthiness and presence are two facts: whether a maybe-absent value is
 * there (`presenceCpp`/`presenceFlagCpp`), and JavaScript truthiness,
 * which the one `truthinessCondition` answers for every position -- an
 * `if`, a `!!`, or a boolean sink.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const scene = (body: string): string => `
    import {
        addToScene, createBox, createEngine, createSceneContext,
        registerScene, startEngine,
    } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const box = createBox(engine, { size: 1 });
        addToScene(scene, box);
        ${body}
        await registerScene(scene);
        await startEngine(engine);
    }
    void main();
`;

test("a bound element read is present and true in a boolean sink", () => {
    const result = compileSource(
        scene(`
            const flags: boolean[] = [false, true];
            const index = Date.now() % 2;
            const shown = flags[index];
            flags[index] = true;
            box.visible = shown!;
        `),
        { fileName: "bound-element-boolean.ts" },
    );
    // The sink reads the local the scene bound, guarded by the presence
    // snapshot taken with it -- not the array again, which the write
    // between them changed.
    assert.match(
        result.cpp,
        /\.visible = \(v_bblite_element_found_\d+ && v_shown\);/,
    );
    assert.doesNotMatch(result.cpp, /\.visible = bbl::js::array_at_or_default/);
});

test("a boolean position reads its operand's JavaScript truthiness", () => {
    const result = compileSource(
        scene(`
            const index = Date.now() % 2;
            const count = [0, 3][index];
            box.pickable = !!count;
        `),
        { fileName: "boolean-position-truthiness.ts" },
    );
    assert.match(
        result.cpp,
        /\.pickable = !\(!\(bbl::js::number_truthy\(v_count\)\)\);/,
    );
});
