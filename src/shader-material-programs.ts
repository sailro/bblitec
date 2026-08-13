import type { ShaderMaterialVariantName } from "./compiler.js";

export interface ShaderMaterialProgramSource {
    name: string;
    vertexSource: string;
    fragmentSource: string;
    attributes: string[];
    uniforms: string[];
    /** Native uniform defaults applied at material creation; pinned
     *  predeclared values carry the historical record initializers. */
    uniformDefaults?: Array<{ name: string; values: number[] }>;
    needAlphaBlending: boolean;
    needAlphaTesting: boolean;
    backFaceCulling: boolean;
    depthWrite: boolean;
    clipDepth: "matrix" | "direct-webgpu";
}

export function normalizeShaderSource(source: string): string {
    return source.replace(/\s+/g, "").replace(/,([)}])/g, "$1");
}

/**
 * The canonical flat value layout for a program's custom uniforms:
 * declaration order, sized by component count. Both the generated
 * variant table's gathers and the compiled uniform setters resolve
 * offsets through this single definition.
 */
export function shaderUniformValueLayout(
    uniforms: string[],
): Map<string, { offset: number; count: number }> {
    const layout = new Map<string, { offset: number; count: number }>();
    let offset = 0;
    for (const signature of uniforms) {
        const separator = signature.indexOf(":");
        if (separator < 1) continue;
        const name = signature.slice(0, separator);
        const type = signature.slice(separator + 1);
        const count =
            type === "f32"
                ? 1
                : type === "vec2<f32>"
                    ? 2
                    : type === "vec3<f32>"
                        ? 3
                        : type === "vec4<f32>"
                            ? 4
                            : 0;
        if (count === 0) continue;
        layout.set(name, { offset, count });
        offset += count;
    }
    return layout;
}

export const shaderMaterialPrograms: ShaderMaterialProgramSource[] = [
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
        // The historical native record initializers (shader_depth 0.5,
        // shader_opacity 1.0) carry over as variant defaults.
        uniformDefaults: [
            { name: "depth", values: [0.5] },
            { name: "opacity", values: [1] },
        ],
        needAlphaBlending: false,
        needAlphaTesting: false,
        backFaceCulling: false,
        depthWrite: true,
        clipDepth: "direct-webgpu",
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
        needAlphaTesting: true,
        backFaceCulling: false,
        depthWrite: false,
        clipDepth: "matrix",
    },
];

export function getShaderMaterialProgram(
    name: ShaderMaterialVariantName,
): ShaderMaterialProgramSource {
    const program = shaderMaterialPrograms.find((candidate) => candidate.name === name);
    if (!program) throw new Error(`Unknown shader material program '${name}'.`);
    return program;
}

const systemUniformTypes: Record<string, string | undefined> = {
    alphaCutoff: "f32",
    cameraPosition: "vec3<f32>",
    projection: "mat4x4<f32>",
    screenSize: "vec2<f32>",
    view: "mat4x4<f32>",
    viewProjection: "mat4x4<f32>",
    world: "mat4x4<f32>",
    worldView: "mat4x4<f32>",
    worldViewProjection: "mat4x4<f32>",
};

const attributeTypes: Record<string, string | undefined> = {
    color: "vec4<f32>",
    joints: "vec4<u32>",
    joints1: "vec4<u32>",
    normal: "vec3<f32>",
    position: "vec3<f32>",
    tangent: "vec4<f32>",
    uv: "vec2<f32>",
    uv2: "vec2<f32>",
    weights: "vec4<f32>",
    weights1: "vec4<f32>",
};

function uniformField(signature: string): { name: string; type: string; system: boolean } {
    const systemType = systemUniformTypes[signature];
    if (systemType) {
        return { name: signature, type: systemType, system: true };
    }
    const separator = signature.indexOf(":");
    if (separator < 1) throw new Error(`Invalid custom shader uniform '${signature}'.`);
    return {
        name: signature.slice(0, separator),
        type: signature.slice(separator + 1),
        system: false,
    };
}

export function composeStandaloneWgsl(
    program: ShaderMaterialProgramSource,
    sceneUniformsWgsl: string,
    stage: "vertex" | "fragment",
): string {
    const uniforms = program.uniforms.map(uniformField);
    const system = uniforms.filter(({ system: isSystem }) => isSystem);
    const custom = uniforms.filter(({ system: isSystem }) => !isSystem);
    const systemFields = system.length > 0
        ? system.map(({ name, type }) => `    ${name}: ${type},`).join("\n")
        : "    _pad: vec4<f32>,";
    const customBlock = custom.length > 0
        ? `
struct ShaderUniforms {
${custom.map(({ name, type }) => `    ${name}: ${type},`).join("\n")}
}
@group(1) @binding(1) var<uniform> shaderUniforms: ShaderUniforms;
`
        : "";
    const attributes = program.attributes.map((name, location) => {
        const type = attributeTypes[name];
        if (!type) throw new Error(`Unsupported custom shader attribute '${name}'.`);
        return `    @location(${location}) ${name}: ${type},`;
    }).join("\n");
    const source = stage === "vertex"
        ? program.vertexSource
        : program.fragmentSource;
    return `${sceneUniformsWgsl}
struct ShaderSystemUniforms {
${systemFields}
}
@group(1) @binding(0) var<uniform> shaderSystem: ShaderSystemUniforms;
${customBlock}
struct VertexInput {
${attributes}
};
${source.trim()}
`;
}
