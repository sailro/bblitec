import assert from "node:assert/strict";
import test from "node:test";
import { lowerWgslShaderProgram } from "../src/shader-ir.js";
import { emitNativeWgslProgram } from "../src/shader-wgsl-emitter.js";
import {
    composeStandaloneWgsl,
    getShaderMaterialProgram,
} from "../src/shader-material-programs.js";
import {
    blitFragmentWgsl,
    blitVertexWgsl,
    depthOnlyFragmentWgsl,
    diagnosticClusterFragmentWgsl,
    diagnosticIdFragmentWgsl,
    imageProcessingFragmentWgsl,
} from "../src/shader-builtins-utility.js";
import {
    backgroundGroundFragmentWgsl,
    backgroundSkyboxFragmentWgsl,
} from "../src/shader-builtins-background.js";
import { materialVertexWgsl } from "../src/shader-builtins-material.js";
import { standardFragmentWgsl } from "../src/shader-builtins-standard.js";
import { pbrFragmentWgsl } from "../src/shader-builtins-pbr.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("lowers reached alpha-card WGSL through typed reflection", () => {
    const program = lowerWgslShaderProgram(
        getShaderMaterialProgram("alpha-card"),
    );
    assert.deepEqual(program.reflection.attributes, [
        { name: "position", location: 0, type: "vec3<f32>" },
    ]);
    assert.deepEqual(
        program.reflection.uniformBlocks.map(
            ({ stage, space, size, members }) => ({
                stage,
                space,
                size,
                members: members.map(
                    ({ name, offset, size: memberSize, components }) => ({
                        name,
                        offset,
                        size: memberSize,
                        components,
                    }),
                ),
            }),
        ),
        [
            {
                stage: "vertex",
                space: 1,
                size: 16,
                members: [
                    { name: "center", offset: 0, size: 8, components: "xy" },
                    { name: "angle", offset: 8, size: 4, components: "z" },
                    { name: "depth", offset: 12, size: 4, components: "w" },
                ],
            },
            {
                stage: "fragment",
                space: 3,
                size: 16,
                members: [
                    { name: "color", offset: 0, size: 12, components: "xyz" },
                    { name: "opacity", offset: 12, size: 4, components: "w" },
                ],
            },
        ],
    );
    const vertex = emitNativeWgslProgram(program, "vertex");
    const fragment = emitNativeWgslProgram(program, "fragment");
    assert.match(vertex, /@group\(1\) @binding\(0\)/);
    assert.match(vertex, /shaderUniforms\.center/);
    assert.match(vertex, /1\.0 - shaderUniforms\.depth/);
    assert.match(fragment, /@group\(3\) @binding\(0\)/);
    assert.match(fragment, /shaderUniforms\.opacity/);
});

test("lowers matrix, varying, branch, and discard WGSL nodes", () => {
    const program = lowerWgslShaderProgram(
        getShaderMaterialProgram("circular-cutout"),
    );
    assert.deepEqual(
        program.reflection.varyings.map(
            ({ name, type, attribute }) => ({ name, type, attribute }),
        ),
        [
            {
                name: "position",
                type: "vec4<f32>",
                attribute: { kind: "builtin", value: "position" },
            },
            {
                name: "uv",
                type: "vec2<f32>",
                attribute: { kind: "location", value: 0 },
            },
        ],
    );
    assert.deepEqual(
        program.reflection.uniformBlocks.map(
            ({ stage, space, size, systemMatrix }) => ({
                stage,
                space,
                size,
                systemMatrix,
            }),
        ),
        [
            {
                stage: "vertex",
                space: 1,
                size: 64,
                systemMatrix: true,
            },
        ],
    );
    const vertex = emitNativeWgslProgram(program, "vertex");
    const fragment = emitNativeWgslProgram(program, "fragment");
    assert.match(vertex, /@location\(3\) uv: vec2<f32>/);
    assert.match(vertex, /shaderSystem\.worldViewProjection \* vec4<f32>/);
    assert.match(fragment, /distance\(input\.uv, vec2<f32>\(0\.5, 0\.5\)\) < 0\.18/);
    assert.match(fragment, /\sdiscard;/);
});

