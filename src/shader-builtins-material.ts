export function materialVertexWgsl(
    gpuDeformation = false,
    gpuInstancing = false,
): string {
    const deformationUniforms = gpuDeformation
        ? `
struct DeformationUniforms {
    boneMatrices: array<mat4x4<f32>, 64>,
    morphWeights: vec4<f32>,
    options: vec4<f32>,
}
@group(1) @binding(1) var<uniform> deformation: DeformationUniforms;
`
        : "";
    const deformationInputs = gpuDeformation
        ? `    @location(8) joints: vec4<f32>,
    @location(9) weights: vec4<f32>,
    @location(10) morphPosition0: vec3<f32>,
    @location(11) morphPosition1: vec3<f32>,
    @location(12) morphNormal0: vec3<f32>,
    @location(13) morphNormal1: vec3<f32>,
    @location(14) morphTangent0: vec3<f32>,
    @location(15) morphTangent1: vec3<f32>,
`
        : "";
    const deformationBody = gpuDeformation
        ? `    if (deformation.options.x > 0.5) {
        worldPosition +=
            input.morphPosition0 * deformation.morphWeights.x +
            input.morphPosition1 * deformation.morphWeights.y;
        worldNormal +=
            input.morphNormal0 * deformation.morphWeights.x +
            input.morphNormal1 * deformation.morphWeights.y;
        worldTangent +=
            input.morphTangent0 * deformation.morphWeights.x +
            input.morphTangent1 * deformation.morphWeights.y;
        let skin =
            deformation.boneMatrices[u32(input.joints.x)] * input.weights.x +
            deformation.boneMatrices[u32(input.joints.y)] * input.weights.y +
            deformation.boneMatrices[u32(input.joints.z)] * input.weights.z +
            deformation.boneMatrices[u32(input.joints.w)] * input.weights.w;
        worldPosition =
            (skin * vec4<f32>(worldPosition, 1.0)).xyz;
        if (deformation.options.y < 0.5) {
            worldNormal =
                (skin * vec4<f32>(normalize(worldNormal), 0.0)).xyz;
        }
        worldTangent =
            (skin * vec4<f32>(normalize(worldTangent), 0.0)).xyz;
    }
`
        : "";
    const instanceUniforms = gpuInstancing
        ? `
struct InstanceUniforms {
    parentWorld: mat4x4<f32>,
}
@group(1) @binding(${gpuDeformation ? 2 : 1}) var<uniform> instanceUniforms: InstanceUniforms;
`
        : "";
    const instanceInputs = gpuInstancing
        ? `    @location(16) instanceColumn0: vec4<f32>,
    @location(17) instanceColumn1: vec4<f32>,
    @location(18) instanceColumn2: vec4<f32>,
    @location(19) instanceColumn3: vec4<f32>,
`
        : "";
    const instanceBody = gpuInstancing
        ? `    let localInstanceMatrix = mat4x4<f32>(
        input.instanceColumn0,
        input.instanceColumn1,
        input.instanceColumn2,
        input.instanceColumn3,
    );
    let instanceMatrix =
        instanceUniforms.parentWorld * localInstanceMatrix;
    worldPosition =
        (instanceMatrix * vec4<f32>(worldPosition, 1.0)).xyz;
    let instanceNormal = mat3x3<f32>(
        instanceMatrix[0].xyz,
        instanceMatrix[1].xyz,
        instanceMatrix[2].xyz,
    );
    worldNormal = instanceNormal * worldNormal;
    worldTangent = instanceNormal * worldTangent;
`
        : "";
    return `struct VertexUniforms {
    viewProjection: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> uniforms: VertexUniforms;
${deformationUniforms}
${instanceUniforms}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) localPosition: vec3<f32>,
    @location(5) uv2: vec2<f32>,
    @location(6) color: vec4<f32>,
${deformationInputs}
${instanceInputs}
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) localPosition: vec3<f32>,
    @location(5) uv2: vec2<f32>,
    @location(6) color: vec4<f32>,
};

@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
    var worldPosition = input.position;
    var worldNormal = input.normal;
    var worldTangent = input.tangent.xyz;
${deformationBody}
${instanceBody}
    var output: VertexOutput;
    output.position =
        uniforms.viewProjection * vec4<f32>(worldPosition, 1.0);
    output.worldPosition = worldPosition;
    output.normal = worldNormal;
    output.tangent = vec4<f32>(
        worldTangent,
        input.tangent.w,
    );
    output.uv = input.uv;
    output.localPosition = input.localPosition;
    output.uv2 = input.uv2;
    output.color = input.color;
    return output;
}
`;
}
