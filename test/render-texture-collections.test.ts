import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const setup = `
    import { createEngine, createSceneContext, createRenderTarget,
        createGeometryRendererTask, GeometryTextureType, createCopyToTextureTask,
        createStandardMaterial, addTask, type RenderTarget } from "@babylonjs/lite";
    const engine = await createEngine({});
    const scene = createSceneContext(engine, {defaultRenderTask: false});
    const target = createRenderTarget({format: "rgba8unorm", samples: 1,
        size: {width: 32, height: 24}});
    const geometryA = createGeometryRendererTask({name: "first", samples: 1,
        targetTexture: target, textureDescriptions: [
            {type: GeometryTextureType.WORLD_POSITION},
            {type: GeometryTextureType.VIEW_NORMAL}]}, engine, scene);
    const geometryB = createGeometryRendererTask({name: "second", samples: 1,
        textureDescriptions: [{type: GeometryTextureType.WORLD_POSITION}]}, engine, scene);
`;

test("render texture collections preserve attachment owners through records and helper loops", () => {
    const result = compileSource(`${setup}
        const named = [
            {name: "world", source: geometryA.geometryWorldPositionTexture!},
            {name: "normal", source: geometryA.geometryViewNormalTexture!},
            {name: "output", source: geometryA.outputTexture!}];
        function copy(items: {name: string; source: RenderTarget}[]): void {
            for (let i = 0; i < items.length; i++) {
                const item = items[i]!;
                addTask(scene, createCopyToTextureTask({name: item.name,
                    sourceTexture: item.source, targetTexture: target}, engine, scene));
            }
        }
        copy(named);
        const plain = [geometryA.geometryWorldPositionTexture!, geometryB.geometryWorldPositionTexture!];
        for (let i = 0; i < plain.length; i++) {
            addTask(scene, createCopyToTextureTask({name: "plain-" + i,
                sourceTexture: plain[i]!, targetTexture: target}, engine, scene));
        }
    `);
    assert.deepEqual(result.manifest.copyTasks, [
        "world",
        "normal",
        "output",
        "plain-0",
        "plain-1",
    ]);
    assert.match(
        result.cpp,
        /bbl::geometry_task_texture\(v_geometryA, bbl::GeometryTextureType::world_position\)/,
    );
    assert.match(
        result.cpp,
        /bbl::geometry_task_texture\(v_geometryB, bbl::GeometryTextureType::world_position\)/,
    );
    assert.match(
        result.cpp,
        /bbl::geometry_task_output_texture\(v_geometryA\)/,
    );
    assert.equal(result.manifest.geometryOutputTasks.length, 2);
});

test("inferred callback arrays retain their represented storage admission", () => {
    assert.doesNotThrow(() =>
        compileSource(`
        const callbacks = [() => 3];
        callbacks.push(() => 7);
        if (callbacks[0]!() !== 3 || callbacks[1]!() !== 7)
            throw new Error("callback array values");
    `),
    );
});

test("render texture collections retain depth and source ownership refusals", () => {
    for (const [property, expected] of [
        ["geometryDepthTexture", /cannot be a depth attachment/],
        ["geometryWorldPositionTexture", /received a geometry one/],
    ] as const) {
        assert.throws(
            () =>
                compileSource(`${setup}
                const entries = [{source: geometryA.${property}!}];
                const material = createStandardMaterial();
                material.diffuseTexture = entries[0]!.source;
            `),
            expected,
        );
    }
});
