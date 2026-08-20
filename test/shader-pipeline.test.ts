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
    readPinnedBackgroundGroundSource,
    readPinnedBackgroundSkyboxSource,
} from "../src/shader-builtins-background.js";
import {
    findRepositoryRoot,
    readUpstreamPin,
} from "../src/upstream-source.js";
import { resolve } from "node:path";
import { materialVertexWgsl } from "../src/shader-builtins-standard.js";

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
    // The scene's own clip-space depth reaches the stage verbatim: the
    // renderer shares the pin's convention, so there is nothing to correct.
    assert.match(vertex, /out\.position = vec4<f32>\(.*shaderUniforms\.depth, 1\.0\)/);
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
    // The lifted pinned `ip()`: the pin's own parameter block and exposure
    // multiply, under the native fragment uniform space.
    assert.match(imageProcessingFragmentWgsl(), /var c=r\.rgb\*p\.e;/);
    assert.match(imageProcessingFragmentWgsl(), /@group\(3\)@binding\(0\)var<uniform> p:P;/);
    assert.match(imageProcessingFragmentWgsl(), /1\.590579/);
    assert.match(depthOnlyFragmentWgsl(), /@fragment\s+fn mainFragment\(\)/);
    assert.match(diagnosticIdFragmentWgsl(), /@group\(3\) @binding\(0\)/);
    assert.match(diagnosticIdFragmentWgsl(), /textureSample/);
    assert.match(diagnosticClusterFragmentWgsl(), /@builtin\(primitive_index\)/);
    assert.match(diagnosticClusterFragmentWgsl(), /clusterId >> 16u/);
});

function pinnedPackageRoot(): string {
    const repositoryRoot = findRepositoryRoot();
    const pin = readUpstreamPin(repositoryRoot);
    return resolve(
        repositoryRoot,
        "node_modules",
        ...pin.package.split("/"),
    );
}

test("generates Tint background WGSL for 2D and cube textures", () => {
    const packageRoot = pinnedPackageRoot();
    const ground = backgroundGroundFragmentWgsl(
        "ground provenance",
        readPinnedBackgroundGroundSource(packageRoot),
    );
    const skybox = backgroundSkyboxFragmentWgsl(
        "skybox provenance",
        readPinnedBackgroundSkyboxSource(packageRoot),
    );
    assert.match(ground, /texture_2d<f32>/);
    // The pin's own premultiply, from groundFragSrc.
    assert.match(ground, /a=vec4<f32>\(a\.rgb\*a\.a,a\.a\);/);
    assert.match(ground, /1\.590579/);
    assert.match(skybox, /texture_cube<f32>/);
    assert.match(skybox, /textureSampleLevel/);
    assert.match(skybox, /primaryColorExposure/);
    // The undithered file is the pinned environment-cubemap arm: gamma and
    // contrast only, no tone mapping and no noise.
    assert.doesNotMatch(skybox, /1\.590579/);
    assert.doesNotMatch(skybox, /dither\(/);
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