test("composes Babylon custom shader snippets into standalone WGSL", () => {
    const source = composeStandaloneWgsl(
        getShaderMaterialProgram("circular-cutout"),
        "struct Scene {} @group(0) @binding(0) var<uniform> scene: Scene;",
        "vertex",
    );
    assert.match(source, /@group\(0\) @binding\(0\)/);
    assert.match(source, /worldViewProjection: mat4x4<f32>/);
    assert.match(source, /@group\(1\) @binding\(0\) var<uniform> shaderSystem/);
    assert.doesNotMatch(source, /var<uniform> shaderUniforms/);
    assert.match(source, /@location\(0\) position: vec3<f32>/);
    assert.match(source, /@location\(1\) uv: vec2<f32>/);
    assert.match(source, /@vertex\s+fn mainVertex/);
});

test("generates Tint utility WGSL entry points and bindings", () => {
    assert.match(blitVertexWgsl(), /@builtin\(vertex_index\)/);
    assert.match(blitFragmentWgsl(), /@group\(2\) @binding\(1\) var sourceSampler/);
    assert.match(blitFragmentWgsl(), /textureSampleLevel/);
    assert.match(imageProcessingFragmentWgsl(), /source\.rgb \* uniforms\.parameters\.x/);
    assert.match(imageProcessingFragmentWgsl(), /1\.590579/);
    assert.match(depthOnlyFragmentWgsl(), /@fragment\s+fn mainFragment\(\)/);
    assert.match(diagnosticIdFragmentWgsl(), /@group\(3\) @binding\(0\)/);
    assert.match(diagnosticIdFragmentWgsl(), /textureSample/);
    assert.match(diagnosticClusterFragmentWgsl(), /@builtin\(primitive_index\)/);
    assert.match(diagnosticClusterFragmentWgsl(), /clusterId >> 16u/);
});

test("generates Tint background WGSL for 2D and cube textures", () => {
    const ground = backgroundGroundFragmentWgsl("ground provenance");
    const skybox = backgroundSkyboxFragmentWgsl("skybox provenance");
    assert.match(ground, /texture_2d<f32>/);
    assert.match(ground, /color \* alpha/);
    assert.match(ground, /1\.590579/);
    assert.match(skybox, /texture_cube<f32>/);
    assert.match(skybox, /textureSampleLevel/);
    assert.match(skybox, /primaryColorExposure/);
    assert.match(skybox, /imageParameters\.w < 0\.5/);
});

