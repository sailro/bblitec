import { shaderSamplerName } from "./shader-material-programs.js";
import { shaderSystemUniformType } from "./shader-ir.js";
import type {
    ShaderEntryPoint,
    ShaderExpression,
    ShaderIrProgram,
    ShaderStage,
    ShaderStatement,
    ShaderStruct,
    ShaderModule,
    ShaderUniformBlockReflection,
} from "./shader-ir.js";

function emitExpression(expression: ShaderExpression): string {
    switch (expression.kind) {
        case "binary":
            return `(${emitExpression(expression.left)} ${expression.operator} ${emitExpression(expression.right)})`;
        case "call":
            return `${expression.name}(${expression.arguments
                .map(emitExpression)
                .join(", ")})`;
        case "construct":
            return `${expression.type}(${expression.arguments
                .map(emitExpression)
                .join(", ")})`;
        case "member":
            return `(${emitExpression(expression.expression)}).${expression.member}`;
        case "number":
            return expression.value;
        case "path":
            return expression.parts.join(".");
    }
}

function emitStatements(
    statements: ShaderStatement[],
    indent: string,
): string[] {
    const lines: string[] = [];
    for (const statement of statements) {
        switch (statement.kind) {
            case "assign":
                lines.push(
                    `${indent}${emitExpression(statement.target)} = ${emitExpression(statement.value)};`,
                );
                break;
            case "discard":
                lines.push(`${indent}discard;`);
                break;
            case "if":
                lines.push(
                    `${indent}if (${emitExpression(statement.condition)}) {`,
                    ...emitStatements(
                        statement.statements,
                        `${indent}    `,
                    ),
                    `${indent}}`,
                );
                break;
            case "let":
                lines.push(
                    `${indent}let ${statement.name} = ${emitExpression(statement.value)};`,
                );
                break;
            case "return":
                lines.push(
                    `${indent}return${statement.value ? ` ${emitExpression(statement.value)}` : ""};`,
                );
                break;
            case "expression":
                lines.push(`${indent}${emitExpression(statement.value)};`);
                break;
            case "var":
                lines.push(
                    `${indent}var ${statement.name}${statement.type ? `: ${statement.type}` : ""}${statement.value ? ` = ${emitExpression(statement.value)}` : ""};`,
                );
                break;
        }
    }
    return lines;
}

function emitStruct(structure: ShaderStruct): string {
    return [
        `struct ${structure.name} {`,
        ...structure.members.map((member) =>
            `    ${memberAttribute(member)}${member.name}: ${member.type},`),
        "}",
    ].join("\n");
}

function emitEntryPoint(entry: ShaderEntryPoint): string {
    return [
        `@${entry.stage}`,
        `fn ${entry.name}(${entry.parameters.map((parameter) =>
            `${memberAttribute(parameter)}${parameter.name}: ${parameter.type}`).join(", ")}) -> ${memberAttribute({ attribute: entry.returnAttribute })}${entry.returnType} {`,
        ...emitStatements(entry.statements, "    "),
        "}",
    ].join("\n");
}

/** Emit a complete typed module without inventing or specializing bindings. */
export function emitWgslModule(module: ShaderModule, helpers = ""): string {
    if (module.rawSource !== undefined) throw new Error("Typed WGSL emission requires parsed declarations.");
    return [
        ...module.structs.map(emitStruct),
        ...(module.bindings ?? []).map((binding) =>
            `@group(${binding.group}) @binding(${binding.binding}) var${binding.addressSpace ? `<${binding.addressSpace}>` : ""} ${binding.name}: ${binding.type};`),
        helpers,
        emitEntryPoint(module.entryPoint),
        "",
    ].join("\n");
}

function memberAttribute(
    member: { attribute?: ShaderStruct["members"][number]["attribute"] },
): string {
    if (!member.attribute) return "";
    return member.attribute.kind === "builtin"
        ? `@builtin(${member.attribute.value}) `
        : `@location(${member.attribute.value}) `;
}

function emitUniformBlock(
    block: ShaderUniformBlockReflection | undefined,
): string | undefined {
    if (!block) return undefined;
    const group = block.stage === "vertex" ? 1 : 3;
    if (block.systemMatrices.length > 0 && block.members.length === 0) {
        // The caller's own WGSL names these fields, so the struct is
        // written in the order the uniforms were declared rather than in
        // any order of this port's choosing.
        return `struct ShaderSystemUniforms {
${block.systemMatrices
    .map((name) => `    ${name}: ${shaderSystemUniformType(name)},`)
    .join("\n")}
}
@group(${group}) @binding(0) var<uniform> shaderSystem: ShaderSystemUniforms;`;
    }
    return `struct ShaderUniforms {
${block.systemMatrices
    .map((name) => `    ${name}: ${shaderSystemUniformType(name)},`)
    .join("\n")}
${block.members
    .map(({ name, type }) => `    ${name}: ${type},`)
    .join("\n")}
}
@group(${group}) @binding(0) var<uniform> shaderUniforms: ShaderUniforms;`;
}

