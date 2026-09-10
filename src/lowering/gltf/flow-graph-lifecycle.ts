import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";
import type {PinnedBinding, PinnedNumericLowerer} from "../pinned-numeric-lowerer.js";

const featureModule = "src/loader-gltf/gltf-feature-interactivity.ts";
const sceneModule = "src/flow-graph/scene-flow-graph.ts";
const cleanupModule = "src/loader-gltf/gltf-scene-cleanup.ts";

/** Callback storage and the documented synchronous graph-construction boundary. */
export function lowerGltfFlowGraphLifecycle(context: LoweringContext): string {
    const cleanup = context.functionDeclaration(cleanupModule, "_registerAssetContainerSceneCleanup");
    const cleanupBindings = new Map<string, PinnedBinding>([
        ["previous", {cpp: "previous", type: "opaque", absentCpp: "!previous"}],
        ["cleanup", {cpp: "cleanup", type: "opaque"}],
        ["combined", {cpp: "combined", type: "opaque"}],
    ]);
    const cleanupBody = lowerPinnedBody(cleanup.file, cleanup.declaration.body!.statements, {
        bindings: cleanupBindings, calls: new Map([["previous", () => "previous()"], ["cleanup", () => "cleanup()"]]),
        statement(statement, lowerer, indent) {
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                if (variable.name.text === "cleanups") {
                    context.assertExpressionShape(variable.initializer, "container._sceneCleanups ??= new WeakMap()", "Asset scene cleanup storage");
                    return [`${indent}auto& cleanups = container.scene_cleanups;`];
                }
                if (variable.name.text === "previous") {
                    context.assertExpressionShape(variable.initializer, "cleanups.get(scene)", "Asset scene cleanup lookup");
                    return [`${indent}const auto found = cleanups.find(scene.state);`,
                        `${indent}const auto previous = found == cleanups.end() ? js::Callback<void()>{} : found->second;`];
                }
                if (variable.name.text === "combined") {
                    const value = context.unwrapExpression(variable.initializer);
                    if (!ts.isConditionalExpression(value) || !ts.isArrowFunction(value.whenTrue) ||
                        !ts.isBlock(value.whenTrue.body) || value.whenTrue.parameters.length)
                        context.contractError(value, "Expected combined asset cleanup callbacks.");
                    return [`${indent}const js::Callback<void()> combined = ${lowerer.expression(value.condition)} ? js::Callback<void()>{[previous, cleanup] {`,
                        ...lowerer.statements(value.whenTrue.body.statements, indent + "    "),
                        `${indent}}} : ${lowerer.expression(value.whenFalse)};`];
                }
            }
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = context.unwrapExpression(statement.expression);
            if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isElementAccessExpression(expression.left)) {
                context.assertExpressionShape(expression.left, "scene._disposables[scene._disposables.indexOf(previous)]", "Asset cleanup replacement slot");
                return [`${indent}const auto slot = std::find(scene.disposables.begin(), scene.disposables.end(), previous);`,
                    `${indent}if (slot == scene.disposables.end()) throw std::runtime_error("Unrepresented detached asset cleanup replacement.");`,
                    `${indent}*slot = ${lowerer.expression(expression.right)};`];
            }
            if (ts.isCallExpression(expression) && context.expressionMatchesShape(expression.expression, "scene._disposables.push")) {
                if (expression.arguments.length !== 1) context.contractError(expression, "Expected one asset cleanup callback.");
                return [`${indent}scene.disposables.push_back(${lowerer.expression(expression.arguments[0]!)});`];
            }
            if (context.expressionMatchesShape(expression, "cleanups.set(scene, combined)"))
                return [`${indent}cleanups[scene.state] = combined;`];
            return undefined;
        },
    });

    const run = context.functionDeclaration(sceneModule, "runFlowGraphs");
    const runBindings = new Map<string, PinnedBinding>([
        ["runtimes", {cpp: "runtimes", type: "opaque"}], ["runtimes.length", {cpp: "static_cast<double>(runtimes.size())", type: "scalar"}],
        ["scene", {cpp: "scene", type: "opaque"}], ["rt", {cpp: "rt", type: "opaque"}],
    ]);
    const runBody = lowerPinnedBody(run.file, run.declaration.body!.statements, {
        bindings: runBindings, calls: new Map([
            ["attachFlowGraph", args => `attach_flow_graph(${args.join(", ")})`],
            ["detachFlowGraph", args => `detach_flow_graph(${args.join(", ")})`],
        ]),
        forOf(iterated, element) {
            return iterated === "loaded" && element === "lg" ? {range: "loaded",
                bindings: new Map([[element, {cpp: element, type: "opaque"}]])} : undefined;
        },
        returnValue: (value, lowerer) => value ? lowerer.expression(value) : "",
        expression(node, lowerer) {
            if (ts.isElementAccessExpression(node) && context.expressionMatchesShape(node.expression, "runtimes"))
                return `runtimes.at(static_cast<std::size_t>(${lowerer.expression(node.argumentExpression)}))`;
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isTryStatement(statement)) {
                if (!statement.catchClause || statement.finallyBlock) context.contractError(statement, "Expected flow runtime rollback catch.");
                return [`${indent}try {`, ...lowerer.statements(statement.tryBlock.statements, indent + "    "),
                    `${indent}} catch (...) {`, ...lowerer.statements(statement.catchClause.block.statements, indent + "    "), `${indent}}`];
            }
            if (ts.isThrowStatement(statement)) {
                context.assertExpressionShape(statement.expression, "error", "Flow runtime rollback rethrow");
                return [`${indent}throw;`];
            }
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                const name = variable.name.text;
                if (name === "caps" || name === "events") {
                    context.assertExpressionShape(variable.initializer, name === "caps" ? "sceneAnimationCaps()" : "flowGraphBus(scene)", "Admitted flow runtime wiring");
                    return [];
                }
                if (name === "runtimes") {
                    context.assertExpressionShape(variable.initializer, "[]", "Initial attached flow runtime list");
                    return [`${indent}FlowGraphRuntimes runtimes;`];
                }
                if (name === "resolveAccessor") {
                    context.assertExpressionShape(variable.initializer,
                        "lg.resolveAccessor ? (pointer: string) => lg.resolveAccessor!(pointer, scene, animations) : undefined", "Static flow accessor factory");
                    return [];
                }
                if (name === "rt") {
                    context.assertExpressionShape(variable.initializer,
                        "await createFgRuntime(lg.graph, { accessors: { ...lg.accessors }, resolveAccessor, animations, caps, events, _assetScope: lg._assetScope }, { rightHanded: lg.rightHanded ?? true })",
                        "Admitted source flow runtime construction");
                    return [`${indent}const auto rt = lg(*scene.engine, asset);`];
                }
            }
            if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
                context.expressionMatchesShape(statement.expression.expression, "runtimes.push")) {
                if (statement.expression.arguments.length !== 1) context.contractError(statement, "Expected one attached flow runtime.");
                return [`${indent}runtimes.push_back(${lowerer.expression(statement.expression.arguments[0]!)});`];
            }
            return undefined;
        },
    });

    const feature = context.methodDeclaration(featureModule, "feature.applyAsset");
    const setups = context.findNodes(feature.declaration, (node): node is ts.MethodDeclaration =>
        ts.isMethodDeclaration(node) && context.propertyName(node.name) === "_sceneSetup");
    if (setups.length !== 1 || !setups[0]!.body) context.contractError(feature.declaration, "Expected one flow-graph asset setup.");
    const setupBindings = new Map<string, PinnedBinding>([
        ["removed", {cpp: "state->removed", type: "bool"}], ["active", {cpp: "state->active", type: "opaque"}],
        ["loaded", {cpp: "loaded", type: "opaque"}], ["runtime", {cpp: "runtime", type: "opaque"}],
        ["container.flowGraphRuntimes", {cpp: "scene.engine->assets.at(asset.value).flow_graph_runtimes", type: "opaque"}],
        ["runtimes", {cpp: "runtimes", type: "opaque"}], ["scene", {cpp: "scene", type: "opaque"}],
    ]);
    const forEach = (call: ts.CallExpression, lowerer: PinnedNumericLowerer, indent: string): string[] | undefined => {
        if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "forEach") return undefined;
        const callback = call.arguments[0];
        if (call.arguments.length !== 1 || !callback || !ts.isArrowFunction(callback) || callback.parameters.length !== 1 ||
            callback.parameters[0]!.name.getText(feature.file) !== "runtime") context.contractError(call, "Expected flow runtime cleanup iteration.");
        const body = ts.isBlock(callback.body) ? callback.body.statements : [ts.factory.createExpressionStatement(callback.body)];
        return [`${indent}for (const auto& runtime : ${lowerer.expression(call.expression.expression)}) {`,
            ...lowerer.statements(body, indent + "    "), `${indent}}`];
    };
    const setupBody = lowerPinnedBody(feature.file, setups[0]!.body!.statements, {
        bindings: setupBindings, calls: new Map([["detachFlowGraph", args => `detach_flow_graph(${args.join(", ")})`]]),
        statement(statement, lowerer, indent) {
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                if (variable.name.text === "removed") return [`${indent}state->removed = ${lowerer.expression(variable.initializer)};`];
                if (variable.name.text === "active") {
                    context.assertExpressionShape(variable.initializer, "[]", "Initial flow attachment ownership");
                    return [`${indent}state->active.clear();`];
                }
                if (variable.name.text === "runtimes") {
                    context.assertExpressionShape(variable.initializer, "runFlowGraphs(scene, flowGraphs, container.animationGroups)", "Flow attachment construction boundary");
                    // The first await in runFlowGraphs suspends attachment until
                    // after this setup registers cleanup. Native drains that work
                    // at the fulfilled continuation before addToScene returns.
                    return [`${indent}const auto runtimes = [&] { return run_flow_graphs(scene, asset, factories); };`];
                }
            }
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = context.unwrapExpression(statement.expression);
            if (ts.isBinaryExpression(expression) && context.expressionMatchesShape(expression.left, "container.flowGraphRuntimes")) {
                context.assertExpressionShape(expression.right, "runtimes", "Flow runtime publication identity");
                return [`${indent}published = &scene.engine->assets.at(asset.value).flow_graph_runtimes;`];
            }
            if (ts.isBinaryExpression(expression) && context.expressionMatchesShape(expression.left, "active") &&
                context.expressionMatchesShape(expression.right, "[]")) return [`${indent}state->active.clear();`];
            const call = ts.isVoidExpression(expression) ? context.unwrapExpression(expression.expression) : expression;
            if (!ts.isCallExpression(call)) return undefined;
            const iteration = forEach(call, lowerer, indent);
            if (iteration) return iteration;
            if (context.expressionMatchesShape(call.expression, "_registerAssetContainerSceneCleanup")) {
                const callback = call.arguments[2];
                if (call.arguments.length !== 3 || !callback || !ts.isArrowFunction(callback) || callback.parameters.length || !ts.isBlock(callback.body))
                    context.contractError(call, "Expected flow attachment cleanup callback.");
                context.assertExpressionShape(call.arguments[0]!, "container", "Flow cleanup asset");
                context.assertExpressionShape(call.arguments[1]!, "scene", "Flow cleanup scene");
                return [`${indent}register_flow_asset_cleanup(scene.engine->assets.at(asset.value), scene, [state, weak = std::weak_ptr<SceneState>(scene.state)] {`,
                    `${indent}    const auto shared = weak.lock(); if (!shared) return;`, `${indent}    Scene scene = Scene::from_state(shared);`,
                    ...lowerer.statements(callback.body.statements, indent + "    "), `${indent}});`];
            }
            if (context.expressionMatchesShape(call.expression, "runtimes.then")) {
                const fulfilled = call.arguments[0], rejected = call.arguments[1];
                if (call.arguments.length !== 2 || !fulfilled || !ts.isArrowFunction(fulfilled) || fulfilled.parameters.length !== 1 ||
                    fulfilled.parameters[0]!.name.getText(feature.file) !== "loaded" || !ts.isBlock(fulfilled.body) || !rejected)
                    context.contractError(call, "Expected resolved flow runtime continuation.");
                context.assertExpressionShape(rejected, "() => undefined", "Unsupported pending flow-runtime rejection");
                return [`${indent}{`, `${indent}    const auto loaded = runtimes();`,
                    `${indent}    if (published) *published = loaded;`,
                    ...lowerer.statements(fulfilled.body.statements, indent + "    "), `${indent}}`];
            }
            return undefined;
        },
    });
    return `using FlowGraphRuntimes = std::vector<std::shared_ptr<FlowGraphRuntime>>;
using FlowGraphFactory = std::shared_ptr<FlowGraphRuntime> (*)(Engine&, AssetHandle);
struct FlowGraphAttachmentState { bool removed = false; FlowGraphRuntimes active; };
// ${context.provenance(cleanupModule, "_registerAssetContainerSceneCleanup")}
void register_flow_asset_cleanup(AssetRecord& container, Scene& scene, js::Callback<void()> cleanup) {
${cleanupBody}
}

// ${context.provenance(sceneModule, "runFlowGraphs")}
FlowGraphRuntimes run_flow_graphs(Scene& scene, AssetHandle asset, const std::vector<FlowGraphFactory>& loaded) {
${runBody}
}
// ${context.provenance(featureModule, "feature")}
void setup_flow_graphs(Scene& scene, AssetHandle asset, const std::vector<FlowGraphFactory>& factories) {
    const auto state = std::make_shared<FlowGraphAttachmentState>();
    FlowGraphRuntimes* published = nullptr;
${setupBody}
}
`;
}

