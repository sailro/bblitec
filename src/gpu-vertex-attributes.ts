/**
 * The native vertex's attributes (`GpuVertex`), by the pin's attribute name:
 * the location both render backends bind each from and its WGSL type. The
 * skinning lanes (`joints`, `weights`) are the deformation stage's; joint
 * indices ride a float lane.
 */
export const GPU_VERTEX_ATTRIBUTES = {
    position: { location: 0, type: "vec3<f32>" },
    normal: { location: 1, type: "vec3<f32>" },
    tangent: { location: 2, type: "vec4<f32>" },
    uv: { location: 3, type: "vec2<f32>" },
    uv2: { location: 5, type: "vec2<f32>" },
    color: { location: 6, type: "vec4<f32>" },
    joints: { location: 8, type: "vec4<f32>" },
    weights: { location: 9, type: "vec4<f32>" },
} as const satisfies Readonly<
    Record<
        string,
        { location: number; type: "vec2<f32>" | "vec3<f32>" | "vec4<f32>" }
    >
>;

/** `VertexInput` members for the named attributes, one WGSL line each. */
export function gpuVertexInputLines(
    names: readonly (keyof typeof GPU_VERTEX_ATTRIBUTES)[],
): string {
    return names
        .map((name) => {
            const { location, type } = GPU_VERTEX_ATTRIBUTES[name];
            return `    @location(${location}) ${name}: ${type},\n`;
        })
        .join("");
}
