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

test("folds the pinned extra-binding loop to the empty text", () => {
    const text = new PinnedShaderText(new LoweringContext());
    // Nothing binds an extra texture yet, so every reached permutation binds
    // the empty list and the loop settles without running.
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
    // A list with something in it would emit bindings nothing fills, so it
    // refuses rather than composing a shader the backends cannot bind.
    assert.throws(
        () =>
            text.evaluate(
                "src/sprite/custom-shader-core.ts",
                "makeExtraBindingsWgsl",
                new Map<string, ShaderTextBinding>([
                    ["group", "1"],
                    ["startBinding", 3],
                    ["extras", [{ name: "palette" }]],
                ]),
            ),
        /emits per-element text/,
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
