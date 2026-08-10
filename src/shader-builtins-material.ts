export function materialVertexWgsl(gpuDeformation = false): string {
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
            worldNormal = normalize(
                (skin * vec4<f32>(worldNormal, 0.0)).xyz,
            );
        }
        worldTangent = normalize(
            (skin * vec4<f32>(worldTangent, 0.0)).xyz,
        );
    }
`
        : "";
    return `struct VertexUniforms {
    viewProjection: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> uniforms: VertexUniforms;
${deformationUniforms}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) localPosition: vec3<f32>,
    @location(5) uv2: vec2<f32>,
    @location(6) color: vec4<f32>,
${deformationInputs}
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
