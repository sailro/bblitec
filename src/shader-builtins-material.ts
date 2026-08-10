export function materialVertexWgsl(): string {
    return `struct VertexUniforms {
    viewProjection: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> uniforms: VertexUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) localPosition: vec3<f32>,
    @location(5) uv2: vec2<f32>,
    @location(6) color: vec4<f32>,
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
    var output: VertexOutput;
    output.position =
        uniforms.viewProjection * vec4<f32>(input.position, 1.0);
    output.worldPosition = input.position;
    output.normal = input.normal;
    output.tangent = input.tangent;
    output.uv = input.uv;
    output.localPosition = input.localPosition;
    output.uv2 = input.uv2;
    output.color = input.color;
    return output;
}
`;
}
