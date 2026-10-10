import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import { sharedUpstreamStore } from "../src/upstream-source.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const native = optionalNativeFixtureTools(false);

test(
    "live vector tuples and getters evaluate once at native sinks",
    { skip: !native },
    () => {
        const output = resolve("artifacts/vector-tuple-check");
        mkdirSync(output, { recursive: true });
        const headers = join(output, "bblite", "upstream");
        mkdirSync(headers, { recursive: true });
        writeFileSync(
            join(headers, "sprite_layer.hpp"),
            new SpriteLowerer(
                new LoweringContext(sharedUpstreamStore()),
            ).lowerCore().header,
        );
        const result = compileSource(`
        import {
            createEngine, createStandardMaterial, createHemisphericLight,
            createSceneContext, setClipPlane, createRenderTexture2D,
            createGridSpriteAtlas, createSprite2DLayer, addSprite2DIndex,
            setSprite2DUvOffset,
        } from "@babylonjs/lite";
        const colors: [number, number, number][] = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]];
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const texture = createRenderTexture2D(engine, 1, 1);
            const atlas = createGridSpriteAtlas(texture, {cellWidthPx:1, cellHeightPx:1});
            const layer = createSprite2DLayer(atlas, {capacity:1});
            addSprite2DIndex(layer, {positionPx:[0,0]});
            const offsets: [number,number][] = [[0,0]];
            const planes: [number,number,number,number][] = [[0,0,0,0]];
            let reads = 0;
            let getters = 0;
            let offsetReads = 0;
            let planeReads = 0;
            let tupleGetters = 0;
            function next(): number { return reads++; }
            function direction(): [number, number, number] { getters++; return [4, 5, 6]; }
            function offset(): [number,number] { offsetReads++; return offsets[0]!; }
            function plane(): [number,number,number,number] { planeReads++; return planes[0]!; }
            const options = {
                get direction(): [number,number,number] { return direction(); },
                get offset(): [number,number] { tupleGetters++; return offset(); },
                get plane(): [number,number,number,number] { tupleGetters++; return plane(); },
            };
            for (let index = 0; index < 4; index++) {
                const material = createStandardMaterial();
                material.diffuseColor = colors[next()]!;
                createHemisphericLight(options.direction);
                const pair = offsets[0]!;
                pair[0] = index + 1; pair[1] = index + 2;
                const quad = planes[0]!;
                quad[0] = index + 3; quad[1] = index + 4;
                quad[2] = index + 5; quad[3] = index + 6;
                setSprite2DUvOffset(layer, 0, pair);
                setSprite2DUvOffset(layer, 0, offset());
                setSprite2DUvOffset(layer, 0, options.offset);
                scene.clearColor = {r:index+10, g:index+20, b:index+30, a:index+40};
                setClipPlane(scene, quad);
                setClipPlane(scene, plane());
                setClipPlane(scene, options.plane);
            }
            if (reads !== 4 || getters !== 4 || offsetReads !== 8 || planeReads !== 8 || tupleGetters !== 8)
                throw new Error("repeated vector evaluation");
        }
    `);
        writeFileSync(join(output, "scene.hpp"), result.cpp);
        const executable = join(output, "check.exe");
        runNativeFixtureCompiler(native!, [
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            output,
            "test\\fixtures\\vector-tuple-check.cpp",
        ]);
        assert.match(
            execFileSync(executable, { encoding: "utf8" }),
            /vector-tuple-check: ok/,
        );
    },
);