test("carries the three-kind analytic light contract in the PBR template", () => {
    const template = readFileSync(
        resolve(
            "src/lowering/templates/renderer/pbr.frag.wgsl",
        ),
        "utf8",
    );
    // Primary slot: directional (w = 2), point (w = 1), hemispheric.
    assert.match(
        template,
        /if \(\(FragmentUniforms\.lightDirection\.w > 1\.5f\)\) \{/,
    );
    assert.match(
        template,
        /let bblDirectionalL = normalize\(-\(FragmentUniforms\.lightDirection\.xyz\)\);/,
    );
    // Second analytic slot accumulates through the shared extra terms.
    assert.match(
        template,
        /if \(\(FragmentUniforms\.lightColor2\.w > 0\.0f\)\) \{/,
    );
    assert.match(
        template,
        /\+ \(bblExtraDiffuse \+ bblExtraSpecular\)\) \+ v_40;/,
    );
});

test("generates the shared Tint material vertex interface", () => {
    const staticVertex = materialVertexWgsl();
    const vertex = materialVertexWgsl(true);
    const instancedVertex = materialVertexWgsl(false, true);
    const deformedInstancedVertex = materialVertexWgsl(true, true);
    assert.doesNotMatch(staticVertex, /DeformationUniforms/);
    assert.doesNotMatch(staticVertex, /@location\(8\) joints/);
    assert.match(vertex, /@location\(6\) color: vec4<f32>/);
    assert.match(vertex, /@location\(5\) uv2: vec2<f32>/);
    assert.match(vertex, /uniforms\.viewProjection \* vec4<f32>/);
    assert.match(vertex, /output\.worldPosition = worldPosition/);
    assert.match(vertex, /boneMatrices: array<mat4x4<f32>, 64>/);
    assert.match(vertex, /input\.morphPosition0/);
    assert.match(vertex, /@location\(15\) morphTangent1: vec3<f32>/);
    assert.match(vertex, /deformation\.options\.y < 0\.5/);
    assert.match(instancedVertex, /@binding\(1\).*instanceUniforms/);
    assert.match(
        instancedVertex,
        /instanceUniforms\.parentWorld \* localInstanceMatrix/,
    );
    assert.match(
        deformedInstancedVertex,
        /@binding\(2\).*instanceUniforms/,
    );
});

test("generates Tint Standard material and geometry WGSL", () => {
    const fragment = standardFragmentWgsl("standard provenance");
    const geometry = standardFragmentWgsl("geometry provenance", {
        shaderIndex: 0,
        attachments: ["WORLD_POSITION", "REFLECTIVITY"],
        emitColor: true,
    });
    assert.match(fragment, /texture_cube<f32>/);
    assert.match(fragment, /lightData2: vec4<f32>/);
    assert.match(fragment, /light1\.diffuse \+ light2\.diffuse/);
    assert.doesNotMatch(fragment, /@builtin\(front_facing\)/);
    assert.match(fragment, /return color/);
    assert.match(geometry, /struct FragmentOutput/);
    assert.match(geometry, /@location\(2\) color/);
    assert.match(geometry, /output\.f1 = vec4<f32>/);
});

test("adds the pinned Standard vertex-color slot only when reached", () => {
    const plain = standardFragmentWgsl("standard provenance");
    const colored = standardFragmentWgsl(
        "standard provenance",
        undefined,
        false,
        true,
    );
    assert.doesNotMatch(plain, /@location\(6\) color/);
    assert.doesNotMatch(plain, /baseColor \*=/);
    assert.match(plain, /let baseColor =/);
    // std-vertex-color-fragment.ts multiplies the base color by the RGB
    // in the alpha-test slot and leaves alpha alone without the
    // mesh.hasVertexAlpha opt-in.
    assert.match(colored, /@location\(6\) color: vec4<f32>,/);
    assert.match(colored, /var baseColor =/);
    assert.match(colored, /baseColor \*= input\.color\.rgb;/);
    assert.doesNotMatch(colored, /alpha \*= input\.color\.a/);
    assert.equal(
        colored
            .replace("    @location(6) color: vec4<f32>,\n", "")
            .replace("\n    baseColor *= input.color.rgb;", "")
            .replace("    var baseColor =", "    let baseColor ="),
        plain,
    );
    assert.throws(
        () =>
            standardFragmentWgsl(
                "geometry provenance",
                {
                    shaderIndex: 0,
                    attachments: ["ALBEDO"],
                    emitColor: true,
                },
                false,
                true,
            ),
        /color fragment variant/,
    );
});

test("generates Tint PBR color, diagnostics, and geometry WGSL", () => {
    const converted = readFileSync(
        resolve("src/lowering/templates/renderer/pbr.frag.wgsl"),
        "utf8",
    );
    const color = pbrFragmentWgsl(converted, { kind: "color" });
    const diagnostic = pbrFragmentWgsl(converted, {
        kind: "diagnostic",
        group: "c",
    });
    const geometry = pbrFragmentWgsl(converted, {
        kind: "geometry",
        task: {
            shaderIndex: 0,
            attachments: ["LOCAL_POSITION", "WORLD_NORMAL"],
            emitColor: true,
        },
    });
    assert.match(color, /fn mainFragment/);
    assert.match(color, /@location\(6u\) v_118/);
    assert.match(color, /normalOptions\.w/);
    assert.doesNotMatch(color, /sceneTransmission = pow/);
    assert.doesNotMatch(color, /sceneTransmission = -log2/);
    assert.match(color, /imageProcessingOptions\.x/);
    assert.match(color, /@binding\(12u\) var sceneColorTexture/);
    assert.match(color, /refract\(/);
    assert.match(color, /exp\(FragmentUniforms\.volumeParams\.rgb \* thickness\)/);
    assert.match(color, /v_119, bblBitangent\);/);
    // The pinned tangent frame: pbr-template.ts composes
    // mat3x3(worldTangent, worldBitangent, worldNormal) from the raw varyings
    // and normalizes the sample before the frame. The bitangent arrives as its
    // own varying rather than being rebuilt here, because cross() does not
    // survive a blended skin matrix.
    assert.match(
        color,
        /mat3x3<f32>\(v_3\.xyz, bblBitangent, v_2\)/,
    );
    assert.match(color, /v_22 \* normalize\(v_8\)/);
    assert.doesNotMatch(color, /normalize\(cross\(v_7, v_23\)\)/);
    assert.match(diagnostic, /bblOutput\.preToneHdr/);
    assert.match(diagnostic, /v_119,\s*bblBitangent,\s*\);/);
    assert.match(geometry, /bblLocalPosition/);
    assert.match(
        geometry,
        /v_119,\s*bblBitangent,\s*bblPosition,\s*bblLocalPosition,/,
    );
    assert.match(geometry, /bblOutput\.color/);
});
