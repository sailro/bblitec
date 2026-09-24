import { shaderSamplerName } from "./shader-material-programs.js";
import { mapShaderModule, shaderSystemUniformType } from "./shader-ir.js";
import type {
    ShaderConstant,
    ShaderEntryPoint,
    ShaderExpression,
    ShaderFunction,
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
        case "unary": {
            // A nested unary operand is parenthesized so `-(-x)` never
            // prints as the `--` token.
            const operand = emitExpression(expression.operand);
            return expression.operand.kind === "unary"
                ? `${expression.operator}(${operand})`
                : `${expression.operator}${operand}`;
        }
        case "call":
            return `${expression.name}(${expression.arguments
                .map(emitExpression)
                .join(", ")})`;
        case "construct":
            return `${expression.type}(${expression.arguments
                .map(emitExpression)
                .join(", ")})`;
        case "index": {
            // Indexing binds tighter than a unary operator: `(*p)[0]`.
            const base = emitExpression(expression.expression);
            return `${expression.expression.kind === "unary" ? `(${base})` : base}[${emitExpression(expression.index)}]`;
        }
        case "member":
            return `(${emitExpression(expression.expression)}).${expression.member}`;
        case "number":
            return expression.value;
        case "path":
            return expression.parts.join(".");
    }
}

function emitBlock(
    head: string,
    statements: ShaderStatement[],
    indent: string,
): string[] {
    return [
        `${indent}${head ? `${head} ` : ""}{`,
        ...emitStatements(statements, `${indent}    `),
        `${indent}}`,
    ];
}

function emitIf(
    statement: Extract<ShaderStatement, { kind: "if" }>,
    indent: string,
    head = "if",
): string[] {
    const lines = emitBlock(
        `${head} (${emitExpression(statement.condition)})`,
        statement.statements,
        indent,
    );
    const alternative = statement.alternative;
    if (!alternative) return lines;
    lines.pop();
    const [nested] = alternative;
    if (alternative.length === 1 && nested?.kind === "if") {
        const chained = emitIf(nested, indent, "} else if");
        return [...lines, ...chained];
    }
    return [...lines, ...emitBlock("} else", alternative, indent)];
}

function emitStatements(
    statements: ShaderStatement[],
    indent: string,
): string[] {
    const lines: string[] = [];
    for (const statement of statements) {
        switch (statement.kind) {
            case "assign":
            case "increment":
            case "let":
            case "const":
            case "var":
            case "expression":
                lines.push(`${indent}${emitSimpleStatement(statement)};`);
                break;
            case "discard":
            case "break":
            case "continue":
                lines.push(`${indent}${statement.kind};`);
                break;
            case "if":
                lines.push(...emitIf(statement, indent));
                break;
            case "for":
                lines.push(
                    ...emitBlock(
                        `for (${statement.initializer ? emitSimpleStatement(statement.initializer) : ""}; ${statement.condition ? emitExpression(statement.condition) : ""}; ${statement.update ? emitSimpleStatement(statement.update) : ""})`,
                        statement.statements,
                        indent,
                    ),
                );
                break;
            case "while":
                lines.push(
                    ...emitBlock(
                        `while (${emitExpression(statement.condition)})`,
                        statement.statements,
                        indent,
                    ),
                );
                break;
            case "loop": {
                const body = [...statement.statements];
                const loop = emitBlock("loop", body, indent);
                if (statement.continuing || statement.breakIf) {
                    const inner = `${indent}    `;
                    loop.splice(
                        loop.length - 1,
                        0,
                        `${inner}continuing {`,
                        ...emitStatements(
                            statement.continuing ?? [],
                            `${inner}    `,
                        ),
                        ...(statement.breakIf
                            ? [
                                  `${inner}    break if ${emitExpression(statement.breakIf)};`,
                              ]
                            : []),
                        `${inner}}`,
                    );
                }
                lines.push(...loop);
                break;
            }
            case "switch":
                lines.push(
                    `${indent}switch (${emitExpression(statement.selector)}) {`,
                    ...statement.clauses.flatMap((clause) =>
                        emitBlock(
                            clause.selectors.length === 1 &&
                                clause.selectors[0] === "default"
                                ? "default:"
                                : `case ${clause.selectors
                                      .map((selector) =>
                                          selector === "default"
                                              ? selector
                                              : emitExpression(selector),
                                      )
                                      .join(", ")}:`,
                            clause.statements,
                            `${indent}    `,
                        ),
                    ),
                    `${indent}}`,
                );
                break;
            case "block":
                lines.push(...emitBlock("", statement.statements, indent));
                break;
            case "return":
                lines.push(
                    `${indent}return${statement.value ? ` ${emitExpression(statement.value)}` : ""};`,
                );
                break;
            case "assert":
                lines.push(
                    `${indent}const_assert ${emitExpression(statement.value)};`,
                );
                break;
        }
    }
    return lines;
}

/** A statement a `for` header can carry, without its `;`. */
function emitSimpleStatement(statement: ShaderStatement): string {
    switch (statement.kind) {
        case "let":
        case "const":
        case "var":
            return `${statement.kind} ${statement.name}${statement.type ? `: ${statement.type}` : ""}${statement.value ? ` = ${emitExpression(statement.value)}` : ""}`;
        case "assign":
            return `${emitExpression(statement.target)} ${statement.operator ?? "="} ${emitExpression(statement.value)}`;
        case "increment":
            return `${emitExpression(statement.target)}${statement.operator}`;
        case "expression":
            return emitExpression(statement.value);
        default:
            throw new Error(
                `WGSL ${statement.kind} statement cannot stand in a for header.`,
            );
    }
}

