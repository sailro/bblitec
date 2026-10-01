import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedShadowHeader } from "../src/lowering/shadow-lowerer.js";

/**
 * The PCF shadow generator options a scene computes at run time or the pin
 * never reads.
 */

const shadowScene = (options: string) => `
    import {
        addToScene,
        createDirectionalLight,
        createEngine,
        createPcfDirectionalShadowGenerator,
        createSceneContext,
        createSphere,
        setShadowTaskCasterMeshes,
    } from "@babylonjs/lite";

    async function main() {
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const light = createDirectionalLight([-1, -2, -1], 1);
        addToScene(scene, light);
        const sphere = createSphere(engine, { diameter: 1 });
        addToScene(scene, sphere);
        const query = new URLSearchParams(location.search);
        const size = Number(query.get("size") ?? "1024");
        const shadow = createPcfDirectionalShadowGenerator(engine, light, { ${options} });
        setShadowTaskCasterMeshes(shadow, [sphere]);
    }
`;

test("evaluates and drops the PCF normalBias the pinned factory never reads", () => {
    const literal = compileSource(shadowScene("bias: 0.001, normalBias: 0.02"));
    assert.doesNotMatch(literal.cpp, /0\.02/);
    const computed = compileSource(
        shadowScene("normalBias: performance.now() / 1000"),
    );
    assert.match(
        computed.cpp,
        /static_cast<void>\(\(bbl::pal::performance_milliseconds\(\) \/ 1000\.0\)\);/,
    );
    // The header that lowers the factories also asserts the pin's bodies
    // never read the option.
    assert.doesNotThrow(() => pinnedShadowHeader(new LoweringContext()));
});

test("checks a run-time PCF mapSize where the native factory sizes its target", () => {
    const runtime = compileSource(shadowScene("mapSize: Math.round(size)"));
    assert.match(
        runtime.cpp,
        /PcfDirectionalShadowOptions\{bbl::gpu_u32\(bbl::gpu_size\(bbl::js::round_js\(/,
    );
    const literal = compileSource(shadowScene("mapSize: 2048"));
    assert.match(literal.cpp, /PcfDirectionalShadowOptions\{2048u,/);
    assert.throws(
        () => compileSource(shadowScene("mapSize: 0")),
        /Expected a positive integer literal/,
    );
});
