/**
 * The lifted background/grid/utility WGSL, asserted against the real pinned
 * package: the lift finds each literal, the emitted fragments carry the pin's
 * own arms under the native binding contract, and a doctored pin fails
 * generation naming the missing piece instead of falling back to a copy.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
    backgroundGroundFragmentWgsl,
    backgroundSkyboxFragmentWgsl,
    readPinnedBackgroundGroundSource,
    readPinnedBackgroundSkyboxSource,
    readPinnedDitherWgsl,
} from "../src/shader-builtins-background.js";
import {
    gridFragmentWgsl,
    gridVertexWgsl,
} from "../src/shader-builtins-grid.js";
import {
    fogFactorWgsl,
    imageProcessingFragmentWgsl,
    imageProcessingMultisampledFragmentWgsl,
} from "../src/shader-builtins-utility.js";
import {
    UpstreamSourceStore,
    findRepositoryRoot,
    readUpstreamPin,
} from "../src/upstream-source.js";

function pinnedPackageRoot(): string {
    const repositoryRoot = findRepositoryRoot();
    const pin = readUpstreamPin(repositoryRoot);
    return resolve(
        repositoryRoot,
        "node_modules",
        ...pin.package.split("/"),
    );
}

// ---------------------------------------------------------------------------
// Background ground
// ---------------------------------------------------------------------------

test("lifts the pinned ground fragment with both dither arms", () => {
    const pinned = readPinnedBackgroundGroundSource(pinnedPackageRoot());
    const dithered = backgroundGroundFragmentWgsl("p", pinned, true);
    const undithered = backgroundGroundFragmentWgsl("p", pinned);

    // The pin's own noise selection: WGSL_DITHER in the dithered file, the
    // zero-noise WGSL_NO_DITHER stand-in (same body) in the other.
    assert.match(
        dithered,
        /fn dither\(seed: vec2<f32>, varianceAmount: f32\) -> f32 \{/,
    );
    assert.ok(dithered.includes("43758.5453"));
    assert.ok(
        undithered.includes(
            "fn dither(a:vec2<f32>,b:f32)->f32{return 0.0;}",
        ),
    );
    const [ditherHead] = dithered.split("fn dither(");
    assert.equal(
        dithered.slice(dithered.indexOf("@group(2)")),
        undithered.slice(undithered.indexOf("@group(2)")),
        "the two ground variants share the pin's body",
    );
    assert.match(ditherHead!, /^\/\/ p\n$/);

    // The pin's statements, re-homed onto the plan's flattened block: the
    // module's own applyImageProcessing gate, premultiply, seeded dither,
    // and final clamp, in the pin's order.
    assert.ok(
        dithered.includes(
            "if (uniforms.imageParameters.y>=0.0){a=applyImageProcessing(a);}",
        ),
    );
    assert.ok(dithered.includes("a=vec4<f32>(a.rgb*a.a,a.a);"));
    assert.ok(
        dithered.includes(
            "a=vec4<f32>(a.rgb+vec3<f32>(dither(b.worldPosition.xy,0.5)),a.a);",
        ),
    );
    assert.ok(dithered.includes("a=max(a,vec4<f32>(0.0));"));
    assert.ok(
        dithered.includes("const tonemappingCalibration: f32 = 1.590579;"),
    );

    // The binding contract the PAL uploads against is unchanged.
    assert.match(dithered, /@group\(2\) @binding\(0\) var \w+: texture_2d<f32>;/);
    assert.match(dithered, /@group\(2\) @binding\(1\) var \w+: sampler;/);
    assert.ok(
        dithered.includes(
            "struct GroundUniforms {\n    primaryColorAlpha: vec4<f32>,\n    backgroundCenter: vec4<f32>,\n    cameraExposure: vec4<f32>,\n    imageParameters: vec4<f32>,\n}",
        ),
    );
    assert.match(
        dithered,
        /@group\(3\) @binding\(0\) var<uniform> uniforms: GroundUniforms;/,
    );
    assert.match(dithered, /fn mainFragment\(\w+: FragmentInput\)/);
    assert.doesNotMatch(dithered, /(?:mesh|scene)\.\w+/);
});

// ---------------------------------------------------------------------------
// Background skyboxes (defect D8)
// ---------------------------------------------------------------------------

test("the DDS skybox file carries the pin's single high-contrast arm", () => {
    const pinned = readPinnedBackgroundSkyboxSource(pinnedPackageRoot());
    const dds = backgroundSkyboxFragmentWgsl("p", pinned, true);

    // D8: the pinned DDS fragment folds contrast through the high arm only;
    // a reappearing low arm means the lift regressed to a merged fragment.
    assert.ok(dds.includes("a=mix(a,f,uniforms.imageParameters.x-1.0);"));
    assert.doesNotMatch(dds, /mix\(vec3<f32>\(0\.5\)/);

    // The pin's own image-processing block: unconditional tone mapping
    // inside the gate, `saturate`, and the dither before the final clamp.
    assert.ok(dds.includes("if (uniforms.imageParameters.z>=0.0){"));
    assert.ok(dds.includes("a=1.0-exp2(-1.590579*a);"));
    assert.ok(dds.includes("a=saturate(a);"));
    assert.ok(
        dds.includes("a=a+vec3<f32>(dither(b.worldPosition.xy,0.5));"),
    );
    assert.ok(dds.includes("a*=uniforms.primaryColorExposure.rgb;"));

    // Binding contract.
    assert.match(dds, /@group\(2\) @binding\(0\) var \w+: texture_cube<f32>;/);
    assert.match(
        dds,
        /@group\(3\) @binding\(0\) var<uniform> uniforms: SkyboxUniforms;/,
    );
    assert.match(dds, /fn mainFragment\(\w+: FragmentInput\)/);
    assert.doesNotMatch(dds, /(?:mesh|scene)\.\w+/);
});

test("the HDR skybox file carries the pin's two-arm, no-tonemap fold", () => {
    const pinned = readPinnedBackgroundSkyboxSource(pinnedPackageRoot());
    const hdr = backgroundSkyboxFragmentWgsl("p", pinned);

    // The pinned environment-cubemap fragment: exposure, gamma, both
    // contrast arms — and neither tone mapping nor noise nor a primary
    // colour multiply exists to reach.
    assert.ok(
        hdr.includes(
            "if (uniforms.imageParameters.x<1.0){a=mix(vec3<f32>(0.5),a,uniforms.imageParameters.x);} else{a=mix(a,f,uniforms.imageParameters.x-1.0);}",
        ),
    );
    assert.ok(hdr.includes("a*=uniforms.primaryColorExposure.a;"));
    assert.doesNotMatch(hdr, /1\.590579/);
    assert.doesNotMatch(hdr, /dither\(/);
    assert.doesNotMatch(hdr, /primaryColorExposure\.rgb/);
    assert.match(hdr, /fn mainFragment\(\w+: FragmentInput\)/);
    assert.doesNotMatch(hdr, /(?:mesh|scene)\.\w+/);
});

test("a reshaped pinned background literal fails generation by name", () => {
    const pinned = readPinnedBackgroundGroundSource(pinnedPackageRoot());
    assert.throws(
        () =>
            backgroundGroundFragmentWgsl("p", {
                ...pinned,
                fragment: pinned.fragment.replace(
                    "backgroundCenter",
                    "centre",
                ),
            }),
        /ground fragment mesh uniform block/,
    );
    assert.throws(
        () =>
            backgroundGroundFragmentWgsl("p", {
                ...pinned,
                imageProcessing: pinned.imageProcessing.replace(
                    "scene.vImageInfos.x",
                    "scene.vImageInfos.q",
                ),
            }),
        /ground applyImageProcessing/,
    );
    const skybox = readPinnedBackgroundSkyboxSource(pinnedPackageRoot());
    assert.throws(
        () =>
            backgroundSkyboxFragmentWgsl(
                "p",
                {
                    ...skybox,
                    ddsFragment: skybox.ddsFragment.replace(
                        "exposureLinear",
                        "exposure",
                    ),
                },
                true,
            ),
        /DDS skybox fragment/,
    );
});

test("the dither pair is read from the pin's own helpers module", () => {
    const dither = readPinnedDitherWgsl(pinnedPackageRoot());
    assert.match(dither.dither, /fract\(sin\(dot\(seed/);
    assert.ok(dither.noDither.includes("return 0.0;"));
});

// ---------------------------------------------------------------------------
// Utility: image processing and fog
// ---------------------------------------------------------------------------

test("lifts the pinned ip() and per-sample loop for image processing", () => {
    const single = imageProcessingFragmentWgsl();
    const multi = imageProcessingMultisampledFragmentWgsl();

    // The pin's parameter block, byte for byte, re-addressed to space 3 —
    // it lays out exactly like the 16 bytes the PAL pushes.
    for (const fragment of [single, multi]) {
        assert.ok(fragment.includes("struct P{e:f32,c:f32,t:f32,p:f32}"));
        assert.ok(
            fragment.includes("@group(3)@binding(0)var<uniform> p:P;"),
        );
        assert.ok(fragment.includes("fn ip(r:vec4f)->vec4f{"));
        assert.ok(fragment.includes("if(p.t>0.5){c=1.0-exp2(-1.590579*c);}"));
        assert.ok(
            fragment.includes(
                "if(p.c<1.0){c=mix(vec3f(0.5),c,p.c);}else{c=mix(c,h,p.c-1.0);}",
            ),
        );
        assert.match(fragment, /fn mainFragment\(input: FragmentInput\)/);
    }

    // Single-sample keeps the sampler-pair wrapper the PAL binds.
    assert.ok(
        single.includes(
            "@group(2) @binding(0) var sourceTexture: texture_2d<f32>;",
        ),
    );
    assert.ok(single.includes("return ip(textureSampleLevel("));

    // The multisampled arm is the pin's loop: ip() per sample, averaged
    // after the loop — the order is the semantics.
    assert.ok(
        multi.includes(
            "@group(2) @binding(0) var sourceTexture: texture_multisampled_2d<f32>;",
        ),
    );
    assert.ok(multi.includes("let n=textureNumSamples(sourceTexture);"));
    assert.ok(
        multi.includes(
            "for(var i=0u;i<n;i++){c+=ip(textureLoad(sourceTexture,px,i));}",
        ),
    );
    assert.ok(
        multi.indexOf("ip(textureLoad(") < multi.indexOf("return c/f32(n);"),
        "samples are processed before the average",
    );
    assert.doesNotMatch(multi, /\bq\.xy\b/);
});

test("lifts the pinned WGSL_FOG with the documented renames", () => {
    const fog = fogFactorWgsl();
    assert.ok(fog.startsWith("const bblFogE: f32 = 2.71828;"));
    assert.ok(
        fog.includes("fn bblCalcFogFactor(fogDistance: vec3<f32>) -> f32 {"),
    );
    // The pin's own three falloff arms over the consumers' uniform slot.
    assert.ok(
        fog.includes(
            "if (fogMode == 3.0) { fogCoeff = (fogEnd - dist) / (fogEnd - fogStart); }",
        ),
    );
    assert.ok(
        fog.includes(
            "else if (fogMode == 1.0) { fogCoeff = 1.0 / pow(bblFogE, dist * fogDensity); }",
        ),
    );
    assert.ok(
        fog.includes(
            "else if (fogMode == 2.0) { fogCoeff = 1.0 / pow(bblFogE, dist * dist * fogDensity * fogDensity); }",
        ),
    );
    assert.ok(fog.includes("let fogMode = uniforms.fogInfos.x;"));
    assert.doesNotMatch(fog, /scene\./);
    assert.doesNotMatch(fog, /E_FOG|[^l]calcFogFactor/);
});

// ---------------------------------------------------------------------------
// Grid material
// ---------------------------------------------------------------------------

const gridModulePath = "src/material/grid/grid-material.ts";

test("builds the grid WGSL by evaluating the pinned template functions", () => {
    const store = new UpstreamSourceStore();
    const file = store.getSourceFile(gridModulePath);
    const vertex = gridVertexWgsl("p", file);
    const fragment = gridFragmentWgsl("p", file);

    // Vertex: the pin's pass-throughs over the native attribute layout, with
    // the three-matrix product folded into the plan's view-projection.
    assert.ok(
        vertex.includes(
            "out.position=uniforms.viewProjection*vec4<f32>(input.position,1.0);",
        ),
    );
    assert.ok(vertex.includes("out.vPosition=input.localPosition;"));
    assert.ok(vertex.includes("out.vNormal=input.localNormal;"));
    assert.ok(vertex.includes("@location(4) localPosition: vec3<f32>"));
    assert.ok(vertex.includes("@location(7) localNormal: vec3<f32>"));
    assert.match(vertex, /@vertex fn mainVertex\(input:VertexInput\)/);
    assert.match(
        vertex,
        /@group\(1\) @binding\(0\) var<uniform> uniforms: VertexUniforms;/,
    );

    // Fragment: each runtime gate wraps the pin's own built arm.
    assert.ok(
        fragment.includes(
            "if (shaderUniforms.options.y>0.5){fr=clamp(fr,-1.0,1.0);return 0.5+0.5*cos(fr*PI);}if(abs(fr)<SQRT2/4.0){return 1.0;}return 0.0;",
        ),
    );
    assert.ok(
        fragment.includes(
            "var grid=clamp(x+y+z,0.0,1.0);if (shaderUniforms.options.z>0.5){grid=clamp(max(max(x,y),z),0.0,1.0);}",
        ),
    );
    assert.ok(
        fragment.includes(
            "if (shaderUniforms.options.x>0.5){opacity=clamp(grid,0.08,shaderUniforms.gridControl.w*grid);}",
        ),
    );
    assert.ok(
        fragment.includes(
            "if (shaderUniforms.options.x>0.5 && shaderUniforms.options.w>0.5){rgb=rgb*opacity;}",
        ),
    );

    // The flattened uniform re-homing and the untouched pinned reads.
    assert.ok(
        fragment.includes(
            "mix(shaderUniforms.mainColor.rgb,shaderUniforms.lineColor.rgb,vec3<f32>(grid))",
        ),
    );
    assert.ok(
        fragment.includes(
            "(input.vPosition+shaderUniforms.gridOffsetVisibility.xyz)",
        ),
    );
    assert.ok(
        fragment.includes("opacity*shaderUniforms.gridOffsetVisibility.w"),
    );
    assert.ok(fragment.includes("fn gridNormalImpact(x:f32)->f32"));
    assert.match(
        fragment,
        /@group\(3\) @binding\(0\) var<uniform> shaderUniforms: GridUniforms;/,
    );
    assert.match(fragment, /@fragment fn mainFragment\(input:VertexOutput\)/);
    assert.doesNotMatch(fragment, /shaderSystem\./);
});

test("a grid template the evaluator cannot fold fails generation", () => {
    const doctored = ts.createSourceFile(
        gridModulePath,
        "function buildFragmentSource(opts: unknown): string { return dynamic(); }",
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    assert.throws(
        () => gridFragmentWgsl("p", doctored),
        /Pinned Babylon Lite grid template changed/,
    );
    assert.throws(
        () =>
            gridVertexWgsl(
                "p",
                ts.createSourceFile(
                    gridModulePath,
                    "const unrelated = 1;",
                    ts.ScriptTarget.Latest,
                    true,
                    ts.ScriptKind.TS,
                ),
            ),
        /no function 'buildVertexSource'/,
    );
});
