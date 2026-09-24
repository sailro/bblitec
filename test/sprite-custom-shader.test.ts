import assert from "node:assert/strict";
import test from "node:test";

import { CompileError, compileSource } from "../src/compiler.js";

import { LoweringContext } from "../src/lowering/context.js";
import {
    PinnedShaderBuilders,
    type ShaderTextBinding,
} from "../src/lowering/pinned-shader-builders.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import { BillboardLowerer } from "../src/lowering/billboard-lowerer.js";
import {
    reflectWgslBindings,
    wgslEntryPoints,
    reflectWgslModule,
} from "../src/shader-ir.js";

/** The body scenes 92 and 94 pass, which reads `fx` and nothing else. */
const TINT_BODY =
    "return textureSample(atlasTex, atlasSamp, in.uv) * in.tint * fx.params;";

function billboards(): BillboardLowerer {
    return new BillboardLowerer(new LoweringContext());
}

function sprites(): SpriteLowerer {
    return new SpriteLowerer(new LoweringContext());
}

/** Each binding a module declares, as `group:binding name`. */
function bindings(wgsl: string): string[] {
    return reflectWgslBindings(wgsl).map(
        ({ group, binding, name }) => `${group}:${binding} ${name}`,
    );
}

const pure = { hasDepth: false, uvScroll: false };

test("runs the pinned extra-binding loop over a bound list", () => {
    const text = new PinnedShaderBuilders(new LoweringContext());
    // One pair per extra texture, stepping the binding by two. Running the
    // pin's own loop rather than emitting the lines here is what keeps a
    // changed binding rule the pin's.
    assert.equal(
        text.evaluate(
            "src/sprite/custom-shader-core.ts",
            "makeExtraBindingsWgsl",
            new Map<string, ShaderTextBinding>([
                ["group", "2"],
                ["startBinding", 2],
                ["extras", [{ name: "palette" }, { name: "noise" }]],
            ]),
        ),
        "@group(2)@binding(2)var paletteTex:texture_2d<f32>;" +
            "@group(2)@binding(3)var paletteSamp:sampler;" +
            "@group(2)@binding(4)var noiseTex:texture_2d<f32>;" +
            "@group(2)@binding(5)var noiseSamp:sampler;",
    );
    // A layer that named none binds the empty list, and the loop settles
    // without running.
    assert.equal(
        text.evaluate(
            "src/sprite/custom-shader-core.ts",
            "makeExtraBindingsWgsl",
            new Map<string, ShaderTextBinding>([
                ["group", "0"],
                ["startBinding", 3],
                ["extras", []],
            ]),
        ),
        "",
    );
});

test("executed pinned builders bind by the pin's own parameter names", () => {
    const executed = new PinnedShaderBuilders(new LoweringContext());
    assert.throws(
        () =>
            executed.evaluate(
                "src/material/line/line-material.ts",
                "fragmentSource",
                new Map([["hasColour", true]]),
            ),
        /takes no parameter 'hasColour'/,
    );
});

test("binds the extra textures and fx block where the pin's composer puts them", () => {
    const body = "return textureSample(paletteTex,paletteSamp,in.uv);";
    const custom = { fragment: body, extraTextures: ["palette"] };
    // The pin's one group: the layer block and the atlas pair, then the
    // extra pairs and the fx block the custom composer appends. The module
    // is deployed as the pin composes it, so these are its own numbers.
    assert.deepEqual(bindings(sprites().module(pure, custom)), [
        "0:0 L",
        "0:1 atlasTex",
        "0:2 atlasSamp",
        "0:3 paletteTex",
        "0:4 paletteSamp",
        "0:5 fx",
    ]);
    // The billboard family's composer puts them in the system's group 1,
    // after the pin's scene block at group 0.
    const billboard = bindings(
        billboards().module("facing", "transparent", custom),
    );
    assert.equal(billboard[0], "0:0 scene");
    assert.ok(billboard.includes("1:0 billboards"));
    assert.ok(billboard.includes("1:1 atlasTex"));
    assert.ok(billboard.some((row) => row.endsWith(" paletteTex")));
    assert.ok(billboard.some((row) => row.endsWith(" fx")));
    // A body that names none declares none.
    assert.ok(
        !bindings(
            sprites().module(pure, { fragment: TINT_BODY, extraTextures: [] }),
        ).some((row) => row.endsWith("Tex") && !row.endsWith(" atlasTex")),
    );
});

test("composes the custom sprite program from the pin's own builder", () => {
    const custom = sprites().module(pure, {
        fragment: TINT_BODY,
        extraTextures: [],
    });
    // The caller's body, verbatim, inside the module the engine composes,
    // with the pin's fx struct -- its padding slots are the ones
    // `writeSpriteFxUbo` skips.
    assert.ok(custom.includes(TINT_BODY));
    assert.match(custom, /time:f32/);
    assert.match(custom, /params:vec4f/);
    // One vertex and one fragment entry point, each stage compiled from
    // the one module.
    const module = reflectWgslModule(custom);
    assert.equal(wgslEntryPoints(module, "vertex").length, 1);
    assert.equal(wgslEntryPoints(module, "fragment").length, 1);
    // A plain layer's module declares no fx block.
    assert.ok(!sprites().module(pure).includes("SpriteFx"));
});

