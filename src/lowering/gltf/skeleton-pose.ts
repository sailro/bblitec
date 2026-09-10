import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody, type PinnedBodyScope} from "../pinned-body-lowerer.js";
import type {PinnedBinding, PinnedNumericLowerer} from "../pinned-numeric-lowerer.js";

const module = "src/skeleton/skeleton-pose.ts";

/** Eager bone baking has its own source reset, world composition and disposal gate. */
export function lowerGltfSkeletonPose(context: LoweringContext): string {
    const file = context.sourceFile(module);
    const bindings = new Map<string, PinnedBinding>();
    const bind = (name: string, cpp: string, type: PinnedBinding["type"] = "scalar") => bindings.set(name, {cpp, type});
    bind("nodes.length", "static_cast<double>(state.nodes.size())");
    bind("numNodes", "static_cast<double>(state.nodes.size())");
    bind("skeletons.length", "static_cast<double>(state.skeletons.size())");
    for (const name of ["currentTRS", "localMat", "worldMat", "RH_TO_LH", "_boneTmp"])
        bind(name, `state.${name}`, "f32");
    bind("topoOrder", "state.topo_order", "f64-buffer");
    bind("order", "order", "f64-buffer");
    bind("visited", "visited", "u8");
    bind("idx", "idx");
    for (const name of ["TRS_STRIDE", "T_OFF", "R_OFF", "S_OFF"])
        bind(name, context.doubleLiteral(context.numericValue(ts.factory.createIdentifier(name), file)));
    for (const name of ["tx", "ty", "tz", "rx", "ry", "rz", "rw", "sx", "sy", "sz"])
        bind(`n.${name}`, `n.${name}`);
    bind("node.parentIdx", "node.parentIdx");
    bind("node._matrix", "node.matrix.has_value()", "bool");
    bind("worldOverride", "world_override", "opaque");
    bindings.get("worldOverride")!.absentCpp = "!world_override";
    bind("skel.runtimeSkeleton._disposed", "skel.disposed", "bool");
    bind("skel.boneCount", "skel.boneCount");
    bind("skel.inverseBindMatrices", "skel.inverseBindMatrices", "f32");
    bind("skel.invMeshWorld", "skel.invMeshWorld", "f32");
    bind("boneData", "boneData", "f32");
    const indexed = new Map([["nodes", "state.nodes"], ["skeletons", "state.skeletons"], ["skel.jointNodes", "skel.jointNodes"]]);
    const expression = (node: ts.Expression, numeric: PinnedNumericLowerer): string | undefined => {
        if (context.expressionMatchesShape(node, "skel.runtimeSkeleton?._disposed")) return "skel.disposed";
        if (context.expressionMatchesShape(node, "nodes[idx]!.parentIdx"))
            return "state.nodes.at(static_cast<std::size_t>(idx)).parentIdx";
        if (ts.isElementAccessExpression(node)) {
            const array = [...indexed].find(([name]) => context.expressionMatchesShape(node.expression, name))?.[1];
            if (array) return `${array}.at(static_cast<std::size_t>(${numeric.expression(node.argumentExpression)}))`;
        }
        if (context.expressionMatchesShape(node, "worldOverrides?.get(nodeIdx)")) return "world_override_for(nodeIdx)";
        return undefined;
    };
    const scope: PinnedBodyScope = {
        bindings, calls: new Map([
            ["visit", args => `visit(${args.join(", ")})`],
            ["mat4ComposeInto", args => `compose_matrix(${args.join(", ")})`],
            ["mat4MultiplyInto", args => `multiply_matrix(${args.join(", ")})`],
        ]), expression, booleanAnd: true, booleanOr: true,
        statement(node, numeric, indent) {
            if (ts.isFunctionDeclaration(node)) {
                if (node.name?.text !== "visit" || !node.body || node.parameters.length !== 1)
                    context.contractError(node, "Expected source recursive topological traversal.");
                return [`${indent}std::function<void(double)> visit = [&](double idx) {`,
                    ...numeric.statements(node.body.statements, indent + "    "), `${indent}};`];
            }
            if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
                const variable = node.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                const name = variable.name.text;
                if (name === "order" || name === "visited") {
                    context.assertExpressionShape(variable.initializer, name === "order" ? "new I32(n)" : "new U8(n)", "Topological scratch storage");
                    return [`${indent}std::vector<${name === "order" ? "double" : "std::uint8_t"}> ${name}(static_cast<std::size_t>(n));`];
                }
                if (["n", "node", "skel"].includes(name) && ts.isElementAccessExpression(context.unwrapExpression(variable.initializer)))
                    return [`${indent}auto& ${name} = ${numeric.expression(variable.initializer)};`];
                if (name === "worldOverride") return [`${indent}const auto* world_override = ${numeric.expression(variable.initializer)};`];
                if (name === "boneData") {
                    context.assertExpressionShape(variable.initializer, "skel.boneMatrices", "Eager shared palette identity");
                    return [`${indent}auto& boneData = *skel.boneMatrices;`];
                }
            }
            if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return undefined;
            const call = node.expression;
            if (context.expressionMatchesShape(call.expression, "localMat.set")) {
                context.assertExpressionShape(call.arguments[0]!, "node._matrix", "Eager authored matrix identity");
                return [`${indent}std::copy(node.matrix->begin(), node.matrix->end(), state.localMat.begin() + static_cast<std::size_t>(${numeric.expression(call.arguments[1]!)}));`];
            }
            if (context.expressionMatchesShape(call.expression, "worldMat.set")) {
                context.assertExpressionShape(call.arguments[0]!, "worldOverride", "Eager world override identity");
                return [`${indent}std::copy(world_override->begin(), world_override->end(), state.worldMat.begin() + static_cast<std::size_t>(${numeric.expression(call.arguments[1]!)}));`];
            }
            if (context.expressionMatchesShape(call.expression, "device.queue.writeTexture")) {
                context.assertExpressionShape(call, `device.queue.writeTexture(
                    { texture: skel.runtimeSkeleton?.boneTexture ?? skel.boneTexture }, boneData.buffer,
                    { bytesPerRow: texWidth * 16 }, { width: texWidth, height: 1 })`, "Eager bone GPU upload");
                return [`${indent}upload_bones(skel, boneData, texWidth);`];
            }
            return undefined;
        },
        returnValue: (node, numeric) => node ? numeric.expression(node) : "",
    };
    const lower = (name: string) => lowerPinnedBody(file, context.functionDeclaration(module, name).declaration.body!.statements, scope);
    const build = context.functionDeclaration("src/skeleton/bone-control.ts", "buildSkeletons");
    const bake = context.variableInitializer(build.declaration, "bake");
    if (!ts.isArrowFunction(bake) || !ts.isBlock(bake.body)) context.contractError(bake, "Expected source eager bake closure.");
    const bakeBody = lowerPinnedBody(build.file, bake.body.statements, {
        bindings: new Map([["overrides.size", {cpp: "override_count", type: "scalar"}]]),
        calls: new Map(),
        statement(node, _numeric, indent) {
            if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return undefined;
            const call = node.expression;
            if (context.expressionMatchesShape(call.expression, "resetTRS")) {
                context.assertExpressionShape(call, "resetTRS(nodes, numNodes, currentTRS)", "Eager rest reset inputs");
                return [`${indent}gltf_reset_skeleton_trs(state);`];
            }
            if (context.expressionMatchesShape(call.expression, "applyOverridesToTRS")) {
                context.assertExpressionShape(call, call.arguments.length === 3
                    ? "applyOverridesToTRS(overrides, currentTRS, numNodes)" : "applyOverridesToTRS(overrides, currentTRS, numNodes, true)", "Eager override inputs");
                return [`${indent}apply_overrides(state.currentTRS, static_cast<double>(state.nodes.size()), ${call.arguments.length === 4});`];
            }
            if (context.expressionMatchesShape(call.expression, "computeNodeWorldMatrices")) {
                context.assertExpressionShape(call, "computeNodeWorldMatrices(nodes, numNodes, topoOrder, currentTRS, localMat, worldMat, worldOverrides)", "Eager world composition inputs");
                return [`${indent}gltf_compute_skeleton_worlds(state, world_override_for, compose_matrix, multiply_matrix);`];
            }
            if (context.expressionMatchesShape(call.expression, "writeBoneTextures")) {
                context.assertExpressionShape(call, "writeBoneTextures(device, allBindings, worldMat)", "Eager palette inputs");
                return [`${indent}gltf_write_skeleton_bones(state, multiply_matrix, upload_bones);`];
            }
            return undefined;
        },
    });
    const allocation = (name: string): string => {
        const initializer = context.variableInitializer(build.declaration, name);
        if (!ts.isNewExpression(initializer) || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== "F32" || initializer.arguments?.length !== 1)
            context.contractError(initializer, "Expected eager float scratch allocation.");
        return lowerPinnedBody(build.file, [ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(
            ts.factory.createIdentifier("size"), ts.SyntaxKind.EqualsToken, initializer.arguments[0]!))], {
            bindings: new Map([
                ["size", {cpp: "size", type: "scalar"}], ["numNodes", {cpp: "static_cast<double>(state.nodes.size())", type: "scalar"}],
                ["TRS_STRIDE", bindings.get("TRS_STRIDE")!],
            ]), calls: new Map(),
        }).trim();
    };
    const root = context.moduleScopeConstant(file, "RH_TO_LH");
    if (!root || !ts.isNewExpression(root) || root.arguments?.length !== 1 || !ts.isArrayLiteralExpression(root.arguments[0]!))
        context.contractError(file, "Expected the eager handedness matrix.");
    const rootValues = root.arguments[0].elements.map(node => context.floatLiteral(context.numericValue(node as ts.Expression, file)));
    return `// ${context.provenance(module, "computeTopoOrder")}
template<class State> std::vector<double> gltf_skeleton_topological_order(State& state) {
${lower("computeTopoOrder")}
}
template<class State> void gltf_initialize_skeleton_pose(State& state) {
    state.topo_order = gltf_skeleton_topological_order(state);
    double size;
    ${allocation("currentTRS")} state.currentTRS.resize(static_cast<std::size_t>(size));
    ${allocation("localMat")} state.localMat.resize(static_cast<std::size_t>(size));
    ${allocation("worldMat")} state.worldMat.resize(static_cast<std::size_t>(size));
    state.RH_TO_LH = {${rootValues.join(", ")}};
}
// ${context.provenance(module, "resetTRS")}
template<class State> void gltf_reset_skeleton_trs(State& state) {
${lower("resetTRS")}
}
// ${context.provenance(module, "computeNodeWorldMatrices")}
template<class State, class WorldOverride, class Compose, class Multiply>
void gltf_compute_skeleton_worlds(State& state, WorldOverride world_override_for, Compose compose_matrix, Multiply multiply_matrix) {
${lower("computeNodeWorldMatrices")}
}
// ${context.provenance(module, "writeBoneTextures")}
template<class State, class Multiply, class Upload>
void gltf_write_skeleton_bones(State& state, Multiply multiply_matrix, Upload upload_bones) {
${lower("writeBoneTextures")}
}
// ${context.provenance("src/skeleton/bone-control.ts", "buildSkeletons")}
template<class State, class WorldOverride, class Overrides, class Compose, class Multiply, class Upload>
void gltf_bake_skeleton_pose(State& state, double override_count, WorldOverride world_override_for,
    Overrides apply_overrides, Compose compose_matrix, Multiply multiply_matrix, Upload upload_bones) {
${bakeBody}
}
`;
}
