import {
    mapShaderExpression,
    mapShaderStatements,
    parseWgslModule,
    statementUsesPath,
    type ShaderExpression,
    type ShaderModule,
    type ShaderStruct,
} from "./shader-ir.js";

function requireShape(condition: unknown, description: string): asserts condition {
    if (!condition) throw new Error(`Pinned skybox-cubemap ${description} changed.`);
}

function one<T>(values: readonly T[], description: string): T {
    requireShape(values.length === 1, description);
    return values[0]!;
}

const path = (...parts: string[]): ShaderExpression => ({ kind: "path", parts });
const isPath = (expression: ShaderExpression, ...parts: string[]): boolean =>
    expression.kind === "path" && expression.parts.length === parts.length &&
    expression.parts.every((part, index) => part === parts[index]);

function structure(module: ShaderModule, name: string): ShaderStruct {
    return one(module.structs.filter((value) => value.name === name), `struct ${name}`);
}

/** Adapt the pin's stages to the native skybox's position-only vertex buffer
 * and 64-byte vertex UBO. Identity world multiplication is eliminated; the
 * affine fog-view transform moves after interpolation into the fragment stage.
 * Every other expression remains the pin's parsed expression. */
export function specializeImageSkybox(
    vertexSource: string,
    fragmentSource: string,
): { vertex: ShaderModule; fragment: ShaderModule } {
    const vertex = parseWgslModule(vertexSource, "vertex");
    const fragment = parseWgslModule(fragmentSource, "fragment");
    const mesh = one(vertex.bindings ?? [], "mesh binding");
    requireShape(mesh.group === 1 && mesh.binding === 0 && mesh.addressSpace === "uniform", "mesh binding");
    const meshMembers = structure(vertex, mesh.type).members;
    requireShape(meshMembers.length === 1 && meshMembers[0]?.name === "world" &&
        meshMembers[0].type === "mat4x4<f32>", "mesh block");
    const parameters = vertex.entryPoint.parameters;
    const position = one(parameters.filter((parameter) =>
        parameter.attribute?.kind === "location" && parameter.attribute.value === 0), "position input");
    const normal = one(parameters.filter((parameter) =>
        parameter.attribute?.kind === "location" && parameter.attribute.value === 1), "normal input");
    requireShape(parameters.length === 2 && position.type === "vec3<f32>" && normal.type === "vec3<f32>", "vertex inputs");
    const vertexStatements = vertex.entryPoint.statements;
    requireShape(!vertexStatements.some((statement) =>
        statementUsesPath(statement, (parts) => parts[0] === normal.name)), "unused normal input");
    const outputStruct = structure(vertex, vertex.entryPoint.returnType);
    const output = one(vertexStatements.filter((statement) =>
        statement.kind === "var" && statement.type === outputStruct.name), "vertex output");
    requireShape(output.kind === "var" && !output.value, "vertex output declaration");
    const worldPosition = one(vertexStatements.filter((statement) =>
        statement.kind === "let" && statement.value.kind === "binary" &&
        isPath(statement.value.left, mesh.name, "world")), "world position");
    requireShape(worldPosition.kind === "let" && worldPosition.value.kind === "binary" &&
        worldPosition.value.operator === "*", "world position product");
    const position4 = worldPosition.value.right;
    requireShape(position4.kind === "construct" && position4.type === "vec4<f32>" &&
        position4.arguments.length === 2 && isPath(position4.arguments[0]!, position.name) &&
        position4.arguments[1]?.kind === "number" && Number(position4.arguments[1].value) === 1, "homogeneous position");
    const worldVarying = one(vertexStatements.filter((statement) =>
        statement.kind === "assign" && isPath(statement.target, output.name, "vPositionW")), "world varying");
    requireShape(worldVarying.kind === "assign" &&
        isPath(worldVarying.value, worldPosition.name, "xyz"), "world varying value");
    const fog = one(vertexStatements.filter((statement) =>
        statement.kind === "assign" && isPath(statement.target, output.name, "vFogDistance")), "fog varying");
    requireShape(fog.kind === "assign" && fog.value.kind === "member" && fog.value.member === "xyz" &&
        fog.value.expression.kind === "binary" && fog.value.expression.operator === "*" &&
        isPath(fog.value.expression.left, "scene", "view") &&
        isPath(fog.value.expression.right, worldPosition.name), "affine fog transform");

    const input = one(fragment.entryPoint.parameters, "fragment input");
    const inputStruct = structure(fragment, input.type);
    const varyings = outputStruct.members.filter((member) => member.attribute?.kind === "location");
    requireShape(varyings.length === 3 && inputStruct.members.length === 3 &&
        varyings.every((member) => inputStruct.members.some((other) =>
            member.name === other.name && member.type === other.type &&
            member.attribute?.kind === other.attribute?.kind && member.attribute?.value === other.attribute?.value)), "stage varyings");
    const clip = one(outputStruct.members.filter((member) =>
        member.attribute?.kind === "builtin" && member.attribute.value === "position"), "clip output");
    const fragmentBindings = fragment.bindings ?? [];
    const texture = one(fragmentBindings.filter((binding) => binding.type === "texture_cube<f32>"), "texture binding");
    const sampler = one(fragmentBindings.filter((binding) => binding.type === "sampler"), "sampler binding");
    requireShape(fragmentBindings.length === 2 && texture.group === 1 && texture.binding === 1 &&
        sampler.group === 1 && sampler.binding === 2, "fragment bindings");

    // These adapter names also belong to the shared fog helper's contract.
    for (const module of [vertex, fragment]) {
        requireShape(!module.structs.some((value) => value.name === "BblSkyboxUniforms") &&
            !module.entryPoint.parameters.some((value) => value.name === "uniforms") &&
            !module.entryPoint.statements.some((statement) =>
                (statement.kind === "let" || statement.kind === "var") && statement.name === "uniforms"), "adapter names");
    }
    vertex.structs = [outputStruct, { name: "BblSkyboxUniforms", members: [
        { name: "viewProjection", type: "mat4x4<f32>" },
    ] }];
    vertex.bindings = [{ name: "uniforms", type: "BblSkyboxUniforms", addressSpace: "uniform", group: 1, binding: 0 }];
    outputStruct.members = outputStruct.members.filter((member) => member.name !== "vFogDistance");
    vertex.entryPoint.parameters = [position];
    vertex.entryPoint.name = "mainVertex";
    vertex.entryPoint.statements = mapShaderStatements(vertexStatements.filter((statement) => statement !== fog), (expression) => {
        if (expression.kind === "binary" && isPath(expression.left, mesh.name, "world")) return position4;
        if (isPath(expression, "scene", "viewProjection")) return path("uniforms", "viewProjection");
        return expression;
    });

    const interpolatedPosition4 = { ...position4, arguments: [path(input.name, "vPositionW"), position4.arguments[1]!] };
    const fogExpression = mapShaderExpression(fog.value, (expression) => {
        if (isPath(expression, "scene", "view")) return path("uniforms", "view");
        if (isPath(expression, worldPosition.name)) return interpolatedPosition4;
        return expression;
    });
    let fogCalls = 0;
    fragment.entryPoint.statements = mapShaderStatements(fragment.entryPoint.statements, (expression) => {
        if (isPath(expression, "scene", "vFogInfos", "x")) return path("uniforms", "fogInfos", "x");
        if (isPath(expression, "scene", "vFogColor", "rgb")) return path("uniforms", "fogColor", "rgb");
        if (expression.kind === "call" && expression.name === "calcFogFactor") {
            requireShape(expression.arguments.length === 1 &&
                isPath(expression.arguments[0]!, input.name, "vFogDistance"), "fog call");
            ++fogCalls;
            return { ...expression, name: "bblCalcFogFactor", arguments: [fogExpression] };
        }
        return expression;
    });
    requireShape(fogCalls === 1, "fog call count");
    inputStruct.members = [clip, ...inputStruct.members.filter((member) => member.name !== "vFogDistance")];
    fragment.structs = [inputStruct, { name: "BblSkyboxUniforms", members: [
        { name: "view", type: "mat4x4<f32>" },
        { name: "fogInfos", type: "vec4<f32>" },
        { name: "fogColor", type: "vec4<f32>" },
    ] }];
    fragment.bindings = [
        { ...texture, group: 2, binding: 0 }, { ...sampler, group: 2, binding: 1 },
        { name: "uniforms", type: "BblSkyboxUniforms", addressSpace: "uniform", group: 3, binding: 0 },
    ];
    fragment.entryPoint.name = "mainFragment";
    for (const module of [vertex, fragment]) {
        requireShape(!module.entryPoint.statements.some((statement) =>
            statementUsesPath(statement, (parts) => parts[0] === "scene" || (module === vertex && parts[0] === mesh.name) ||
                parts.includes("vFogDistance"))), "unmapped scene/mesh/fog reference");
    }
    return { vertex, fragment };
}