/** Collection mutation and disposal order are the scene module's own bodies. */
export function lowerFlowGraphMembership(context: LoweringContext): string {
    const bindings = new Map<string, PinnedBinding>([
        ["scene", {cpp: "scene", type: "opaque"}], ["rt", {cpp: "rt", type: "opaque"}],
        ["list", {cpp: "list", type: "opaque", absentCpp: "false", staticBoolean: true}],
        ["list?.length", {cpp: "list.size()", type: "scalar"}],
        ["scene._flowGraphTick", {cpp: "scene.state->flow_graph_tick", type: "opaque", absentCpp: "!scene.state->flow_graph_tick"}],
        ["scene._flowGraphDispose", {cpp: "scene.state->flow_graph_dispose", type: "opaque", absentCpp: "!scene.state->flow_graph_dispose"}],
        ["scene._flowGraphBus", {cpp: "nullptr", type: "opaque", staticallyAbsent: true}],
        ["tick", {cpp: "tick", type: "opaque", absentCpp: "!tick"}],
        ["dispose", {cpp: "dispose", type: "opaque", absentCpp: "!dispose"}],
    ]);
    const lower = (name: string) => {
        const {file, declaration} = context.functionDeclaration(sceneModule, name);
        const localBindings = new Map(bindings);
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings: localBindings, calls: new Map([
                ["ensureFlowGraphCoordinator", () => "ensure_flow_graph_coordinator(scene)"],
                ["removeFlowGraphCoordinator", () => "remove_flow_graph_coordinator(scene)"],
                ["disposeFlowGraph", (args: readonly string[]) => `${args[0]}->dispose()`],
            ]),
            expression(node) {
                if (node.kind === ts.SyntaxKind.Identifier && node.getText(file) === "undefined") return "{}";
                return undefined;
            },
            statement(statement, lowerer, indent) {
                if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                    const variable = statement.declarationList.declarations[0]!;
                    if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                    if (variable.name.text === "list") {
                        context.assertExpressionShape(variable.initializer, "scene._flowGraphs", "Scene flow runtime membership");
                        return [`${indent}auto& list = scene.state->flow_graphs;`];
                    }
                    if (variable.name.text === "tick" || variable.name.text === "dispose")
                        return [`${indent}const auto ${variable.name.text} = ${lowerer.expression(variable.initializer)};`];
                    const value = context.unwrapExpression(variable.initializer);
                    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === "indexOf") {
                        if (value.arguments.length !== 1) context.contractError(value, "Expected one flow registration lookup.");
                        const target = value.expression.expression.getText(file);
                        const collection = target === "list" ? "list" : target === "scene._beforeRender" ? "scene.before_render"
                            : target === "scene._disposables" ? "scene.disposables" : undefined;
                        if (!collection) context.contractError(value, "Unrepresented flow registration collection.");
                        const name = variable.name.text;
                        // The source returns -1 for an absent callback/runtime.
                        localBindings.set(name, {cpp: name, type: "index"});
                        return [`${indent}const auto found = std::find(${collection}.begin(), ${collection}.end(), ${lowerer.expression(value.arguments[0]!)});`,
                            `${indent}const std::ptrdiff_t ${name} = found == ${collection}.end() ? -1 : found - ${collection}.begin();`];
                    }
                }
                if (!ts.isExpressionStatement(statement)) return undefined;
                const expression = context.unwrapExpression(statement.expression);
                if (context.expressionMatchesShape(expression, "scene._flowGraphPointerRefresh?.()"))
                    return [`${indent}if (scene.state->flow_graph_pointer_refresh) refresh_flow_graph_pointer_picking(scene);`];
                if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return undefined;
                const target = expression.expression.expression.getText(file), method = expression.expression.name.text;
                if (target === "list" && method === "push" && expression.arguments.length === 1)
                    return [`${indent}list.push_back(${lowerer.expression(expression.arguments[0]!)});`];
                if (method === "splice" && expression.arguments.length === 2) {
                    const collection = target === "list" ? "list" : target === "scene._beforeRender" ? "scene.before_render"
                        : target === "scene._disposables" ? "scene.disposables" : undefined;
                    if (!collection) return undefined;
                    context.assertExpressionShape(expression.arguments[1]!, "1", "Flow registration removal length");
                    const index = lowerer.expression(expression.arguments[0]!);
                    return [`${indent}${collection}.erase(${collection}.begin() + ${index}, ${collection}.begin() + ${index} + 1);`];
                }
                return undefined;
            },
        });
    };
    return `void ensure_flow_graph_coordinator(Scene& scene);
void refresh_flow_graph_pointer_picking(Scene& scene);
// ${context.provenance(sceneModule, "removeFlowGraphCoordinator")}
void remove_flow_graph_coordinator(Scene& scene) {
${lower("removeFlowGraphCoordinator")}
}

// ${context.provenance(sceneModule, "attachFlowGraph")}
void attach_flow_graph(Scene& scene, const std::shared_ptr<FlowGraphRuntime>& rt) {
${lower("attachFlowGraph")}
}
// ${context.provenance(sceneModule, "detachFlowGraph")}
void detach_flow_graph(Scene& scene, const std::shared_ptr<FlowGraphRuntime>& rt) {
${lower("detachFlowGraph")}
}
`;
}

