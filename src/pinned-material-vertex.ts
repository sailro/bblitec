import ts from "typescript";
import { LoweringContext } from "./lowering/context.js";
import { PinnedShaderText, type ShaderTextBinding } from "./lowering/pinned-shader-text.js";
import {
    expressionUsesPath,
    mapShaderExpression,
    mapShaderStatements,
    parseWgslFunction,
    parseWgslModule,
    parseWgslStatements,
    parseWgslStructDeclarations,
    type ShaderExpression,
    type ShaderModule,
    type ShaderStatement,
} from "./shader-ir.js";
import { emitWgslFunction, emitWgslStatements } from "./shader-wgsl-emitter.js";

const templateModule = "src/material/pbr/pbr-template.ts";
const skeletonModule = "src/shader/fragments/skeleton-fragment.ts";
const morphModule = "src/shader/fragments/morph-fragment-core.ts";
const instanceModule = "src/shader/fragments/thin-instance-fragment.ts";
type RequireShape = (condition: unknown, what: string) => asserts condition;
const path = (...parts: string[]): ShaderExpression => ({ kind: "path", parts });
const call = (name: string, ...arguments_: ShaderExpression[]): ShaderExpression =>
    ({ kind: "call", name, arguments: arguments_ });
const assign = (name: string, value: ShaderExpression): ShaderStatement =>
    ({ kind: "assign", target: path(...name.split(".")), value });
const isPath = (value: ShaderExpression, ...parts: string[]): boolean =>
    value.kind === "path" && value.parts.length === parts.length &&
    value.parts.every((part, index) => part === parts[index]);
const isNumber = (value: ShaderExpression | undefined, number: number): boolean =>
    value?.kind === "number" && Number(value.value.replace(/[fui]$/, "")) === number;
const member = (expression: ShaderExpression, name: string): ShaderExpression =>
    expression.kind === "path" ? path(...expression.parts, name) : { kind: "member", expression, member: name };

/** Substitute symbolic inputs and acyclic local aliases, not emitted WGSL text. */
function substitutePath(
    expression: ShaderExpression,
    bindings: ReadonlyMap<string, ShaderExpression>,
): ShaderExpression {
    if (expression.kind !== "path") return expression;
    for (let length = expression.parts.length; length > 0; --length) {
        const bound = bindings.get(expression.parts.slice(0, length).join("."));
        if (bound) return expression.parts.slice(length).reduce(member, bound);
    }
    return expression;
}

function substitute(value: ShaderExpression, bindings: ReadonlyMap<string, ShaderExpression>): ShaderExpression {
    return mapShaderExpression(value, expression => substitutePath(expression, bindings));
}

/** Raw pinned vertex computation, shared by GPU transport and CPU projections. */
export function pinnedPbrVertexTemplate(
    context: LoweringContext,
    morph = false,
): { declaration: ts.FunctionDeclaration; module: ShaderModule; position: string; normal: string } {
    const text = new PinnedShaderText(context);
    const { declaration } = context.functionDeclaration(templateModule, "createPbrTemplate");
    const parameters = new Map<string, ShaderTextBinding>([["_hasMorph", morph], ["hasNormal", true], ["_ext", false]]);
    for (const name of ["posVar", "normVar", "tangentBlock"]) {
        parameters.set(name, text.text(templateModule, context.variableInitializer(declaration, name), parameters));
    }
    const position = parameters.get("posVar"), normal = parameters.get("normVar");
    if (typeof position !== "string" || typeof normal !== "string") {
        context.contractError(declaration, "Pinned vertex template inputs must resolve to shader text.");
    }
    return {
        declaration,
        module: parseWgslModule(text.text(templateModule,
            context.variableInitializer(declaration, "_vertexTemplate"), parameters), "vertex"),
        position,
        normal,
    };
}

