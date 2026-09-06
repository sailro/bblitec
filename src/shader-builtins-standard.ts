import { LoweringContext } from "./lowering/context.js";
import { pinnedMaterialVertex } from "./pinned-material-vertex.js";
import { sharedUpstreamStore } from "./upstream-source.js";

/** The palette capacity in the shared PAL's DeformationUniforms transport. */
export const DEFORMATION_BONE_SLOTS = 64;

/**
 * The shared diagnostic/depth/background stage. Colour materials use their
 * own composers; this stage projects the same pinned operations onto the
 * PAL's pre-transformed vertices, uniform palette and optional streams.
 */
export function materialVertexWgsl(
    gpuDeformation = false,
    gpuInstancing = false,
    morphStorage = false,
    context = new LoweringContext(sharedUpstreamStore()),
): string {
    const projected = pinnedMaterialVertex(context, {
        deformation: gpuDeformation,
        instancing: gpuInstancing,
        morphStorage,
    });
    return `${projected.provenance}
struct VertexUniforms {
    viewProjection: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> uniforms: VertexUniforms;
${gpuDeformation ? `
struct DeformationUniforms {
    boneMatrices: array<mat4x4<f32>, ${DEFORMATION_BONE_SLOTS}>,
    morphWeights: vec4<f32>,
    options: vec4<f32>,
}
@group(1) @binding(1) var<uniform> deformation: DeformationUniforms;
${morphStorage ? `
${projected.morphStructs}
@group(0) @binding(0) var<storage, read> morphDeltas: morphDeltasUniforms;
@group(0) @binding(1) var<storage, read> morph: morphUniforms;
` : ""}` : ""}
${gpuInstancing ? `
struct InstanceUniforms {
    parentWorld: mat4x4<f32>,
}
@group(1) @binding(${gpuDeformation ? 2 : 1}) var<uniform> instanceUniforms: InstanceUniforms;
` : ""}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) localPosition: vec3<f32>,
    @location(5) uv2: vec2<f32>,
    @location(6) color: vec4<f32>,
${gpuDeformation ? `    @location(8) joints: vec4<f32>,
    @location(9) weights: vec4<f32>,
${morphStorage ? `    @builtin(vertex_index) vertexIndex: u32,
` : `    @location(10) morphPosition0: vec3<f32>,
    @location(11) morphPosition1: vec3<f32>,
    @location(12) morphNormal0: vec3<f32>,
    @location(13) morphNormal1: vec3<f32>,
    @location(14) morphTangent0: vec3<f32>,
    @location(15) morphTangent1: vec3<f32>,
`}` : ""}${gpuInstancing ? `    @location(16) instanceColumn0: vec4<f32>,
    @location(17) instanceColumn1: vec4<f32>,
    @location(18) instanceColumn2: vec4<f32>,
    @location(19) instanceColumn3: vec4<f32>,
` : ""}};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) localPosition: vec3<f32>,
    @location(5) uv2: vec2<f32>,
    @location(6) color: vec4<f32>,
    @location(7) bitangent: vec3<f32>,
};

${projected.helpers}

@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
${projected.body}
}
`;
}
