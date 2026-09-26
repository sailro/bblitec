import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("billboard adds snapshot retained scratch tuples and optional fields", (t) => {
    const compiled = compileSource(`
        import {createEngine, loadSpriteAtlas, createFacingBillboardSystem, addBillboardSpriteIndex} from "babylon-lite";
        import type {BillboardSpriteInit, FacingBillboardSpriteSystem} from "babylon-lite";
        function emit(system: FacingBillboardSpriteSystem, sprite: BillboardSpriteInit, x: number): void {
            sprite.position[0] = x;
            addBillboardSpriteIndex(system, sprite);
        }
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const atlas = await loadSpriteAtlas(engine, "sprites.png", {gridSize:[1,1]});
            const system = createFacingBillboardSystem(atlas, {capacity:4});
            const sprites: BillboardSpriteInit[] = [{position:[0,0,0],sizeWorld:[1,1]}, {position:[0,0,0],sizeWorld:[2,2],color:[1,0,0,1],rotation:1}];
            for (const sprite of sprites) { emit(system, sprite, 3); emit(system, sprite, 4); }
        }
        main();
    `);
    assert.match(compiled.cpp, /has_color = true/);
    assert.match(compiled.cpp, /\.color\.has_value\(\)|->color\.has_value\(\)/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler required.");
        return;
    }
    const output = resolve("artifacts/billboard-scratch-options");
    mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, compiled.manifest.features);
    const path = join(output, "check.cpp");
    writeFileSync(path, compiled.cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/permissive-",
        "/c",
        "/I",
        "native/include",
        "/I",
        join(output, "upstream/include"),
        `/Fo:${join(output, "check.obj")}`,
        path,
    ]);
});
