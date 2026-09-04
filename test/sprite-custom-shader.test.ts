import assert from "node:assert/strict";
import test from "node:test";

import { CompileError, compileSource } from "../src/compiler.js";

import { LoweringContext } from "../src/lowering/context.js";
import {
    PinnedShaderText,
    type ShaderTextBinding,
} from "../src/lowering/pinned-shader-text.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import { BillboardLowerer } from "../src/lowering/billboard-lowerer.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { spriteFragmentWgsl } from "../src/shader-builtins-sprite.js";
import { billboardFragmentWgsl } from "../src/shader-builtins-billboard.js";

/** The body scenes 92 and 94 pass, which reads `fx` and nothing else. */
const TINT_BODY =
    "return textureSample(atlasTex, atlasSamp, in.uv) * in.tint * fx.params;";

function billboards(): BillboardLowerer {
    const context = new LoweringContext();
    return new BillboardLowerer(
        context,
        new RendererLowerer(context).compiledSceneUniformsWgsl(),
    );
}

test("folds the pinned extra-binding loop over a bound list", () => {
    const text = new PinnedShaderText(new LoweringContext());
    // One pair per extra texture, stepping the binding by two. Folding the
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

test("re-homes the extra-texture bindings after the atlas", () => {
    const shader = new SpriteLowerer(new LoweringContext()).shaderSource(
        false,
        "return textureSample(paletteTex,paletteSamp,in.uv);",
        ["palette"],
    );
    // The pin binds its extras after the atlas inside one group; this
    // backend keeps fragment textures in a group of their own, so the pair
    // lands after the atlas pair there.
    assert.equal(
        shader.extraTextureBindings,
        "@group(2)@binding(2)var paletteTex:texture_2d<f32>;" +
            "@group(2)@binding(3)var paletteSamp:sampler;",
    );
    assert.match(
        spriteFragmentWgsl("test", shader),
        /@binding\(1\) var atlasSamp: sampler;\n@group\(2\)@binding\(2\)var paletteTex/,
    );
    // The billboard family re-homes them the same way, through the same
    // helper — which is the reason it is one helper.
    const billboard = billboards().shaderSource(
        "facing",
        "transparent",
        "return textureSample(paletteTex,paletteSamp,in.uv);",
        ["palette"],
    );
    assert.equal(
        billboard.extraTextureBindings,
        shader.extraTextureBindings,
    );
    assert.match(
        billboardFragmentWgsl("test", billboard),
        /@binding\(1\) var atlasSamp: sampler;\n@group\(2\)@binding\(2\)var paletteTex/,
    );
    // A body that names none declares none.
    assert.equal(
        new SpriteLowerer(new LoweringContext()).shaderSource(
            false,
            TINT_BODY,
        ).extraTextureBindings,
        "",
    );
});

test("composes the custom sprite program from the pin's own builder", () => {
    const shader = new SpriteLowerer(new LoweringContext()).shaderSource(
        false,
        TINT_BODY,
    );
    // The caller's body, verbatim, inside the stage the engine owns.
    assert.equal(shader.fragmentBody, TINT_BODY);
    // The fx struct is the pin's, not a copy: its padding slots are the
    // ones `writeSpriteFxUbo` skips.
    assert.match(shader.fxStructFields ?? "", /time:f32/);
    assert.match(shader.fxStructFields ?? "", /params:vec4f/);
    // The vertex stage is untouched, which is why a custom layer draws with
    // the stock vertex shader.
    const plain = new SpriteLowerer(new LoweringContext()).shaderSource();
    assert.equal(shader.vertexBody, plain.vertexBody);
    assert.equal(plain.fxStructFields, undefined);
});

test("composes the pinned depth-hosted sprite vertex permutation", () => {
    const shader = new SpriteLowerer(new LoweringContext()).shaderSource(
        false,
        undefined,
        [],
        true,
    );
    assert.match(shader.instanceStructFields, /@location\(6\)z:f32/);
    assert.match(shader.vertexBody, /out\.p=vec4f\(n,1 - in\.z,1\)/);
});

test("declares both fragment uniform blocks for a custom sprite layer", () => {
    const wgsl = spriteFragmentWgsl(
        "test",
        new SpriteLowerer(new LoweringContext()).shaderSource(
            false,
            TINT_BODY,
        ),
    );
    // The fx block sits beside the layer block, and both are declared
    // whether or not this body reads them — the one it leaves alone does not
    // reach the compiled shader, and which slots the survivors took is
    // published beside that shader rather than decided from the text.
    assert.match(wgsl, /@group\(3\) @binding\(0\) var<uniform> L: Lr/);
    assert.match(wgsl, /@group\(3\) @binding\(1\) var<uniform> fx/);
    // A plain layer has no fx block to declare.
    assert.ok(
        !spriteFragmentWgsl(
            "test",
            new SpriteLowerer(new LoweringContext()).shaderSource(),
        ).includes("SpriteFx"),
    );
});

test("gives the custom billboard program its own vertex stage", () => {
    const custom = billboards().shaderSource(
        "facing",
        "transparent",
        TINT_BODY,
    );
    const plain = billboards().shaderSource();
    // The pin's billboard composer exposes the view distance and the world
    // position to a custom body, so unlike the 2D family its vertex stage
    // is not the stock one.
    assert.notEqual(custom.vertexBody, plain.vertexBody);
    assert.match(custom.varyingStructFields, /viewDist/);
    assert.equal(custom.fragmentBody, TINT_BODY);
    const wgsl = billboardFragmentWgsl("test", custom);
    assert.match(wgsl, /@group\(3\) @binding\(0\) var<uniform> billboards/);
    assert.match(wgsl, /@group\(3\) @binding\(1\) var<uniform> fx/);
});

test("refuses pixels that generation cannot produce", () => {
    // The bytes are baked by running the module, so the argument has to
    // name a function generation can call rather than any other value.
    assert.throws(
        () =>
            compileSource(
                "import {\n    createEngine,\n    createSprite2DCustomShader,\n    createSprite2DLayer,\n    createSpriteRenderer,\n    createTexture2DFromPixels,\n    loadSpriteAtlas,\n    registerSpriteRenderer,\n    startEngine,\n} from \"babylon-lite\";\nimport { getCutoutSpriteAtlasDataUrl } from \"../corpus/babylon-lite/lab/lite/src/_shared/sprite-atlas-cutout\";\nimport { PALETTE_WIDTH } from \"../corpus/babylon-lite/lab/lite/src/_shared/palette-remap\";\n\nasync function main(): Promise<void> {\n    const canvas = document.getElementById(\"renderCanvas\") as HTMLCanvasElement;\n    const engine = await createEngine(canvas);\n    const atlas = await loadSpriteAtlas(engine, getCutoutSpriteAtlasDataUrl(), {\n        gridSize: [32, 32],\n        sampling: \"nearest\",\n    });\n    const paletteTexture = createTexture2DFromPixels(engine, PALETTE_WIDTH as unknown as Uint8Array, 256, 1);\n    const customShader = createSprite2DCustomShader({\n        fragment: \"return textureSample(paletteTex, paletteSamp, in.uv);\",\n        extraTextures: [{ name: \"palette\", texture: paletteTexture }],\n    });\n    const layer = createSprite2DLayer(atlas, { capacity: 4, depth: \"none\", customShader });\n    const sr = createSpriteRenderer(engine, { layers: [layer] });\n    registerSpriteRenderer(sr);\n    await startEngine(engine);\n}\nmain();",
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
                "import {\n    createEngine,\n    createSprite2DCustomShader,\n    createSprite2DLayer,\n    createSpriteRenderer,\n    createTexture2DFromPixels,\n    loadSpriteAtlas,\n    registerSpriteRenderer,\n    startEngine,\n} from \"babylon-lite\";\nimport { getCutoutSpriteAtlasDataUrl } from \"../corpus/babylon-lite/lab/lite/src/_shared/sprite-atlas-cutout\";\nimport { buildColormapPalette } from \"../corpus/babylon-lite/lab/lite/src/_shared/palette-remap\";\n\nasync function main(): Promise<void> {\n    const canvas = document.getElementById(\"renderCanvas\") as HTMLCanvasElement;\n    const engine = await createEngine(canvas);\n    const atlas = await loadSpriteAtlas(engine, getCutoutSpriteAtlasDataUrl(), {\n        gridSize: [32, 32],\n        sampling: \"nearest\",\n    });\n    const paletteTexture = createTexture2DFromPixels(\n        engine, buildColormapPalette(), 256, 1, { srgb: true });\n    const customShader = createSprite2DCustomShader({\n        fragment: \"return textureSample(paletteTex, paletteSamp, in.uv);\",\n        extraTextures: [{ name: \"palette\", texture: paletteTexture }],\n    });\n    const layer = createSprite2DLayer(atlas, { capacity: 4, depth: \"none\", customShader });\n    const sr = createSpriteRenderer(engine, { layers: [layer] });\n    registerSpriteRenderer(sr);\n    await startEngine(engine);\n}\nmain();",
        { fileName: "examples/options.ts" },
    );
    assert.match(result.cpp, /PixelsTextureOptions\{[^\n]*true\}/);
});