export function emitWgslStatements(
    statements: ShaderStatement[],
    indent = "    ",
): string {
    return emitStatements(statements, indent).join("\n");
}

export function emitWgslFunction(fn: ShaderFunction): string {
    return [
        `fn ${fn.name}(${fn.parameters.map((parameter) => `${parameter.name}: ${parameter.type}`).join(", ")})${fn.returnType ? ` -> ${fn.returnType}` : ""} {`,
        ...emitStatements(fn.statements, "    "),
        "}",
    ].join("\n");
}

function emitConstant(constant: ShaderConstant): string {
    return `const ${constant.name}${constant.type ? `: ${constant.type}` : ""} = ${emitExpression(constant.value)};`;
}

/** A module's constants and helper functions, each block followed by a blank line. */
function emitHelpers(module: ShaderModule): string[] {
    return [
        ...(module.constants?.length
            ? [...module.constants.map(emitConstant), ""]
            : []),
        ...(module.functions ?? []).flatMap((fn) => [emitWgslFunction(fn), ""]),
    ];
}

function emitStruct(structure: ShaderStruct): string {
    return [
        `struct ${structure.name} {`,
        ...structure.members.map(
            (member) =>
                `    ${memberAttribute(member)}${member.name}: ${member.type},`,
        ),
        "}",
    ].join("\n");
}

function emitEntryPoint(entry: ShaderEntryPoint): string {
    return [
        `@${entry.stage}`,
        `fn ${entry.name}(${entry.parameters
            .map(
                (parameter) =>
                    `${memberAttribute(parameter)}${parameter.name}: ${parameter.type}`,
            )
            .join(
                ", ",
            )}) -> ${memberAttribute({ attribute: entry.returnAttribute })}${entry.returnType} {`,
        ...emitStatements(entry.statements, "    "),
        "}",
    ].join("\n");
}

/** Emit a complete typed module without inventing or specializing bindings. */
export function emitWgslModule(module: ShaderModule, helpers = ""): string {
    return [
        ...module.structs.map(emitStruct),
        ...(module.bindings ?? []).map(
            (binding) =>
                `@group(${binding.group}) @binding(${binding.binding}) var${binding.addressSpace ? `<${binding.addressSpace}>` : ""} ${binding.name}: ${binding.type};`,
        ),
        helpers,
        ...emitHelpers(module),
        emitEntryPoint(module.entryPoint),
        "",
    ].join("\n");
}

function memberAttribute(member: {
    attribute?: ShaderStruct["members"][number]["attribute"];
}): string {
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
${block.members.map(({ name, type }) => `    ${name}: ${type},`).join("\n")}
}
@group(${group}) @binding(0) var<uniform> shaderUniforms: ShaderUniforms;`;
}

/**
 * The native PAL deliberately packs one stage block. Preserve the pin's
 * declaration order in that block and address both of the pin's logical
 * roots -- `shaderSystem.x` and `shaderUniforms.y` -- through the one native
 * binding.
 */
function specializeMixedUniformRoot(
    module: ShaderModule,
    block: ShaderUniformBlockReflection | undefined,
): ShaderModule {
    if (
        !block ||
        block.systemMatrices.length === 0 ||
        block.members.length === 0
    ) {
        return module;
    }
    return mapShaderModule(module, (expression) =>
        expression.kind === "path" && expression.parts[0] === "shaderSystem"
            ? {
                  kind: "path",
                  parts: ["shaderUniforms", ...expression.parts.slice(1)],
              }
            : expression,
    );
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
    const firstBinding =
        stage === "vertex"
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
    const block = program.reflection.uniformBlocks.find(
        (candidate) => candidate.stage === stage,
    );
    const module = specializeMixedUniformRoot(
        stage === "vertex" ? program.vertex : program.fragment,
        block,
    );
    const vertexInput =
        stage === "vertex"
            ? [
                  "struct VertexInput {",
                  ...program.reflection.attributes.map(
                      ({ name, location, type }) =>
                          `    @location(${location}) ${name}: ${type},`,
                  ),
                  "};",
              ].join("\n")
            : undefined;
    // Native shader inputs carry attributes on their reflected structs;
    // this entry interface preserves only a direct return location.
    const entry: ShaderEntryPoint = {
        ...module.entryPoint,
        stage,
        parameters: module.entryPoint.parameters.map(({ name, type }) => ({
            name,
            type,
        })),
        returnAttribute:
            module.entryPoint.returnAttribute?.kind === "location"
                ? module.entryPoint.returnAttribute
                : undefined,
    };
    return [
        "// Native-specialized WGSL generated from the bblitec typed shader IR.",
        emitUniformBlock(block),
        emitStorageBindings(program, stage),
        emitSamplerBindings(program, stage),
        defineText.length > 0 ? defineText.trimEnd() : undefined,
        vertexInput,
        ...module.structs.map((structure) => `${emitStruct(structure)};`),
        "",
        ...emitHelpers(module),
        emitEntryPoint(entry),
        "",
    ]
        .filter((value): value is string => value !== undefined)
        .join("\n");
}
