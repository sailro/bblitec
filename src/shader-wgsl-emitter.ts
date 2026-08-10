import type {
    ShaderExpression,
    ShaderIrProgram,
    ShaderStage,
    ShaderStatement,
    ShaderStruct,
    ShaderUniformBlockReflection,
} from "./shader-ir.js";

interface EmitContext {
    clipDepth: ShaderIrProgram["clipDepth"];
    locals: Map<string, string>;
    structs: Map<string, ShaderStruct>;
}

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
        case "number":
            return expression.value;
        case "path":
            return expression.parts.join(".");
    }
}

function isPositionAssignment(
    target: ShaderExpression,
    context: EmitContext,
): boolean {
    if (target.kind !== "path" || target.parts.length !== 2) return false;
    const [root, member] = target.parts;
    const type = root ? context.locals.get(root) : undefined;
    const struct = type ? context.structs.get(type) : undefined;
    return member === "position" &&
        !!struct?.members.find(
            (candidate) =>
                candidate.name === member &&
                candidate.attribute?.kind === "builtin" &&
                candidate.attribute.value === "position",
        );
}

function clipPositionExpression(
    expression: ShaderExpression,
    context: EmitContext,
): ShaderExpression {
    if (
        context.clipDepth !== "direct-webgpu" ||
        expression.kind !== "construct" ||
        expression.type !== "vec4<f32>" ||
        expression.arguments.length !== 4
    ) {
        return expression;
    }
    return {
        ...expression,
        arguments: [
            expression.arguments[0]!,
            expression.arguments[1]!,
            {
                kind: "binary",
                operator: "-",
                left: { kind: "number", value: "1.0" },
                right: expression.arguments[2]!,
            },
            expression.arguments[3]!,
        ],
    };
}

function emitStatements(
    statements: ShaderStatement[],
    context: EmitContext,
    indent: string,
): string[] {
    const lines: string[] = [];
    for (const statement of statements) {
        switch (statement.kind) {
            case "assign": {
                const value = isPositionAssignment(statement.target, context)
                    ? clipPositionExpression(statement.value, context)
                    : statement.value;
                lines.push(
                    `${indent}${emitExpression(statement.target)} = ${emitExpression(value)};`,
                );
                break;
            }
            case "discard":
                lines.push(`${indent}discard;`);
                break;
            case "if":
                lines.push(
                    `${indent}if (${emitExpression(statement.condition)}) {`,
                    ...emitStatements(
                        statement.statements,
                        context,
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
                context.locals.set(statement.name, statement.type);
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
    if (block.systemMatrix && block.members.length > 0) {
        throw new Error(
            "Native WGSL does not yet support mixed system and custom uniform blocks.",
        );
    }
    const group = block.stage === "vertex" ? 1 : 3;
    if (block.systemMatrix) {
        return `struct ShaderSystemUniforms {
    worldViewProjection: mat4x4<f32>,
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

export function emitNativeWgslProgram(
    program: ShaderIrProgram,
    stage: ShaderStage,
): string {
    const module = stage === "vertex" ? program.vertex : program.fragment;
    const block = program.reflection.uniformBlocks.find(
        (candidate) => candidate.stage === stage,
    );
    const structs = new Map(module.structs.map((struct) => [struct.name, struct]));
    const context: EmitContext = {
        clipDepth: program.clipDepth,
        locals: new Map(
            module.entryPoint.parameters.map(({ name, type }) => [name, type]),
        ),
        structs,
    };
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
    const moduleStructs = module.structs.map((struct) =>
        [
            `struct ${struct.name} {`,
            ...struct.members.map(
                (member) =>
                    `    ${memberAttribute(member)}${member.name}: ${member.type},`,
            ),
            "};",
        ].join("\n"));
    for (const parameter of module.entryPoint.parameters) {
        context.locals.set(parameter.name, parameter.type);
    }
    const returnAttribute =
        module.entryPoint.returnAttribute?.kind === "location"
            ? `@location(${module.entryPoint.returnAttribute.value}) `
            : "";
    return [
        "// Native-specialized WGSL generated from the bblitec typed shader IR.",
        emitUniformBlock(block),
        vertexInput,
        ...moduleStructs,
        "",
        `@${stage}`,
        `fn ${module.entryPoint.name}(${module.entryPoint.parameters
            .map(({ name, type }) => `${name}: ${type}`)
            .join(", ")}) -> ${returnAttribute}${module.entryPoint.returnType} {`,
        ...emitStatements(module.entryPoint.statements, context, "    "),
        "}",
        "",
    ].filter((value): value is string => value !== undefined).join("\n");
}