/** Static connection slots replace the runtime dictionary; no admitted block queues work. */
export function lowerFlowGraphDisposal(context: LoweringContext, slots: readonly string[]): string {
    const {file, declaration} = context.functionDeclaration("src/flow-graph/runtime.ts", "disposeFlowGraph");
    return lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map([["rt.started", {cpp: "started", type: "bool"}]]),
        calls: new Map(),
        statement(statement, _lowerer, indent) {
            if (ts.isVariableStatement(statement)) {
                const variable = statement.declarationList.declarations[0];
                if (statement.declarationList.declarations.length !== 1 || !variable?.initializer) return undefined;
                if (ts.isObjectBindingPattern(variable.name)) {
                    context.assertExpressionShape(variable.initializer, "rt", "Flow disposal context");
                    if (variable.name.getText(file).replace(/\s/g, "") !== "{context:ctx,env}")
                        context.contractError(variable, "Unrepresented flow disposal context binding.");
                    return [];
                }
                if (ts.isIdentifier(variable.name) && variable.name.text === "visited") {
                    context.assertExpressionShape(variable.initializer, "new Set<string>()", "Empty pending-task disposal");
                    return [];
                }
            }
            if (ts.isForOfStatement(statement)) {
                if (context.expressionMatchesShape(statement.expression, "rt._unsub") ||
                    context.expressionMatchesShape(statement.expression, "ctx.pending") ||
                    context.expressionMatchesShape(statement.expression, "Object.keys(ctx.executionVariables)")) return [];
                if (context.expressionMatchesShape(statement.expression, "Object.keys(ctx.connectionValues)")) {
                    context.assertStatementShapes(statement, [statement.statement], "{ delete ctx.connectionValues[key]; }", "Static flow connection cleanup");
                    return slots.map(member => `${indent}state.${member} = {};`);
                }
            }
            if (ts.isExpressionStatement(statement) &&
                (context.expressionMatchesShape(statement.expression, "rt._unsub.length = 0") ||
                context.expressionMatchesShape(statement.expression, "ctx.pending.length = 0"))) return [];
            return undefined;
        },
    });
}
