import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";
import type {PinnedBinding, PinnedNumericLowerer} from "../pinned-numeric-lowerer.js";

const modulePath = "src/skeleton/skeleton-updater.ts";

/** Preserve the controller module's own root conversion constant. */
export function lowerGltfAnimationRootFlip(context: LoweringContext, module = modulePath): string {
    const file=context.sourceFile(module);
    const expression=context.unwrapExpression(context.variableInitializer(file,"RH_TO_LH"));
    if(!ts.isNewExpression(expression)||!ts.isIdentifier(expression.expression)||expression.expression.text!=="F32"||
        expression.arguments?.length!==1||!ts.isArrayLiteralExpression(expression.arguments[0]!))
        context.contractError(expression,"Expected the source controller's Float32 root conversion.");
    const values=expression.arguments[0]!.elements;
    if(values.length!==16)context.contractError(expression,"Expected a sixteen-lane controller root matrix.");
    return `GltfAnimationFloats{${values.map(value=>`static_cast<float>(${context.doubleLiteral(context.numericValue(value,file))})`).join(",")}}`;
}

/** The complete source tick after clock selection. Callbacks adapt storage and GPU writes. */
export function lowerGltfAnimationPose(context: LoweringContext): string {
    const {file, declaration} = context.functionDeclaration(modulePath, "createAnimationController");
    const value = context.unwrapExpression(context.variableInitializer(declaration, "ctrl"));
    if (!ts.isObjectLiteralExpression(value)) context.contractError(value, "Expected the animation controller.");
    const tick = value.properties.find(property => ts.isPropertyAssignment(property) && context.propertyName(property.name) === "tick");
    if (!tick || !ts.isPropertyAssignment(tick) || !ts.isConditionalExpression(tick.initializer) ||
        !ts.isArrowFunction(tick.initializer.whenFalse) || !ts.isBlock(tick.initializer.whenFalse.body))
        context.contractError(value, "Expected the source animation tick.");
    const statements = tick.initializer.whenFalse.body.statements;
    const clock = statements.findIndex(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(variable => ts.isIdentifier(variable.name) && variable.name.text === "t"));
    if (clock < 0) context.contractError(tick, "Expected the source pose-time boundary.");
    const bindings = new Map<string, PinnedBinding>();
    const bind = (name: string, cpp: string, type: PinnedBinding["type"] = "scalar") => bindings.set(name, {cpp, type});
    const types = context.sourceFile("src/animation/types.ts");
    for (const name of ["PATH_TRANSLATION", "PATH_ROTATION", "PATH_SCALE", "PATH_WEIGHTS", "PATH_POINTER"])
        bind(name, context.doubleLiteral(context.numericValue(ts.factory.createIdentifier(name), types)));
    for (const name of ["currentTRS", "localMat", "worldMat", "_boneTmp", "RH_TO_LH"])
        bind(name, `state.${name}`, "f32");
    for (const name of ["pointerScratch", "morphUploadF32"]) bind(name, `(*state.${name})`, "f32");
    bind("numNodes", "static_cast<double>(state.nodes.size())");
    bind("t", "time");
    bind("uploadGpu", "upload_gpu", "bool");
    bind("maskActive", "state.mask_active", "bool");
    bind("_maskResolver", "state.mask_resolver", "bool");
    bind("boneOverrides", "state.has_bone_overrides", "bool");
    bind("boneOverrides.size", "state.bone_override_count");
    bind("clip.channels.length", "static_cast<double>(state.channels.size())");
    bind("nodeTrsBindings.length", "static_cast<double>(state.node_trs_bindings.size())");
    bind("clipSkeletons.length", "static_cast<double>(state.skeletons.size())");
    for (const [name, members] of [
        ["n", ["tx", "ty", "tz", "rx", "ry", "rz", "rw", "sx", "sy", "sz"]],
        ["ch", ["nodeIdx", "samplerIdx", "path", "pointerArity", "pointerQuaternion"]],
        ["b", ["off", "mask"]], ["node", ["parentIdx"]], ["skel", ["boneCount"]],
        ["mb", ["targetCount"]],
    ] as const) {
        bind(name, name, "opaque");
        for (const member of members) bind(`${name}.${member}`, `${name}.${member}`,
            member === "pointerQuaternion" ? "bool" : "scalar");
    }
    bind("ch.pointerWriter", "ch.pointer_writer", "bool");
    bind("node._matrix", "node.matrix.has_value()", "bool");
    bindings.set("bindings", {cpp: "bindings", type: "opaque", absentCpp: "!bindings"});
    bind("bindings.length", "static_cast<double>(bindings->size())");
    bind("boneData", "boneData", "f32");
    bind("sampler", "sampler", "opaque");
    bind("skel.inverseBindMatrices", "skel.inverseBindMatrices", "f32");
    bind("skel.invMeshWorld", "skel.invMeshWorld", "f32");
    bind("mb.weights", "mb.weights", "f32");
    bind("mb.runtimeMorphTargets._disposed", "mb.disposed", "bool");
    bind("skel.runtimeSkeleton._disposed", "skel.disposed", "bool");
    const arrays = new Map([
        ["nodes", "state.nodes"], ["clip.channels", "state.channels"], ["clip.samplers", "state.samplers"],
        ["nodeTrsBindings", "state.node_trs_bindings"], ["topoOrder", "state.topo_order"],
        ["clipSkeletons", "state.skeletons"], ["boneScratch", "state.bone_scratch"],
        ["skel.jointNodes", "skel.jointNodes"], ["bindings", "(*bindings)"], ["maskedNodes", "state.masked_nodes"],
    ]);
    const arrayRead = (node: ts.Expression, lowerer: PinnedNumericLowerer): string | undefined => {
        if (!ts.isElementAccessExpression(node)) return undefined;
        const receiver = context.unwrapExpression(node.expression);
        const source = [...arrays].find(([name]) => context.expressionMatchesShape(receiver, name))?.[1];
        return source ? `${source}.at(static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)}))` : undefined;
    };
    const calls = new Map<string, (args: readonly string[]) => string>([
        ["evaluateSampler", args => `evaluate_sampler(${args.join(", ")})`],
        ["mat4ComposeInto", args => `compose_matrix(${args.join(", ")})`],
        ["mat4MultiplyInto", args => `multiply_matrix(${args.join(", ")})`],
        ["morphUploadF32.fill", args => `std::fill(state.morphUploadF32->begin(), state.morphUploadF32->end(), static_cast<float>(${args[0]}))`],
    ]);
    const aliases = new Set(["n", "ch", "sampler", "bindings", "mb", "b", "node", "skel", "boneData"]);
    const body = lowerPinnedBody(file, statements.slice(clock + 1), {
        bindings, calls, booleanAnd: true, booleanOr: true,
        expression(node, lowerer) {
            const read = arrayRead(node, lowerer);
            if (read) return read;
            if (context.expressionMatchesShape(node, "boneOverrides !== undefined")) return "state.has_bone_overrides";
            if (context.expressionMatchesShape(node, "_maskResolver !== null")) return "state.mask_resolver";
            if (context.expressionMatchesShape(node, "node._matrix")) return "node.matrix.has_value()";
            if (context.expressionMatchesShape(node, "bindings[0]!.targetCount")) return "bindings->at(0).targetCount";
            if (context.expressionMatchesShape(node, "morphBindingsByNode[ch.nodeIdx]"))
                return "morph_bindings(ch.nodeIdx)";
            if (context.expressionMatchesShape(node, "mb.runtimeMorphTargets?._disposed")) return "mb.disposed";
            if (context.expressionMatchesShape(node, "skel.runtimeSkeleton?._disposed")) return "skel.disposed";
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isSwitchStatement(statement)) {
                const selected = lowerer.expression(statement.expression);
                return statement.caseBlock.clauses.flatMap((clause, index) => {
                    if (!ts.isCaseClause(clause)) context.contractError(clause, "Expected a named source animation path.");
                    const arm = clause.statements.length === 1 && ts.isBlock(clause.statements[0]!)
                        ? clause.statements[0]!.statements : clause.statements;
                    if (!arm.length || !ts.isBreakStatement(arm.at(-1)!)) context.contractError(clause, "Expected a terminating animation path.");
                    for (const child of arm.slice(0, -1)) if (context.hasNode(child, node => ts.isBreakStatement(node) || ts.isContinueStatement(node)))
                        context.contractError(child, "Nested animation-path control transfer needs an explicit switch boundary.");
                    return [`${indent}${index ? "else " : ""}if (${selected} == ${lowerer.expression(clause.expression)}) {`,
                        ...lowerer.statements(arm.slice(0, -1), indent + "    "), `${indent}}`];
                });
            }
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (ts.isIdentifier(variable.name) && variable.initializer && aliases.has(variable.name.text)) {
                    const name = variable.name.text;
                    return [`${indent}${name === "bindings" ? "auto*" : "auto&"} ${name} = ${lowerer.expression(variable.initializer)};`];
                }
            }
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = context.unwrapExpression(statement.expression);
            if (ts.isBinaryExpression(expression) && context.expressionMatchesShape(expression.left, "morphUploadF32") &&
                ts.isNewExpression(expression.right)) {
                if (!ts.isIdentifier(expression.right.expression) || expression.right.expression.text !== "F32" || expression.right.arguments?.length !== 1)
                    context.contractError(expression, "Expected source morph scratch allocation.");
                return [`${indent}state.morphUploadF32 = std::make_shared<std::vector<float>>(static_cast<std::size_t>(${lowerer.expression(expression.right.arguments[0]!)}), 0.0f);`];
            }
            if (!ts.isCallExpression(expression)) return undefined;
            const callee = expression.expression;
            if (context.expressionMatchesShape(callee, "_boneApplier")) {
                if (expression.arguments.length < 3 || expression.arguments.length > 4) context.contractError(expression, "Expected the bone override hook.");
                context.assertExpressionShape(expression.arguments[0]!, "boneOverrides as ReadonlyMap<number, BoneOverride>", "Bone override identity");
                return [`${indent}apply_bone_overrides(${expression.arguments.slice(1).map(argument => lowerer.expression(argument)).join(", ")}${expression.arguments.length === 3 ? ", false" : ""});`];
            }
            if (context.expressionMatchesShape(callee, "mb.weights.set")) {
                context.assertExpressionShape(expression, "mb.weights.set(morphUploadF32.subarray(0, tc))", "Morph weight storage copy");
                return [`${indent}std::copy_n(state.morphUploadF32->begin(), static_cast<std::size_t>(tc), mb.weights.begin());`];
            }
            if (context.expressionMatchesShape(callee, "device!.queue.writeBuffer")) {
                context.assertExpressionShape(expression, "device!.queue.writeBuffer(mb.runtimeMorphTargets?.weightsBuffer ?? mb.weightsBuffer, 16, morphUploadF32.buffer, 0, tc * 4)", "Morph GPU upload transport");
                return [`${indent}upload_morph(mb, *state.morphUploadF32, tc);`];
            }
            if (context.expressionMatchesShape(callee, "device!.queue.writeTexture")) {
                context.assertExpressionShape(expression, "device!.queue.writeTexture({ texture: skel.runtimeSkeleton?.boneTexture ?? skel.boneTexture }, boneData.buffer, { bytesPerRow: texWidth * 16 }, { width: texWidth, height: 1 })", "Bone GPU upload transport");
                return [`${indent}upload_bones(skel, boneData, texWidth);`];
            }
            if (context.expressionMatchesShape(callee, "ch.pointerWriter")) {
                return [`${indent}write_pointer(ch, ${expression.arguments.map(argument => lowerer.expression(argument)).join(", ")});`];
            }
            for (const [source, target] of [["position", "translation"], ["rotationQuaternion", "rotation"], ["scaling", "scale"]]) {
                if (context.expressionMatchesShape(callee, `b.target.${source}.set`))
                    return [`${indent}write_${target}(b.target, ${expression.arguments.map(argument => lowerer.expression(argument)).join(", ")});`];
            }
            if (context.expressionMatchesShape(callee, "localMat.set")) {
                context.assertExpressionShape(expression.arguments[0]!, "node._matrix", "Authored local matrix storage");
                return [`${indent}std::copy(node.matrix->begin(), node.matrix->end(), state.localMat.begin() + static_cast<std::size_t>(${lowerer.expression(expression.arguments[1]!)}));`];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(modulePath, "createAnimationController")}
template<class State, class EvaluateSampler, class ComposeMatrix, class MultiplyMatrix,
    class MorphBindings, class BoneOverrides, class WritePointer, class WriteTranslation,
    class WriteRotation, class WriteScale, class UploadMorph, class UploadBones>
void gltf_evaluate_animation_pose(State& state, double time, bool upload_gpu,
    EvaluateSampler evaluate_sampler, ComposeMatrix compose_matrix, MultiplyMatrix multiply_matrix,
    MorphBindings morph_bindings, BoneOverrides apply_bone_overrides, WritePointer write_pointer,
    WriteTranslation write_translation, WriteRotation write_rotation, WriteScale write_scale,
    UploadMorph upload_morph, UploadBones upload_bones) {
${body}
}
`;
}
