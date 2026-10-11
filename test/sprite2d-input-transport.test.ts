import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function compileSprites(body: string): string {
    return compileSource(`
        import {
            createEngine, loadSpriteAtlas, createSprite2DLayer,
            addSprite2D, addSprite2DIndex, updateSprite2D, updateSprite2DIndex
        } from "babylon-lite";
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const atlas = await loadSpriteAtlas(engine, "sprites.png", {gridSize:[1,1]});
            const layer = createSprite2DLayer(atlas);
            ${body}
        }
        main();
    `).cpp;
}

function instanceInputs(cpp: string): string[] {
    return cpp
        .split("\n")
        .filter((line) => line.includes("bbl::Sprite2DProps{"))
        .map((line) =>
            line.slice(
                line.indexOf("bbl::Sprite2DProps{"),
                line.lastIndexOf("}") + 1,
            ),
        );
}

test("Sprite2D add and update inputs preserve source doubles before Float32 stores", (t) => {
    const props = `{
        positionPx:[16777217, -1e100], sizePx:[1e100, 16777217],
        frame:1.00000001, rotation:1.00000001,
        color:[1.00000001, 1e100, -1e100, 16777217],
        flipX:false, flipY:true, visible:false, z:1.00000001
    }`;
    const inputs = instanceInputs(
        compileSprites(`
        addSprite2DIndex(layer, ${props});
        const handle = addSprite2D(layer, ${props});
        updateSprite2D(handle, ${props});
        updateSprite2DIndex(layer, 0, ${props});
    `),
    );
    assert.equal(inputs.length, 4);
    assert.equal(new Set(inputs).size, 1);
    assert.doesNotMatch(inputs[0]!, /static_cast<float>/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler required.");
        return;
    }
    runGeneratedProgram(
        tools,
        "sprite2d-input-transport",
        `
        #include "bblite/runtime.hpp"
        #include <cassert>
        int main() {
            const auto props = ${inputs[0]!};
            assert(props.position_px.x == 16777217.0 && props.position_px.y == -1e100);
            assert(props.size_px.x == 1e100 && props.size_px.y == 16777217.0);
            assert(props.frame == 1.00000001 && props.rotation == 1.00000001 && props.z == 1.00000001);
            assert(props.color.x == 1.00000001 && props.color.y == 1e100);
            assert(props.color.z == -1e100 && props.color.w == 16777217.0);
            assert(props.has_position_px && props.has_size_px && props.has_frame);
            assert(props.has_rotation && props.has_color && props.has_z);
            assert(props.has_flip_x && !props.flip_x && props.has_flip_y && props.flip_y);
            assert(props.has_visible && !props.visible);
        }
    `,
    );
});

test("Sprite2D explicit undefined leaves patch members absent", (t) => {
    const inputs = instanceInputs(
        compileSprites(`
        const handle = addSprite2D(layer, {positionPx:[0,0]});
        updateSprite2DIndex(layer, 0, {});
        updateSprite2DIndex(layer, 0, {
            positionPx:undefined, sizePx:undefined, frame:undefined, rotation:undefined,
            color:undefined, flipX:undefined, flipY:undefined, visible:undefined, z:undefined
        });
        updateSprite2D(handle, {
            positionPx:undefined, sizePx:undefined, frame:undefined, rotation:undefined,
            color:undefined, flipX:undefined, flipY:undefined, visible:undefined, z:undefined
        });
    `),
    );
    assert.equal(inputs.length, 4);
    assert.equal(inputs[1], inputs[2]);
    assert.equal(inputs[1], inputs[3]);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler required.");
        return;
    }
    runGeneratedProgram(
        tools,
        "sprite2d-undefined-input",
        `
        #include "bblite/runtime.hpp"
        #include <cassert>
        int main() {
            const auto props = ${inputs[2]!};
            assert(!props.has_position_px && !props.has_size_px && !props.has_frame);
            assert(!props.has_rotation && !props.has_color && !props.has_z);
            assert(!props.has_flip_x && !props.has_flip_y && !props.has_visible);
        }
    `,
    );
});

test("both Sprite2D add forms require a defined position", () => {
    for (const name of ["addSprite2D", "addSprite2DIndex"])
        for (const props of ["{}", "{positionPx:undefined}"])
            assert.throws(
                () => compileSprites(`${name}(layer, ${props});`),
                new RegExp(`${name}: positionPx required`),
            );
});

test("Sprite2D optional runtime scalars refuse before producing invalid native casts", () => {
    assert.throws(
        () =>
            compileSprites(`
            function frame(): number | undefined {
                return Math.random() > 0.5 ? 1 : undefined;
            }
            updateSprite2DIndex(layer, 0, {frame:frame()});
        `),
        /Sprite option 'frame' requires number/,
    );
});