/** Resolve the pin's local aliases and output identity before choosing a transport. */
export function pinnedPbrVertexOutputs(
    context: LoweringContext,
    morph = false,
): ReturnType<typeof pinnedPbrVertexTemplate> & { outputs: ReadonlyMap<string, ShaderExpression> } {
    const template = pinnedPbrVertexTemplate(context, morph);
    const requireShape: RequireShape = (condition, what) => {
        if (!condition) context.contractError(template.declaration, `Pinned shared vertex ${what} changed.`);
    };
    checkReferences(template.module.entryPoint.statements,
        new Set(["mesh", "scene", template.position, template.normal, "tangent", "uv"]), requireShape);
    const locals = new Map<string, ShaderExpression>();
    const outputs = new Map<string, ShaderExpression>();
    let outputName: string | undefined;
    let returned = false;
    for (const statement of template.module.entryPoint.statements) {
        if ((statement.kind === "var" || statement.kind === "let") && statement.value) {
            requireShape(!locals.has(statement.name), "template local identity");
            locals.set(statement.name, substitute(statement.value, locals));
        } else if (statement.kind === "var" && statement.type === template.module.entryPoint.returnType && !outputName) {
            outputName = statement.name;
        } else if (statement.kind === "assign" && statement.target.kind === "path" &&
            statement.target.parts.length === 2 && statement.target.parts[0] === outputName) {
            const name = statement.target.parts[1]!;
            requireShape(!outputs.has(name), "template output write");
            outputs.set(name, substitute(statement.value, locals));
        } else if (statement.kind === "return" && statement.value && outputName &&
            isPath(statement.value, outputName) && !returned) {
            returned = true;
        } else requireShape(false, "template statement inventory");
    }
    const outputFields = ["worldPos", "clipPos", "worldNormal", "worldTangent", "worldBitangent", "uv"];
    requireShape(returned && outputs.size === outputFields.length &&
        outputFields.every(name => outputs.has(name)), "template outputs");
    return { ...template, outputs };
}

/**
 * Project the pinned material computations onto the specialized PAL stage.
 * Only transport is native: pre-baked worlds, uniform bone columns, two-target
 * attributes, and the shared varying locations. The builders own every sum,
 * normalization, cross product, matrix application and storage-morph index.
 */
