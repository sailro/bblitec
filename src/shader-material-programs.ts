import type {
    CompiledShaderSampler,
    CompiledShaderStorageBuffer,
} from "./compiler/types.js";

export interface ShaderMaterialProgramSource {
    name: string;
    vertexSource: string;
    fragmentSource: string;
    attributes: string[];
    uniforms: string[];
    /** Native uniform defaults applied at material creation. */
    uniformDefaults?: Array<{ name: string; values: number[] }>;
    /** Reached `samplers`, in declaration order — the binding order too. */
    samplers?: string[];
    samplerDeclarations?: CompiledShaderSampler[];
    storageBuffers?: CompiledShaderStorageBuffer[];
    /** Reached `defines`, already in the pin's sorted `ShaderDefine` order. */
    defines?: Array<{ name: string; value: boolean | number }>;
    needAlphaBlending: boolean;
    blendMode?: "alpha" | "additive";
    needAlphaTesting: boolean;
    backFaceCulling: boolean;
    depthWrite: boolean;
    depthCompare?: string;
    /**
     * The material binds the mesh's thin-instance matrices and its vertex
     * stage reads them, so the pin's own thin-instance module appends the
     * four matrix lanes to its `VertexInput`.
     */
    useThinInstances?: boolean;
    /** With them, the per-instance RGBA lane the same module appends. */
    useThinInstanceColors?: boolean;
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

/**
 * The companion identifier the pin's own prelude writes beside a sampler's
 * texture (`buildShaderPrelude`). Owned once, because the compiler
 * validates against it, the IR tests for it, and both emitters declare it.
 */
export function shaderSamplerName(name: string): string {
    return `${name}Sampler`;
}

/** Normalize bare sampler names to the pin's default sampler shape. */
export function shaderSamplerDeclarations(
    program: Pick<
        ShaderMaterialProgramSource,
        "samplers" | "samplerDeclarations"
    >,
): CompiledShaderSampler[] {
    return (
        program.samplerDeclarations ??
        (program.samplers ?? []).map((name) => ({
            name,
            sampleType: "float" as const,
            viewDimension: "2d" as const,
            comparison: false,
        }))
    );
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

function uniformField(signature: string): {
    name: string;
    type: string;
    system: boolean;
} {
    const systemType = systemUniformTypes[signature];
    if (systemType) {
        return { name: signature, type: systemType, system: true };
    }
    const separator = signature.indexOf(":");
    if (separator < 1)
        throw new Error(`Invalid custom shader uniform '${signature}'.`);
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
    /**
     * The `const` lines the pin's own prelude writes for this program's
     * defines, read from `buildShaderPrelude` by
     * `pinnedShaderDefineText`. Passed in because that read needs the
     * lowering context, and both this composer and the native emitter
     * splice the same block.
     */
    defineText = "",
): string {
    const uniforms = program.uniforms.map(uniformField);
    const system = uniforms.filter(({ system: isSystem }) => isSystem);
    const custom = uniforms.filter(({ system: isSystem }) => !isSystem);
    const systemFields =
        system.length > 0
            ? system.map(({ name, type }) => `    ${name}: ${type},`).join("\n")
            : "    _pad: vec4<f32>,";
    const customBlock =
        custom.length > 0
            ? `
struct ShaderUniforms {
${custom.map(({ name, type }) => `    ${name}: ${type},`).join("\n")}
}
@group(1) @binding(1) var<uniform> shaderUniforms: ShaderUniforms;
`
            : "";
    // The pin's own prelude places each sampler pair in group 1 after the
    // custom UBO, at consecutive bindings; SDL specialization re-homes them
    // (see `emitNativeWgslProgram`), so only this evidence copy keeps the
    // pin's addresses.
    let nextBinding = custom.length > 0 ? 2 : 1;
    const samplerDeclarations = shaderSamplerDeclarations(program);
    const samplerBlock = samplerDeclarations
        .map((decl) => {
            const depth = decl.comparison || decl.sampleType === "depth";
            const textureType = depth
                ? decl.viewDimension === "2d-array"
                    ? "texture_depth_2d_array"
                    : "texture_depth_2d"
                : decl.viewDimension === "2d-array"
                  ? "texture_2d_array<f32>"
                  : "texture_2d<f32>";
            const samplerType = decl.comparison
                ? "sampler_comparison"
                : "sampler";
            return (
                `@group(1) @binding(${nextBinding++}) var ${decl.name}: ${textureType};\n` +
                `@group(1) @binding(${nextBinding++}) var ${shaderSamplerName(decl.name)}: ${samplerType};\n`
            );
        })
        .join("");
    const storageBlock = (program.storageBuffers ?? [])
        .map(
            ({ name, type }) =>
                `@group(1) @binding(${nextBinding++}) var<storage, read> ${name}: ${type};\n`,
        )
        .join("");
    const attributes = program.attributes
        .map((name, location) => {
            const type = attributeTypes[name];
            if (!type)
                throw new Error(
                    `Unsupported custom shader attribute '${name}'.`,
                );
            return `    @location(${location}) ${name}: ${type},`;
        })
        .join("\n");
    const source =
        stage === "vertex" ? program.vertexSource : program.fragmentSource;
    return `${sceneUniformsWgsl}
struct ShaderSystemUniforms {
${systemFields}
}
@group(1) @binding(0) var<uniform> shaderSystem: ShaderSystemUniforms;
${customBlock}
${samplerBlock}${storageBlock}${defineText}struct VertexInput {
${attributes}
};
${source.trim()}
`;
}
