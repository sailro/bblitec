import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";
import type {PinnedBinding, PinnedNumericLowerer} from "../pinned-numeric-lowerer.js";
import {pinnedNumericMathCalls, pinnedRemainderCall} from "../pinned-operators.js";

const groupModule = "src/animation/animation-group.ts";
const controllerModule = "src/skeleton/skeleton-updater.ts";
const mixerModule = "src/animation/weighted-gltf-mixer.ts";

function remainderStore(statement: ts.Statement, lowerer: PinnedNumericLowerer, indent: string): string[] | undefined {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) ||
        statement.expression.operatorToken.kind !== ts.SyntaxKind.PercentEqualsToken) return undefined;
    const target = lowerer.expression(statement.expression.left);
    return [`${indent}${target} = ${pinnedRemainderCall(target, lowerer.expression(statement.expression.right))};`];
}

/** Playback state/control flow; the caller supplies the source pose/writeback boundary. */
export function lowerGltfAnimationPlayback(context: LoweringContext, weighted = false): string {
    const controller = context.functionDeclaration(controllerModule, "createAnimationController");
    const value = context.unwrapExpression(context.variableInitializer(controller.declaration, "ctrl"));
    if (!ts.isObjectLiteralExpression(value)) context.contractError(value, "Expected animation controller state.");
    const fields = new Map(value.properties.filter(ts.isPropertyAssignment).map(property => [context.propertyName(property.name), property]));
    const selectedTick = fields.get("tick")?.initializer;
    if (!selectedTick || !ts.isConditionalExpression(selectedTick) || !ts.isArrowFunction(selectedTick.whenFalse) || !ts.isBlock(selectedTick.whenFalse.body))
        context.contractError(value, "Expected source animation controller tick selection.");
    context.assertExpressionShape(selectedTick.whenTrue, "noopAnimationTick", "Zero-duration controller tick");
    const noop = context.functionDeclaration(controllerModule, "noopAnimationTick");
    context.assertFunctionBodyShape(noop.declaration, "{}", "Zero-duration controller specialization");
    context.assertExpressionShape(context.variableInitializer(controller.declaration, "uploadGpu"), "true", "Initial animation upload state");
    const cache = context.findNodes(controller.declaration, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) && node.name.text === "cachedEngine");
    if (cache.length !== 1 || cache[0]!.initializer) context.contractError(controller.declaration, "Expected initially absent animation engine cache.");
    const statements = selectedTick.whenFalse.body.statements;
    const end = statements.findIndex(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(variable =>
        ts.isIdentifier(variable.name) && variable.name.text === "t"));
    if (end < 0) context.contractError(selectedTick, "Expected controller pose-time boundary.");
    const bindings = (): Map<string, PinnedBinding> => new Map([
        ["group", {cpp: "group", type: "opaque"}],
        ["group.currentTime", {cpp: "group.time", type: "scalar"}],
        ["group.isPlaying", {cpp: "group.playing", type: "bool"}],
        ["group._stopped", {cpp: "group.stopped", type: "bool"}],
        ["group.loopAnimation", {cpp: "group.loop", type: "bool"}],
        ["group.speedRatio", {cpp: "speed_ratio", type: "scalar"}],
        ["group.frameRate", {cpp: "frame_rate", type: "scalar"}],
        ["group._animationManager", {cpp: "manager_owned", type: "bool"}],
        ["group._gltfMixer", {cpp: "true", type: "bool", staticBoolean: true}],
        ["group._ctrl", {cpp: "ctrl", type: "opaque", staticBoolean: true}],
        ["group._ctrl.time", {cpp: "ctrl.time", type: "scalar"}],
        ["ctrl", {cpp: "ctrl", type: "opaque", staticBoolean: true}],
        ["ctrl.time", {cpp: "ctrl.time", type: "scalar"}],
        ["ctrl.playing", {cpp: "ctrl.playing", type: "bool"}],
        ["ctrl.speedRatio", {cpp: "ctrl.speed_ratio", type: "scalar"}],
        ["ctrl.loop", {cpp: "ctrl.loop", type: "bool"}],
        ["clip", {cpp: "group", type: "opaque"}],
        ["clip.duration", {cpp: "group.duration", type: "scalar"}],
        ["deltaMs", {cpp: "delta_ms", type: "scalar"}],
        ["frame", {cpp: "frame", type: "scalar"}],
        ["engine", {cpp: "engine", type: "bool", absentCpp: "!engine"}],
        ["cachedEngine", {cpp: "ctrl.cached_engine", type: "bool", absentCpp: "!ctrl.cached_engine"}],
        ["activeEngine", {cpp: "active_engine", type: "bool"}],
        ["requiresEngine", {cpp: "requires_engine", type: "bool"}],
        ["uploadGpu", {cpp: "upload_gpu", type: "bool"}],
    ]);
    const controllerScope = {
        bindings: bindings(), calls: pinnedNumericMathCalls(), booleanOr: true, booleanAnd: true,
        expression(node: ts.Expression, lowerer: PinnedNumericLowerer) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
                context.assertExpressionShape(node.left, "engine", "Optional animation engine identity");
                return `(engine ? engine : ${lowerer.expression(node.right)})`;
            }
            return undefined;
        },
        statement(statement: ts.Statement, lowerer: PinnedNumericLowerer, indent: string) {
            const remainder = remainderStore(statement, lowerer, indent);
            if (remainder) return remainder;
            if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
            const variable = statement.declarationList.declarations[0]!;
            if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
            if (variable.name.text === "activeEngine") return [`${indent}const bool active_engine = ${lowerer.expression(variable.initializer)};`];
            if (variable.name.text === "device") {
                context.assertExpressionShape(variable.initializer, "requiresEngine && uploadGpu ? activeEngine!._device : null", "Animation device transport");
                return [];
            }
            return undefined;
        },
    };
    const skip = lowerPinnedBody(controller.file, [ts.factory.createIfStatement(selectedTick.condition,
        ts.factory.createReturnStatement())], controllerScope);
    const advance = lowerPinnedBody(controller.file, statements.slice(0, end + 1), controllerScope);
    const state = [["time", "double", "time"], ["playing", "bool", "playing"],
        ["speedRatio", "double", "speed_ratio"], ["loop", "bool", "loop"]].map(([field, type, cpp]) => {
        const initializer = fields.get(field!)?.initializer;
        if (!initializer) context.contractError(value, `Expected controller ${field} initializer.`);
        const initial = type === "bool" ? initializer.kind === ts.SyntaxKind.TrueKeyword ? "true"
            : initializer.kind === ts.SyntaxKind.FalseKeyword ? "false" : undefined
            : context.doubleLiteral(context.numericValue(initializer, controller.file));
        if (initial === undefined) context.contractError(initializer, "Expected a static controller state initializer.");
        return `    ${type} ${cpp} = ${initial};`;
    }).join("\n");
    const groupBody = (name: string): string => {
        const {file, declaration} = context.functionDeclaration(groupModule, name);
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings: bindings(), booleanOr: true, booleanAnd: true,
            expression(node, lowerer) {
                if (ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "syncControllerFromGroup")) {
                    context.assertExpressionShape(node, name === "goToFrame" ? "syncControllerFromGroup(group, ctrl)"
                        : "syncControllerFromGroup(group, group._ctrl)", "Playback controller synchronization identity");
                }
                if (ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "tickAnimationCore")) {
                    if (node.arguments.length < 2 || node.arguments.length > 3)
                        context.contractError(node, "Changed playback core arguments.");
                    context.assertExpressionShape(node.arguments[0]!, "group", "Playback core group identity");
                }
                if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
                    context.expressionMatchesShape(node.left, "group.frameRate"))
                    return `bbl::js::or_number(${lowerer.expression(node.left)}, ${lowerer.expression(node.right)})`;
                return undefined;
            },
            calls: new Map([
                ...pinnedNumericMathCalls(),
                ["syncControllerFromGroup", () => "gltf_sync_animation_controller(group, ctrl, speed_ratio, sync_mask)"],
                ["group._ctrl.tick", (args: readonly string[]) => `gltf_tick_animation_controller(group, ctrl, ${args[0]}, ${args[1] ?? "false"}, requires_engine, upload_gpu, pose)`],
                ["ctrl.tick", (args: readonly string[]) => `gltf_tick_animation_controller(group, ctrl, ${args[0]}, ${args[1] ?? "false"}, requires_engine, upload_gpu, pose)`],
                ["tickAnimationCore", (args: readonly string[]) => `gltf_tick_animation_core(group, ${args[1]}, speed_ratio, ${args[2] ?? "false"}, requires_engine, upload_gpu, sync_mask, pose)`],
            ]),
            statement(statement, _lowerer, indent) {
                if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                    const variable = statement.declarationList.declarations[0]!;
                    if (ts.isIdentifier(variable.name) && variable.name.text === "ctrl" && variable.initializer) {
                        context.assertExpressionShape(variable.initializer, "group._ctrl", "Animation controller identity");
                        return [];
                    }
                }
                if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
                    context.expressionMatchesShape(statement.expression.expression, "ctrl._setMask")) {
                    context.assertExpressionShape(statement.expression, "ctrl._setMask?.(group.mask ?? null)", "Animation mask synchronization boundary");
                    return [`${indent}sync_mask();`];
                }
                return undefined;
            },
        });
    };
    // Factory-created glTF groups always carry both their controller and mixer.
    const factory = context.functionDeclaration(groupModule, "createAnimationGroups");
    const groupValue = context.unwrapExpression(context.variableInitializer(factory.declaration, "group"));
    if (!ts.isObjectLiteralExpression(groupValue)) context.contractError(groupValue, "Expected source glTF animation group.");
    const ctrlProperty = groupValue.properties.find(property => ts.isPropertyAssignment(property) && context.propertyName(property.name) === "_ctrl");
    if (!ctrlProperty || !ts.isPropertyAssignment(ctrlProperty)) context.contractError(groupValue, "Expected the glTF group controller.");
    context.assertExpressionShape(ctrlProperty.initializer, "ctrl", "Factory controller identity");
    const mixerAssignment = context.findNodes(factory.declaration, (node): node is ts.BinaryExpression => ts.isBinaryExpression(node) &&
        context.expressionMatchesShape(node.left, "group._gltfMixer"));
    if (mixerAssignment.length !== 1) context.contractError(factory.declaration, "Expected source glTF group mixer publication.");
    context.assertExpressionShape(mixerAssignment[0]!.right, "[clip, nodes, skeletons]", "Factory mixer identity");
    const weightedBody = weighted ? (() => {
        const {file, declaration} = context.functionDeclaration(mixerModule, "advanceGroupTime");
        if (context.numericValue(ts.factory.createIdentifier("GLTF_CLIP"), file) !== 0)
            context.contractError(file, "Weighted playback clip tuple identity changed.");
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings: bindings(), calls: pinnedNumericMathCalls(), booleanOr: true, booleanAnd: true,
            statement(statement, lowerer, indent) {
                const remainder = remainderStore(statement, lowerer, indent);
                if (remainder) return remainder;
                if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || variable.name.text !== "clip" || !variable.initializer) return undefined;
                context.assertExpressionShape(variable.initializer, "mixer[GLTF_CLIP]", "Weighted animation clip identity");
                return [];
            },
            returnValue: (expression, lowerer) => lowerer.expression(expression!),
        });
    })() : undefined;
    return `struct GltfAnimationControllerPlayback {
${state}
    bool cached_engine = false;
};
// ${context.provenance(controllerModule, "createAnimationController")}
template<class Group, class Pose>
void gltf_tick_animation_controller(const Group& group, GltfAnimationControllerPlayback& ctrl,
    double delta_ms, bool engine, bool requires_engine, bool upload_gpu, Pose pose) {
${skip}
${advance}
    pose(t, active_engine);
}
// ${context.provenance(groupModule, "syncControllerFromGroup")}
template<class Group, class SyncMask>
void gltf_sync_animation_controller(const Group& group, GltfAnimationControllerPlayback& ctrl,
    double speed_ratio, SyncMask sync_mask) {
${groupBody("syncControllerFromGroup")}
}
// ${context.provenance(groupModule, "tickAnimationCore")}
template<class Group, class SyncMask, class Pose>
void gltf_tick_animation_core(Group& group, double delta_ms, double speed_ratio,
    bool engine, bool requires_engine, bool upload_gpu, SyncMask sync_mask, Pose pose) {
    auto& ctrl = group.controller;
${groupBody("tickAnimationCore")}
}
// ${context.provenance(groupModule, "tickAnimationImpl")}
template<class Group, class SyncMask, class Pose>
void gltf_tick_animation(Group& group, double delta_ms, double speed_ratio, bool manager_owned,
    bool engine, bool requires_engine, bool upload_gpu, SyncMask sync_mask, Pose pose) {
${groupBody("tickAnimationImpl")}
}
// ${context.provenance(groupModule, "goToFrame")}
template<class Group, class SyncMask, class Pose>
void gltf_animation_go_to_frame(Group& group, double frame, double frame_rate, double speed_ratio,
    bool engine, bool requires_engine, bool upload_gpu, SyncMask sync_mask, Pose pose) {
    auto& ctrl = group.controller;
${groupBody("goToFrame")}
}
${weightedBody === undefined ? "" : `// ${context.provenance(mixerModule, "advanceGroupTime")}
template<class Group>
double gltf_advance_weighted_animation(Group& group, double delta_ms, double speed_ratio) {
${weightedBody}
}`}`;
}