export function pinnedMaterialVertex(
    context: LoweringContext,
    options: { deformation: boolean; instancing: boolean; morphStorage: boolean },
): { body: string; helpers: string; morphStructs: string; provenance: string } {
    const text = new PinnedShaderText(context);
    const pinnedTemplate = pinnedPbrVertexOutputs(context, options.deformation);
    const { declaration, outputs } = pinnedTemplate;
    const requireShape: RequireShape = (condition, what) => {
        if (!condition) context.contractError(declaration, `Pinned shared vertex ${what} changed.`);
    };
    const fragmentText = (module: string, factory: string, ...properties: string[]): string => {
        const { declaration: factoryDeclaration } = context.functionDeclaration(module, factory);
        let value: ts.Expression = context.returnObject(factoryDeclaration);
        for (const property of properties) {
            const object = context.unwrapExpression(value);
            if (!ts.isObjectLiteralExpression(object)) context.contractError(value, "Expected a pinned vertex fragment record.");
            value = context.propertyInitializer(object, property);
        }
        return text.text(module, value, new Map());
    };
    const morph = options.deformation
        ? parseWgslStatements(fragmentText(morphModule, "createMorphFragment", "_vertexSlots", "VR")) : undefined;
    if (morph) checkReferences(morph, new Set(["position", "normal", "vertexIndex", "morph", "morphDeltas"]), requireShape);
    const projectedMorph = morph ? projectMorph(morph, requireShape) : undefined;
    const positionName = projectedMorph?.position ?? "position";
    const normalName = projectedMorph?.normal ?? "normal";
    requireShape(pinnedTemplate.position === positionName && pinnedTemplate.normal === normalName, "morph template inputs");
    const output = (name: string): ShaderExpression => outputs.get(name)!;
    const nativeInputs = new Map<string, ShaderExpression>([
        [positionName, path("worldPosition")], [normalName, path("worldNormal")],
        ["tangent.xyz", path("worldTangent")], ["tangent.w", path("input", "tangent", "w")],
        ["uv", path("input", "uv")], ["scene.viewProjection", path("uniforms", "viewProjection")],
    ]);
    const bind = (value: ShaderExpression, world?: string): ShaderExpression =>
        mapShaderExpression(value, expression => world && isPath(expression, "mesh", "world")
            ? path(world) : substitutePath(expression, nativeInputs));
    const position = output("worldPos");
    requireShape(position.kind === "member" && position.member === "xyz" &&
        position.expression.kind === "binary" && position.expression.operator === "*" &&
        isPath(position.expression.left, "mesh", "world") && position.expression.right.kind === "construct" &&
        position.expression.right.type === "vec4<f32>" && position.expression.right.arguments.length === 2 &&
        isPath(position.expression.right.arguments[0]!, positionName) && isNumber(position.expression.right.arguments[1], 1),
    "homogeneous position transport");
    const direction = output("worldBitangent");
    if (direction.kind !== "member" || direction.member !== "xyz" ||
        direction.expression.kind !== "binary" || direction.expression.operator !== "*" ||
        !isPath(direction.expression.left, "mesh", "world") ||
        direction.expression.right.kind !== "construct" ||
        direction.expression.right.type !== "vec4<f32>" ||
        direction.expression.right.arguments.length !== 2 ||
        !isNumber(direction.expression.right.arguments[1], 0)) {
        context.contractError(declaration, "Pinned shared vertex homogeneous direction transport changed.");
    }
    const directionProduct = direction.expression;
    const directionVector = direction.expression.right;
    const transformDirection = (value: string, world: string): ShaderExpression => ({
        ...direction,
        expression: {
            ...directionProduct,
            left: path(world),
            right: { ...directionVector, arguments: [path(value), directionVector.arguments[1]!] },
        },
    });
    const statements: ShaderStatement[] = [
        { kind: "var", name: "worldPosition", value: path("input", "position") },
        { kind: "var", name: "worldNormal", value: path("input", "normal") },
        { kind: "var", name: "worldTangent", value: path("input", "tangent", "xyz") },
        // The shared transport retains its pre-morph bitangent independently.
        { kind: "var", name: "worldBitangent", value: bind(directionVector.arguments[0]!) },
    ];
    let helpers = "";
    let morphStructs = "";
    const origins = [context.provenance(templateModule, "createPbrTemplate")];
    if (options.deformation) {
        requireShape(morph && projectedMorph, "morph projection");
        const structs = fragmentText(morphModule, "createMorphFragment", "_vertexHelperFunctions");
        const declarations = parseWgslStructDeclarations(structs);
        requireShape(JSON.stringify(declarations) === JSON.stringify([
            { name: "morphUniforms", members: [
                { name: "count", type: "u32" }, { name: "vertexCount", type: "u32" },
                { name: "_p0", type: "u32" }, { name: "_p1", type: "u32" },
                { name: "weights", type: "array<f32>" },
            ] },
            { name: "morphDeltasUniforms", members: [{ name: "d", type: "array<f32>" }] },
        ]), "morph storage ABI");
        const deformation: ShaderStatement[] = [];
        if (options.morphStorage) {
            morphStructs = structs;
            const bindings = new Map([["position", path("worldPosition")], ["normal", path("worldNormal")],
                ["vertexIndex", path("input", "vertexIndex")]]);
            deformation.push(...mapShaderStatements(morph, expression => substitutePath(expression, bindings)),
                assign("worldPosition", path(projectedMorph.position)), assign("worldNormal", path(projectedMorph.normal)));
        } else {
            deformation.push(...attributeMorph(projectedMorph));
        }
        const skin = parseWgslStatements(text.evaluate(skeletonModule, "makeSkinningCode", new Map([["has8Bones", false]])));
        const last = skin.pop();
        requireShape(last?.kind === "assign" && isPath(last.target, "finalWorld") &&
            last.value.kind === "binary" && last.value.operator === "*" &&
            isPath(last.value.left, "mesh", "world"), "pre-baked palette world");
        // World is already in each palette entry. The pin's influence sum stays
        // ordered; only this now-redundant outer world application is removed.
        skin.push({ kind: "let", name: "skin", value: last.value.right });
        const skinInputs = new Map([["joints", path("input", "joints")], ["weights", path("input", "weights")]]);
        deformation.push(...mapShaderStatements(skin, expression => {
            if (expression.kind === "index" &&
                (isPath(expression.expression, "input", "joints") || isPath(expression.expression, "input", "weights"))) {
                requireShape([0, 1, 2, 3].some(index => isNumber(expression.index, index)), "four-influence vertex stream");
            }
            if (expression.kind === "call" && expression.name === "readMatrixFromRawSampler") {
                requireShape(expression.arguments.length === 2 &&
                    isPath(expression.arguments[0]!, "boneSampler"), "bone reader call");
                return call("bblReadBoneMatrix", expression.arguments[1]!);
            }
            return substitutePath(expression, skinInputs);
        }));
        deformation.push(
            assign("worldPosition", bind(output("worldPos"), "skin")),
            { kind: "if", condition: { kind: "binary", operator: "<",
                left: path("deformation", "options", "y"), right: { kind: "number", value: "0.5" } },
            statements: [assign("worldNormal", bind(output("worldNormal"), "skin"))] },
            assign("worldTangent", bind(output("worldTangent"), "skin")),
            assign("worldBitangent", transformDirection("worldBitangent", "skin")),
        );
        statements.push({ kind: "if", condition: { kind: "binary", operator: ">",
            left: path("deformation", "options", "x"), right: { kind: "number", value: "0.5" } },
        statements: deformation });
        const helperSource = context.moduleScopeConstant(context.sourceFile(skeletonModule), "SKELETON_HELPERS");
        if (!helperSource) context.contractError(declaration, "Pinned skeleton helper is missing.");
        helpers = paletteReader(text.text(skeletonModule, helperSource, new Map()), requireShape);
        origins.push(context.provenance(skeletonModule, "makeSkinningCode + SKELETON_HELPERS"),
            context.provenance(morphModule, "createMorphFragment"));
    }
    if (options.instancing) {
        const instance = parseWgslStatements(fragmentText(instanceModule, "createThinInstanceFragment", "_vertexSlots", "VW"));
        const last = instance.pop();
        requireShape(last?.kind === "assign" && isPath(last.target, "finalWorld"), "instance world assignment");
        instance.push({ kind: "let", name: "instanceMatrix", value: last.value });
        const bindings = new Map<string, ShaderExpression>([["mesh.world", path("instanceUniforms", "parentWorld")]]);
        for (let column = 0; column < 4; ++column) bindings.set(`world${column}`, path("input", `instanceColumn${column}`));
        statements.push(...mapShaderStatements(instance, expression => substitutePath(expression, bindings)),
            assign("worldPosition", bind(output("worldPos"), "instanceMatrix")),
            ...["worldNormal", "worldTangent", "worldBitangent"].map(name =>
                assign(name, transformDirection(name, "instanceMatrix"))));
        origins.push(context.provenance(instanceModule, "createThinInstanceFragment"));
    }
    const clip = mapShaderExpression(output("clipPos"), expression => {
        if (expression.kind === "binary" && isPath(expression.left, "mesh", "world")) {
            requireShape(expression.operator === "*" && expression.right.kind === "construct" &&
                expression.right.type === "vec4<f32>" && expression.right.arguments.length === 2 &&
                isPath(expression.right.arguments[0]!, positionName) && isNumber(expression.right.arguments[1], 1),
            "pre-transformed position");
            return expression.right;
        }
        return expression;
    });
    statements.push({ kind: "var", name: "output", type: "VertexOutput" },
        assign("output.position", bind(clip)),
        assign("output.worldPosition", path("worldPosition")),
        assign("output.normal", path("worldNormal")),
        assign("output.tangent", { kind: "construct", type: "vec4<f32>",
            arguments: [path("worldTangent"), path("input", "tangent", "w")] }),
        assign("output.uv", bind(output("uv"))),
        ...["localPosition", "uv2", "color"].map(name => assign(`output.${name}`, path("input", name))),
        assign("output.bitangent", path("worldBitangent")), { kind: "return", value: path("output") });
    checkReferences(statements, new Set(["input", "uniforms",
        ...(options.deformation ? ["deformation", ...(options.morphStorage ? ["morph", "morphDeltas"] : [])] : []),
        ...(options.instancing ? ["instanceUniforms"] : [])]), requireShape);
    return { body: emitWgslStatements(statements), helpers, morphStructs, provenance: origins.map(origin => `// ${origin}`).join("\n") };
}