test("composes the pinned depth-hosted sprite permutation", () => {
    const module = sprites().module({ hasDepth: true, uvScroll: false });
    assert.match(module, /@location\(6\)z:f32/);
    assert.match(module, /out\.p=vec4f\(n,1 - in\.z,1\)/);
    // The depth host's scene group takes group 0, so the sprite's own
    // group is 1.
    assert.deepEqual(bindings(module), [
        "1:0 L",
        "1:1 atlasTex",
        "1:2 atlasSamp",
    ]);
});

test("gives the custom billboard program its own vertex stage", () => {
    const custom = billboards().module("facing", "transparent", {
        fragment: TINT_BODY,
        extraTextures: [],
    });
    const plain = billboards().module("facing", "transparent");
    // The pin's billboard composer exposes the view distance and the world
    // position to a custom body, so unlike the stock program its vertex
    // stage writes two more varyings.
    assert.match(custom, /viewDist/);
    assert.doesNotMatch(plain, /viewDist/);
    assert.ok(custom.includes(TINT_BODY));
});

test("refuses pixels that generation cannot produce", () => {
    // The bytes are baked by running the module, so the argument has to
    // name a function generation can call rather than any other value.
    assert.throws(
        () =>
            compileSource(
                'import {\n    createEngine,\n    createSprite2DCustomShader,\n    createSprite2DLayer,\n    createSpriteRenderer,\n    createTexture2DFromPixels,\n    loadSpriteAtlas,\n    registerSpriteRenderer,\n    startEngine,\n} from "babylon-lite";\nimport { getCutoutSpriteAtlasDataUrl } from "../corpus/babylon-lite/lab/lite/src/_shared/sprite-atlas-cutout";\nimport { PALETTE_WIDTH } from "../corpus/babylon-lite/lab/lite/src/_shared/palette-remap";\n\nasync function main(): Promise<void> {\n    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;\n    const engine = await createEngine(canvas);\n    const atlas = await loadSpriteAtlas(engine, getCutoutSpriteAtlasDataUrl(), {\n        gridSize: [32, 32],\n        sampling: "nearest",\n    });\n    const paletteTexture = createTexture2DFromPixels(engine, PALETTE_WIDTH as unknown as Uint8Array, 256, 1);\n    const customShader = createSprite2DCustomShader({\n        fragment: "return textureSample(paletteTex, paletteSamp, in.uv);",\n        extraTextures: [{ name: "palette", texture: paletteTexture }],\n    });\n    const layer = createSprite2DLayer(atlas, { capacity: 4, depth: "none", customShader });\n    const sr = createSpriteRenderer(engine, { layers: [layer] });\n    registerSpriteRenderer(sr);\n    await startEngine(engine);\n}\nmain();',
                { fileName: "examples/pixels.ts" },
            ),
        (error: unknown) => {
            assert.ok(error instanceof CompileError);
            assert.match(error.message, /run at generation/);
            return true;
        },
    );
});

test("preserves the sRGB format for raw-pixel shader textures", () => {
    const result = compileSource(
        'import {\n    createEngine,\n    createSprite2DCustomShader,\n    createSprite2DLayer,\n    createSpriteRenderer,\n    createTexture2DFromPixels,\n    loadSpriteAtlas,\n    registerSpriteRenderer,\n    startEngine,\n} from "babylon-lite";\nimport { getCutoutSpriteAtlasDataUrl } from "../corpus/babylon-lite/lab/lite/src/_shared/sprite-atlas-cutout";\nimport { buildColormapPalette } from "../corpus/babylon-lite/lab/lite/src/_shared/palette-remap";\n\nasync function main(): Promise<void> {\n    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;\n    const engine = await createEngine(canvas);\n    const atlas = await loadSpriteAtlas(engine, getCutoutSpriteAtlasDataUrl(), {\n        gridSize: [32, 32],\n        sampling: "nearest",\n    });\n    const paletteTexture = createTexture2DFromPixels(\n        engine, buildColormapPalette(), 256, 1, { srgb: true });\n    const customShader = createSprite2DCustomShader({\n        fragment: "return textureSample(paletteTex, paletteSamp, in.uv);",\n        extraTextures: [{ name: "palette", texture: paletteTexture }],\n    });\n    const layer = createSprite2DLayer(atlas, { capacity: 4, depth: "none", customShader });\n    const sr = createSpriteRenderer(engine, { layers: [layer] });\n    registerSpriteRenderer(sr);\n    await startEngine(engine);\n}\nmain();',
        { fileName: "examples/options.ts" },
    );
    assert.match(result.cpp, /PixelsTextureOptions\{[^\n]*true\}/);
    assert.deepEqual(
        result.manifest.spriteCustomShaders.map((shader) => ({
            family: shader.family,
            textures: shader.extraTextures,
        })),
        [{ family: "sprite", textures: ["palette"] }],
    );
});
