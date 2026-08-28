import { shaderSamplerName } from "./shader-material-programs.js";
import type {
    ShaderExpression,
    ShaderIrProgram,
    ShaderStage,
    ShaderStatement,
    ShaderStruct,
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
                    `${indent}return ${emitExpression(statement.value)};`,
                );
                break;
            case "var":
                lines.push(
                    `${indent}var ${statement.name}: ${statement.type};`,
                );
                break;
        }
    }
    return lines;
}

function memberAttribute(
    member: ShaderStruct["members"][number],
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
    if (block.systemMatrices.length > 0 && block.members.length > 0) {
        throw new Error(
            "Native WGSL does not yet support mixed system and custom uniform blocks.",
        );
    }
    const group = block.stage === "vertex" ? 1 : 3;
    if (block.systemMatrices.length > 0) {
        // The caller's own WGSL names these fields, so the struct is
        // written in the order the uniforms were declared rather than in
        // any order of this port's choosing.
        return `struct ShaderSystemUniforms {
${block.systemMatrices
    .map((name) => `    ${name}: mat4x4<f32>,`)
    .join("\n")}
}
@group(${group}) @binding(0) var<uniform> shaderSystem: ShaderSystemUniforms;`;
    }
    return `struct ShaderUniforms {
${block.members
    .map(({ name, type }) => `    ${name}: ${type},`)
    .join("\n")}
}
@group(${group}) @binding(0) var<uniform> shaderUniforms: ShaderUniforms;`;
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
    return program.reflection.samplers
        .flatMap((name, index) => [
            `@group(2) @binding(${index * 2}) var ${name}: texture_2d<f32>;`,
            `@group(2) @binding(${index * 2 + 1}) var ${shaderSamplerName(name)}: sampler;`,
        ])
        .join("\n");
}

export function emitNativeWgslProgram(
    program: ShaderIrProgram,
    stage: ShaderStage,
    /**
     * The `const` lines the pin's own prelude writes for this program's
     * defines (`pinnedShaderDefineLines`). They are the one part of the
     * prelude this port does not re-address: a `const` needs no SDL
     * binding or location, so the pin's text is spliced unchanged, in the
     * pin's own position — after the uniform blocks, before `VertexInput`.
     */
    defineLines = "",
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
        return [
            "// Native-specialized WGSL generated from the bblitec shader surface.",
            emitUniformBlock(block),
            emitSamplerBindings(program, stage),
            defineLines.length > 0 ? defineLines.trimEnd() : undefined,
            vertexInput,
            module.rawSource.trim(),
            "",
        ]
            .filter((value): value is string => value !== undefined)
            .join("\n");
    }
    const moduleStructs = module.structs.map((struct) =>
        [
            `struct ${struct.name} {`,
            ...struct.members.map(
                (member) =>
                    `    ${memberAttribute(member)}${member.name}: ${member.type},`,
            ),
            "};",
        ].join("\n"));
    const returnAttribute =
        module.entryPoint.returnAttribute?.kind === "location"
            ? `@location(${module.entryPoint.returnAttribute.value}) `
            : "";
    return [
        "// Native-specialized WGSL generated from the bblitec typed shader IR.",
        emitUniformBlock(block),
        emitSamplerBindings(program, stage),
        defineLines.length > 0 ? defineLines.trimEnd() : undefined,
        vertexInput,
        ...moduleStructs,
        "",
        `@${stage}`,
        `fn ${module.entryPoint.name}(${module.entryPoint.parameters
            .map(({ name, type }) => `${name}: ${type}`)
            .join(", ")}) -> ${returnAttribute}${module.entryPoint.returnType} {`,
        ...emitStatements(module.entryPoint.statements, "    "),
        "}",
        "",
    ].filter((value): value is string => value !== undefined).join("\n");
}