function paletteReader(source: string, requireShape: RequireShape): string {
    const fn = parseWgslFunction(source);
    const [sampler, index] = fn.parameters;
    const offset = fn.statements[0];
    requireShape(fn.name === "readMatrixFromRawSampler" && fn.parameters.length === 2 &&
        sampler?.type === "texture_2d<f32>" && index?.type === "f32" &&
        fn.returnType === "mat4x4<f32>" && offset?.kind === "let", "bone reader interface");
    const address = offset.value;
    requireShape(address.kind === "binary" && address.operator === "*" && isNumber(address.right, 4) &&
        address.left.kind === "call" && address.left.name === "i32" &&
        address.left.arguments.length === 1 && isPath(address.left.arguments[0]!, index.name),
    "four-column bone texture address");
    let loads = 0;
    const statements = mapShaderStatements(fn.statements.slice(1), expression => {
        if (expression.kind !== "call" || expression.name !== "textureLoad") return expression;
        const coordinate = expression.arguments[1];
        requireShape(expression.arguments.length === 3 && isPath(expression.arguments[0]!, sampler.name) &&
            isNumber(expression.arguments[2], 0) && coordinate?.kind === "call" &&
            coordinate.name === "vec2<i32>" && coordinate.arguments.length === 2 &&
            isNumber(coordinate.arguments[1], 0), "bone texture load");
        const column = coordinate.arguments[0];
        requireShape(column?.kind === "binary" && column.operator === "+" &&
            isPath(column.left, offset.name) && [0, 1, 2, 3].some(value => isNumber(column.right, value)),
        "bone texture column");
        ++loads;
        return { kind: "index", expression: { kind: "index", expression: path("deformation", "boneMatrices"),
            index: call("u32", path(index.name)) }, index: column.right };
    });
    requireShape(loads === 4, "bone reader projection");
    checkReferences(statements, new Set([index.name, "deformation"]), requireShape);
    return emitWgslFunction({ ...fn, name: "bblReadBoneMatrix", parameters: [index], statements });
}

