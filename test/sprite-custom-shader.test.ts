import assert from "node:assert/strict";
import test from "node:test";

import { LoweringContext } from "../src/lowering/context.js";
import {
    PinnedShaderText,
    type ShaderTextBinding,
} from "../src/lowering/pinned-shader-text.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import { BillboardLowerer } from "../src/lowering/billboard-lowerer.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import {
    fragmentUniformSlots,
    stageReadsBlock,
} from "../src/shader-builtins-sprite-fx.js";
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
    // The loop runs once per extra texture, stepping the binding by two.
    // Folding it rather than emitting the lines here is what keeps a
    // changed binding rule the pin's.
    assert.equal(
        text.evaluate(
            "src/sprite/custom-shader-core.ts",
            "makeExtraBindingsWgsl",
            new Map<string, ShaderTextBinding>([
                ["group", "1"],
                ["startBinding", 3],
                ["extras", [{ name: "palette" }, { name: "noise" }]],
            ]),
        ),
        "@group(1) @binding(3) var paletteTex: texture_2d<f32>;\n" +
            "@group(1) @binding(4) var paletteSamp: sampler;\n" +
            "@group(1) @binding(5) var noiseTex: texture_2d<f32>;\n" +
            "@group(1) @binding(6) var noiseSamp: sampler;\n",
    );
    // With no extras the loop runs zero times, which is every reached scene.
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

test("composes the custom sprite program from the pin's own builder", () => {
    const shader = new SpriteLowerer(new LoweringContext()).shaderSource(
        false,
        TINT_BODY,
    );
    // The caller's body, verbatim, inside the stage the engine owns.
    assert.equal(shader.fragmentBody, TINT_BODY);
    // The fx struct is the pin's, not a copy: its padding slots are the
    // ones `writeSpriteFxUbo` skips.
    assert.match(shader.fxStructFields ?? "", /time: f32/);
    assert.match(shader.fxStructFields ?? "", /params: vec4f/);
    // The vertex stage is untouched, which is why a custom layer draws with
    // the stock vertex shader.
    const plain = new SpriteLowerer(new LoweringContext()).shaderSource();
    assert.equal(shader.vertexBody, plain.vertexBody);
    assert.equal(plain.fxStructFields, undefined);
});

test("declares only the fragment uniform blocks a body reads", () => {
    assert.ok(stageReadsBlock("a * fx.params;", "fx"));
    assert.ok(!stageReadsBlock("TOTAL.x", "L"));
    // A body that owns its own alpha reads neither the layer block nor,
    // when it names no `fx`, the fx block. Declaring a block nothing reads
    // would shift the SDL_GPU slots behind it, because a block the compiled
    // shader drops takes its slot with it.
    assert.deepEqual(
        fragmentUniformSlots({
            fragmentBody: "return vec4f(1);",
            fxStructFields: "time: f32,",
        }),
        { layerBlock: -1, fxBlock: -1 },
    );
    assert.deepEqual(
        fragmentUniformSlots({
            fragmentBody: TINT_BODY,
            fxStructFields: "time: f32,",
        }),
        { layerBlock: -1, fxBlock: 0 },
    );
    assert.deepEqual(
        fragmentUniformSlots({
            fragmentBody: "return vec4f(L.opacityMul * fx.params);",
            fxStructFields: "time: f32,",
        }),
        { layerBlock: 0, fxBlock: 1 },
    );
    // The stock stage reads its family's block and has no fx block at all.
    assert.deepEqual(
        fragmentUniformSlots(
            new SpriteLowerer(new LoweringContext()).shaderSource(),
        ),
        { layerBlock: 0, fxBlock: -1 },
    );
});

test("binds the custom sprite fx block at the slot it declares", () => {
    const wgsl = spriteFragmentWgsl(
        "test",
        new SpriteLowerer(new LoweringContext()).shaderSource(
            false,
            TINT_BODY,
        ),
    );
    assert.match(wgsl, /@group\(3\) @binding\(0\) var<uniform> fx/);
    // The layer block this body never reads is not declared.
    assert.ok(!wgsl.includes("var<uniform> L:"));
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
    assert.match(wgsl, /@group\(3\) @binding\(0\) var<uniform> fx/);
    assert.ok(!wgsl.includes("var<uniform> billboards:"));
});
