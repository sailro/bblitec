// The option-surface regressions' shared vertex stage: a box whose height a
// variant picks by replacing HEIGHT.

export const SURFACE_VERTEX = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{
    var out:VertexOutput;
    out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * vec3<f32>(1.0, HEIGHT, 1.0), 1.0);
    return out;
}`;
