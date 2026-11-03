/** Program source several compile tests share. */

/** A vertex stage that only projects the position. */
export const POSITION_VERTEX_WGSL = `struct VertexOutput {
@builtin(position) position: vec4<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
var out: VertexOutput;
out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
return out;
}`;

/** `tint`, a material plugin halving the fragment's base colour. */
export const TINT_PLUGIN = `
const tint: MaterialPlugin = {
    name: "tint",
    getCustomCode: (shaderType) =>
        shaderType === "fragment"
            ? { CUSTOM_FRAGMENT_UPDATE_DIFFUSE: "baseColor = baseColor * 0.5;" }
            : null,
};
`;