interface MorphProjection {
    position: string;
    normal: string;
    updates: [ShaderExpression, ShaderExpression];
}

function projectMorph(
    statements: ShaderStatement[],
    requireShape: RequireShape,
): MorphProjection {
    const [position, normal, loop] = statements;
    requireShape(statements.length === 3 && position?.kind === "var" && normal?.kind === "var" &&
        loop?.kind === "for", "bounded morph statement inventory");
    const counter = loop.initializer.name;
    requireShape(position.value && isPath(position.value, "position") && normal.value && isPath(normal.value, "normal") &&
        isNumber(loop.initializer.value, 0) && loop.condition.kind === "binary" && loop.condition.operator === "<" &&
        isPath(loop.condition.left, counter) && isPath(loop.condition.right, "morph", "count") &&
        isPath(loop.update.target, counter) && loop.update.value.kind === "binary" && loop.update.value.operator === "+" &&
        isPath(loop.update.value.left, counter) && isNumber(loop.update.value.right, 1), "bounded morph loop");
    const locals = new Map<string, ShaderExpression>();
    const writes: Array<Extract<ShaderStatement, { kind: "assign" }>> = [];
    for (const statement of loop.statements) {
        if (statement.kind === "let") locals.set(statement.name, statement.value);
        else if (statement.kind === "assign") writes.push(statement);
        else requireShape(false, "bounded morph loop body");
    }
    requireShape(writes.length === 2 && isPath(writes[0]!.target, position.name) &&
        isPath(writes[1]!.target, normal.name), "bounded morph destinations");
    const updates = [writes[0]!, writes[1]!].map((write, channel) => {
        const destination = channel === 0 ? position.name : normal.name;
        let deltas = 0;
        const project = (value: ShaderExpression): ShaderExpression => mapShaderExpression(value, expression => {
            if (expression.kind === "path") {
                if (isPath(expression, destination)) return path("bblMorphAccumulator");
                const local = expression.parts.length === 1 ? locals.get(expression.parts[0]!) : undefined;
                if (local) return project(local);
            }
            if (expression.kind === "index" && isPath(expression.expression, "morph", "weights")) {
                requireShape(isPath(expression.index, counter), "bounded morph weight index");
                return path("bblMorphWeight");
            }
            if (expression.kind === "construct" && expression.type === "vec3<f32>" &&
                expression.arguments.every(argument => argument.kind === "index" && isPath(argument.expression, "morphDeltas", "d"))) {
                // The slot's complete delta expression, including its
                // address arithmetic, must fit the native six-float ABI.
                const base = channel * 3;
                requireShape(expression.arguments.length === 3 && expression.arguments.every((argument, component) => {
                    if (argument.kind !== "index") return false;
                    const address = argument.index;
                    const offset = base + component;
                    const origin = offset === 0 ? address :
                        address.kind === "binary" && address.operator === "+" && isNumber(address.right, offset)
                            ? address.left : undefined;
                    return origin?.kind === "binary" && origin.operator === "*" && isNumber(origin.right, 6) &&
                        origin.left.kind === "binary" && origin.left.operator === "+" &&
                        isPath(origin.left.right, "vertexIndex") && origin.left.left.kind === "binary" &&
                        origin.left.left.operator === "*" && isPath(origin.left.left.left, counter) &&
                        isPath(origin.left.left.right, "morph", "vertexCount");
                }), "six-float morph attribute address");
                ++deltas;
                return path("bblMorphDelta");
            }
            return expression;
        });
        const value = project(write.value);
        requireShape(deltas === 1 && !expressionUsesPath(value, parts =>
            !["bblMorphAccumulator", "bblMorphWeight", "bblMorphDelta"].includes(parts[0]!)), "bounded morph projection");
        return value;
    });
    return { position: position.name, normal: normal.name, updates: [updates[0]!, updates[1]!] };
}