function specializeMixedUniformRoot(
    source: string,
    block: ShaderUniformBlockReflection | undefined,
): string {
    if (
        !block ||
        block.systemMatrices.length === 0 ||
        block.members.length === 0
    ) {
        return source;
    }
    // The native PAL deliberately packs one stage block. Preserve the pin's
    // declaration order in that block and address both of the pin's logical
    // roots through the one native binding.
    return source.replaceAll("shaderSystem.", "shaderUniforms.");
}

/**
 * The texture/sampler pairs a fragment samples, at this backend's own
 * addresses: SDL_GPU takes fragment textures at group 2, binding `2n` with
 * the sampler at `2n + 1`, where the pin binds both into its group 1 beside
 * the uniform blocks. The identifiers stay the pin's, because the caller's
 * WGSL samples through them.
 */
function emitSamplerBindings(
    program: ShaderIrProgram,
    stage: ShaderStage,
): string | undefined {
    if (stage !== "fragment" || program.reflection.samplers.length === 0) {
        return undefined;
    }
    return program.reflection.samplerDeclarations
        .flatMap((decl, index) => {
            const depth = decl.comparison || decl.sampleType === "depth";
            const textureType = depth
                ? decl.viewDimension === "2d-array"
                    ? "texture_depth_2d_array"
                    : "texture_depth_2d"
                : decl.viewDimension === "2d-array"
                    ? "texture_2d_array<f32>"
                    : "texture_2d<f32>";
            return [
                `@group(2) @binding(${index * 2}) var ${decl.name}: ${textureType};`,
                `@group(2) @binding(${index * 2 + 1}) var ${shaderSamplerName(decl.name)}: ${decl.comparison ? "sampler_comparison" : "sampler"};`,
            ];
        })
        .join("\n");
}

function emitStorageBindings(
    program: ShaderIrProgram,
    stage: ShaderStage,
): string | undefined {
    const reached = program.reflection.storageBuffers
        .filter((buffer) => buffer[stage])
        .map((buffer, binding) => ({ ...buffer, binding }));
    if (reached.length === 0) return undefined;
    // SDL_GPU's graphics binding convention puts vertex resources in group 0
    // and fragment resources in group 2. Storage buffers follow every sampled
    // texture in that same resource group; each texture/sampler pair spends
    // two WebGPU bindings but one t-register, which Tint compacts for the
    // target artifact and publishes through the stage-slot sidecar.
    const group = stage === "vertex" ? 0 : 2;
    const firstBinding = stage === "vertex"
        ? 0
        : program.reflection.samplerDeclarations.length * 2;
    return reached
        .map(
            ({ name, type, binding }) =>
                `@group(${group}) @binding(${firstBinding + binding}) var<storage, read> ${name}: ${type};`,
        )
        .join("\n");
}

export function emitNativeWgslProgram(
    program: ShaderIrProgram,
    stage: ShaderStage,
    /**
     * The `const` lines the pin's own prelude writes for this program's
     * defines (`pinnedShaderDefineText`). They are the one part of the
     * prelude this port does not re-address: a `const` needs no SDL
     * binding or location, so the pin's text is spliced unchanged, in the
     * pin's own position — after the uniform blocks, before `VertexInput`.
     */
    defineText = "",
): string {
    const module = stage === "vertex" ? program.vertex : program.fragment;
    const block = program.reflection.uniformBlocks.find(
        (candidate) => candidate.stage === stage,
    );
    const vertexInput = stage === "vertex"
        ? [
              "struct VertexInput {",
              ...program.reflection.attributes.map(
                  ({ name, location, type }) =>
                      `    @location(${location}) ${name}: ${type},`,
              ),
              "};",
          ].join("\n")
        : undefined;
    if (module.rawSource !== undefined) {
        return specializeMixedUniformRoot([
            "// Native-specialized WGSL generated from the bblitec shader surface.",
            emitUniformBlock(block),
            emitStorageBindings(program, stage),
            emitSamplerBindings(program, stage),
            defineText.length > 0 ? defineText.trimEnd() : undefined,
            vertexInput,
            module.rawSource.trim(),
            "",
        ]
            .filter((value): value is string => value !== undefined)
            .join("\n"), block);
    }
    // Native shader inputs carry attributes on their reflected structs;
    // this entry interface preserves only a direct return location.
    const entry: ShaderEntryPoint = {
        ...module.entryPoint,
        stage,
        parameters: module.entryPoint.parameters.map(({ name, type }) => ({ name, type })),
        returnAttribute: module.entryPoint.returnAttribute?.kind === "location"
            ? module.entryPoint.returnAttribute
            : undefined,
    };
    return specializeMixedUniformRoot([
        "// Native-specialized WGSL generated from the bblitec typed shader IR.",
        emitUniformBlock(block),
        emitStorageBindings(program, stage),
        emitSamplerBindings(program, stage),
        defineText.length > 0 ? defineText.trimEnd() : undefined,
        vertexInput,
        ...module.structs.map((structure) => `${emitStruct(structure)};`),
        "",
        emitEntryPoint(entry),
        "",
    ].filter((value): value is string => value !== undefined).join("\n"), block);
}
