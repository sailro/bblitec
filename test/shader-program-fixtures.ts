// Two shader-material programs the shader pipeline tests lower: the card
// scene 274 draws (custom uniforms, no attributes beyond position) and the
// cutout scene 163 draws (a system matrix, a discard, alpha blending).
import {
    shaderSamplerDeclarations,
    type ShaderMaterialProgramSource,
} from "../src/shader-material-programs.js";
import type { CompiledShaderProgram } from "../src/compiler/types.js";

export const fixtureShaderPrograms: ShaderMaterialProgramSource[] = [
    {
        name: "alpha-card",
        vertexSource: `struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
    let c = cos(shaderUniforms.angle);
    let s = sin(shaderUniforms.angle);
    let local = input.position.xy * 1.65;
    let rotated = vec2<f32>(
        local.x * c - local.y * s,
        local.x * s + local.y * c,
    );
    let world = shaderUniforms.center + rotated;
    var out: VertexOutput;
    out.position = vec4<f32>(
        world.x / 3.3,
        world.y / 2.2,
        shaderUniforms.depth,
        1.0,
    );
    return out;
}`,
        fragmentSource: `@fragment
fn mainFragment() -> @location(0) vec4<f32> {
    return vec4<f32>(shaderUniforms.color, shaderUniforms.opacity);
}`,
        attributes: ["position"],
        uniforms: [
            "center:vec2<f32>",
            "angle:f32",
            "depth:f32",
            "color:vec3<f32>",
            "opacity:f32",
        ],
        // Defaults on two of the uniforms, so the variant table carries some.
        uniformDefaults: [
            { name: "depth", values: [0.5] },
            { name: "opacity", values: [1] },
        ],
        needAlphaBlending: false,
        blendMode: "alpha",
        needAlphaTesting: false,
        backFaceCulling: false,
        depthWrite: true,
    },
    {
        name: "circular-cutout",
        vertexSource: `struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position =
        shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
    out.uv = input.uv;
    return out;
}`,
        fragmentSource: `struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    if (distance(input.uv, vec2<f32>(0.5, 0.5)) < 0.18) {
        discard;
    }
    return vec4<f32>(1.0, 0.25, 0.05, 0.55);
}`,
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection"],
        needAlphaBlending: true,
        blendMode: "alpha",
        needAlphaTesting: true,
        backFaceCulling: false,
        depthWrite: false,
    },
];

/** A fixture program by name. */
export function fixtureShaderProgram(
    name: string,
): ShaderMaterialProgramSource {
    const program = fixtureShaderPrograms.find(
        (candidate) => candidate.name === name,
    );
    if (!program) throw new Error(`No fixture shader program '${name}'.`);
    return program;
}

/**
 * A fixture program as the compiler's own reached-program record: the
 * table above leaves the optional halves off the entries that do not use
 * them, while a reached program always carries both.
 */
export function reachedFixtureProgram(
    program: ShaderMaterialProgramSource,
): CompiledShaderProgram {
    return {
        ...program,
        blendMode: program.blendMode ?? "alpha",
        uniformDefaults: program.uniformDefaults ?? [],
        samplers: program.samplers ?? [],
        samplerDeclarations: shaderSamplerDeclarations(program),
        storageBuffers: program.storageBuffers ?? [],
        defines: program.defines ?? [],
    };
}