function attributeMorph(projection: MorphProjection): ShaderStatement[] {
    const result: ShaderStatement[] = [];
    for (let target = 0; target < 2; ++target) {
        for (const [update, destination, lane] of [
            [projection.updates[0], "worldPosition", "morphPosition"],
            [projection.updates[1], "worldNormal", "morphNormal"],
            // Retain the PAL's tangent delta stream using the same pinned
            // accumulation; the upstream storage payload has no tangent lane.
            [projection.updates[1], "worldTangent", "morphTangent"],
        ] as const) {
            result.push(assign(destination, substitute(update, new Map([
                ["bblMorphAccumulator", path(destination)],
                ["bblMorphDelta", path("input", `${lane}${target}`)],
                ["bblMorphWeight", path("deformation", "morphWeights", target === 0 ? "x" : "y")],
            ]))));
        }
    }
    return result;
}

function checkReferences(
    statements: ShaderStatement[],
    names: Set<string>,
    requireShape: RequireShape,
): void {
    const check = (expression: ShaderExpression, scope = names): void => {
        mapShaderExpression(expression, node => {
            if (node.kind === "path") requireShape(scope.has(node.parts[0]!), `unbound input '${node.parts.join(".")}'`);
            if (node.kind === "call") requireShape(
                ["normalize", "cross", "f32", "i32", "u32", "bblReadBoneMatrix"].includes(node.name),
                `unmapped function '${node.name}'`);
            return node;
        });
    };
    for (const statement of statements) {
        switch (statement.kind) {
            case "var":
            case "let":
                if (statement.value) check(statement.value);
                requireShape(!names.has(statement.name), `local collision '${statement.name}'`);
                names.add(statement.name);
                break;
            case "assign": check(statement.target); check(statement.value); break;
            case "return": if (statement.value) check(statement.value); break;
            case "expression": check(statement.value); break;
            case "if":
                check(statement.condition);
                checkReferences(statement.statements, new Set(names), requireShape);
                break;
            case "for": {
                const loopNames = new Set(names);
                checkReferences([statement.initializer], loopNames, requireShape);
                check(statement.condition, loopNames);
                checkReferences(statement.statements, new Set(loopNames), requireShape);
                checkReferences([statement.update], loopNames, requireShape);
                break;
            }
            case "discard": requireShape(false, "vertex discard"); break;
        }
    }
}
