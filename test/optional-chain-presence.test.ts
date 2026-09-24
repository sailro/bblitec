/**
 * An optional chain short-circuits as a whole: `found?.position.y` is
 * `undefined` when `found` is, however many links follow the `?.`. The
 * owner's presence travels with every link, and a primitive read through
 * an owner that may be absent is selected against a default, so neither a
 * condition, a `??` nor a binding reads through the absent owner.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const scene = (body: string): string => `
    import {
        addToScene, createBox, createEngine, createSceneContext, createSphere,
        registerScene, startEngine,
    } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const sphere = createSphere(engine, { diameter: 1 });
        sphere.name = "hero";
        addToScene(scene, sphere);
        const box = createBox(engine, { size: 1 });
        addToScene(scene, box);
        const found = scene.meshes.find((m) => m.name === "hero");
        ${body}
        await registerScene(scene);
        await startEngine(engine);
    }
    void main();
`;

/** The read `found?.position.y` guarded by the chain's presence. */
const guardedRead =
    /\(v_found\.has_value\(\) \? bbl::handle_at\(v_engine\.meshes, \(\*v_found\)\)\.position\.y : std::remove_cvref_t<decltype\(/;

test("a condition over a chain continuation tests presence first", () => {
    const result = compileSource(
        scene("if (found?.position.y) box.position.y = 3;"),
        { fileName: "optional-chain-condition.ts" },
    );
    assert.match(
        result.cpp,
        /if \(\(v_found\.has_value\(\) && bbl::js::number_truthy\(\(v_found\.has_value\(\) \? /,
    );
    assert.match(result.cpp, guardedRead);
    assert.doesNotMatch(
        result.cpp,
        /number_truthy\(bbl::handle_at\(v_engine\.meshes, \(\*v_found\)\)/,
    );
});

test("a binding of a chain continuation reads through the guard", () => {
    const result = compileSource(
        scene(
            "const height = found?.position.y; box.position.x = height ?? 1;",
        ),
        { fileName: "optional-chain-binding.ts" },
    );
    assert.match(result.cpp, /double v_height = \(v_found\.has_value\(\) \? /);
    assert.match(result.cpp, guardedRead);
    // The fallback selects on the presence the binding snapshotted.
    assert.match(
        result.cpp,
        /\.position\.x = \(v_bblite_element_found_\d+ \? v_height : 1\.0\);/,
    );
});
