import ts from "typescript";
import type {LoweringContext} from "./context.js";
import {lowerPinnedBody} from "./pinned-body-lowerer.js";
import type {PinnedBinding} from "./pinned-numeric-lowerer.js";

import {lowerMaterialPublication, materialPublicationTransport} from "./material-publication.js";

const sceneModule = "src/scene/scene-core.ts";

/** Source builder identities own membership; the backend owns draw construction. */
export function lowerPbrMaterialGroups(context: LoweringContext): string {
    const {file, declaration} = context.functionDeclaration(sceneModule, "addToScene");
    const initializer = context.variableInitializer(declaration, "build");
    const statement = initializer.parent.parent.parent;
    if (!ts.isVariableStatement(statement) || !ts.isBlock(statement.parent))
        context.contractError(initializer, "Expected the mesh material-group selection.");
    const next = statement.parent.statements[statement.parent.statements.indexOf(statement) + 1];
    if (!next || !ts.isIfStatement(next)) context.contractError(statement, "Expected the material-group attachment guard.");
    const bindings = new Map<string, PinnedBinding>([
        ["mesh", {cpp: "mesh", type: "opaque"}],
        ["mesh.material", {cpp: "material", type: "opaque", absentCpp: "!material"}],
        ["mesh.material._buildGroup", {cpp: "source_material_group_key(*material)", type: "scalar"}],
        ["build", {cpp: "build", type: "scalar"}],
        ["group", {cpp: "group", type: "opaque", absentCpp: "!group"}],
        ["group.r", {cpp: "group->rebuild_ready", type: "bool"}],
        ["ctx._built", {cpp: "scene.state->material_groups_built", type: "bool"}],
    ]);
    const deferred = (call: ts.CallExpression, indent: string): string[] => {
        const callback = call.arguments[0];
        if (call.arguments.length !== 1 || !callback || !ts.isArrowFunction(callback) ||
            callback.parameters.length || !ts.isBlock(callback.body))
            context.contractError(call, "Expected the deferred material-group builder.");
        const body = lowerPinnedBody(file, callback.body.statements, {
            bindings, calls: new Map(),
            statement(node, _numeric, depth) {
                if (ts.isVariableStatement(node)) {
                    context.assertStatementShapes(node, [node], "const result = await build(ctx, group!);", "Deferred PBR group invocation");
                    return [`${depth}const auto outputs = capture_material_outputs(scene, group->meshes);`, `${depth}if (build == 1) build_pbr_material_group(scene, group->meshes);`];
                }
                if (ts.isIfStatement(node)) {
                    context.assertStatementShapes(node, [node],
                        "if (result.updater) { ctx._uniformUpdaters.push(result.updater); }", "Native PBR updater transport");
                    return [];
                }
                if (!ts.isExpressionStatement(node)) return undefined;
                if (context.expressionMatchesShape(node.expression, "ctx._renderables.push(...result.renderables)")) return [`${depth}append_material_outputs(scene, outputs);`];
                if (context.expressionMatchesShape(node.expression, "group!.o = result.renderables")) return [`${depth}group->outputs = outputs;`];
                context.assertExpressionShape(node.expression, "group!.r = result.rebuildSingle", "Completed PBR group publication");
                return [`${depth}group->rebuild_ready = true;`];
            },
        }, indent + "    ");
        // Source output identities publish after native material construction.
        return [`${indent}if (build < 4) scene.deferred_builders.emplace_back([owner = std::weak_ptr<SceneState>(scene.state), group, build] {`,
            `${indent}    const auto state = owner.lock();`, `${indent}    if (!state || state->disposed) return;`,
            `${indent}    auto scene = Scene::from_state(state);`, body,
            `${indent}}, SceneDeferredFailure::promise_rejection);`];
    };
    const body = lowerPinnedBody(file, [statement, next], {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
        expression(node) {
            if (context.expressionMatchesShape(node, "mesh.material")) return "material";
            if (context.expressionMatchesShape(node, "mesh.material._buildGroup")) return "source_material_group_key(*material)";
            if (node.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(node) && node.text === "undefined")) return "std::uint64_t{0}";
            if (context.expressionMatchesShape(node, "ctx._groups.get(build)")) return "scene_material_group(scene, build)";
            return undefined;
        },
        statement(node, lowerer, indent) {
            if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
                const variable = node.declarationList.declarations[0]!;
                if (ts.isIdentifier(variable.name) && variable.initializer && ["build", "group"].includes(variable.name.text))
                    return [`${indent}auto ${variable.name.text} = ${lowerer.expression(variable.initializer)};`];
            }
            if (!ts.isExpressionStatement(node)) return undefined;
            const expression = context.unwrapExpression(node.expression);
            if (context.expressionMatchesShape(expression, "group = []")) return [`${indent}group = std::make_shared<SourceMaterialGroupState>();`];
            if (context.expressionMatchesShape(expression, "ctx._groups.set(build, group)")) return [`${indent}store_scene_material_group(scene, build, group);`];
            if (!ts.isCallExpression(expression)) return undefined;
            if (context.expressionMatchesShape(expression.expression, "ctx._deferredBuilders.push")) return deferred(expression, indent);
            if (context.expressionMatchesShape(expression.expression, "group.push")) {
                if (expression.arguments.length !== 1) context.contractError(expression, "Expected one PBR group member.");
                return [`${indent}group->meshes.push_back(${lowerer.expression(expression.arguments[0]!)});`];
            }
            if (context.expressionMatchesShape(expression.expression, "enqueueMaterialSwap")) {
                context.assertExpressionShape(expression, "enqueueMaterialSwap(ctx, mesh)", "PBR late-add queue");
                return [`${indent}enqueue_pbr_material_swap(scene, mesh);`];
            }
            return undefined;
        },
    });
    const registry = context.functionDeclaration("src/scene/mesh-scene-registry.ts", "enqueueMaterialSwap");
    const enqueue = lowerPinnedBody(registry.file, registry.declaration.body!.statements, {
        bindings: new Map([["mesh", {cpp: "mesh", type: "opaque"}]]),
        calls: new Map([
            ["scene._materialSwapQueue.includes", args => `pbr_mesh_list_contains(scene.state->pbr_material_swap_queue, ${args.join(", ")})`],
            ["scene._materialSwapQueue.push", args => `scene.state->pbr_material_swap_queue.push_back(${args.join(", ")})`],
        ]),
        returnValue: expression => {
            if (expression) context.contractError(expression, "Expected a void material queue return.");
            return "";
        },
    });
    const buildScene = context.functionDeclaration(sceneModule, "buildScene");
    context.assertStatementShapes(buildScene.declaration, [buildScene.declaration.body!.statements.at(-1)!],
        "await ctx._rebuildHook?.(ctx);", "Scene build rearmed group hook");
    const clear = buildScene.declaration.body!.statements.find(ts.isIfStatement);
    if (!clear) context.contractError(buildScene.declaration, "Expected the initial material swap queue reset.");
    const prepare = lowerPinnedBody(buildScene.file, [clear], {
        bindings: new Map([["ctx._built", {cpp: "scene.state->material_groups_built", type: "bool"}]]), calls: new Map(),
        statement(node, _lowerer, indent) {
            if (!ts.isExpressionStatement(node)) return undefined;
            context.assertExpressionShape(node.expression, "ctx._materialSwapQueue.length = 0", "Initial material swap queue reset");
            return [`${indent}scene.state->pbr_material_swap_queue.clear();`];
        },
    });
    const builtStore = context.findNodes(buildScene.declaration, (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        context.expressionMatchesShape(node.left, "ctx._built"));
    if (builtStore.length !== 1) context.contractError(buildScene.declaration, "Expected one completed scene build publication.");
    const finish = lowerPinnedBody(buildScene.file, [ts.factory.createExpressionStatement(builtStore[0]!)], {
        bindings: new Map([["ctx._built", {cpp: "scene.state->material_groups_built", type: "bool"}]]), calls: new Map(),
    });
    return `${lowerMaterialPublication(context)}
${materialPublicationTransport()}
// ${context.provenance(sceneModule, "addToScene")}
void process_pbr_material_swaps(Scene& scene);
bool pbr_mesh_list_contains(const std::vector<MeshHandle>& meshes, MeshHandle mesh) {
    return std::any_of(meshes.begin(), meshes.end(), [mesh](MeshHandle value) { return value.value == mesh.value; });
}
const MaterialRecord* pbr_mesh_material(const Scene& scene, MeshHandle mesh) {
    const auto material = scene.engine->meshes.at(mesh.value).material;
    return material.value < scene.engine->materials.size() ? &scene.engine->materials[material.value] : nullptr;
}
std::uint64_t source_material_group_key(const MaterialRecord& material) {
    return material.source_pbr_group_builder ? 1 : material.source_group_builder;
}
std::shared_ptr<SourceMaterialGroupState> material_group_map_get(const SourceMaterialGroups& groups, std::uint64_t builder) {
    const auto found = groups.get(builder);
    return found ? *found : nullptr;
}
std::shared_ptr<SourceMaterialGroupState> scene_material_group(const Scene& scene, std::uint64_t builder) {
    return scene.state->source_material_groups ? material_group_map_get(*scene.state->source_material_groups, builder) : nullptr;
}
void store_scene_material_group(Scene& scene, std::uint64_t builder, const std::shared_ptr<SourceMaterialGroupState>& group) {
    if (!scene.state->source_material_groups) scene.state->source_material_groups = std::make_shared<SourceMaterialGroups>();
    scene.state->source_material_groups->set(builder, group);
    if (builder == 1) scene.state->pbr_material_group = group;
}
void complete_scene_material_group(Scene& scene, MaterialHandle material) {
    const auto group = scene_material_group(scene, source_material_group_key(scene.engine->materials.at(material.value)));
    if (group) {
        const auto outputs = capture_material_outputs(scene, group->meshes);
        append_material_outputs(scene, outputs);
        group->outputs = outputs;
        group->rebuild_ready = true;
    }
}
${lowerPbrGroupBuild(context)}
void enqueue_pbr_material_swap(Scene& scene, MeshHandle mesh) {
${enqueue}
}
void queue_pbr_material_group(Scene& scene, MeshHandle mesh) {
    scene.state->process_material_groups = process_pbr_material_swaps;
    scene.state->enqueue_material_group = enqueue_pbr_material_swap;
    scene.state->complete_material_group = complete_scene_material_group;
    const auto* material = pbr_mesh_material(scene, mesh);
${body}
}
void prepare_pbr_scene_build(Scene& scene) {
${prepare}
}
void finish_pbr_scene_build(Scene& scene) {
    process_pbr_material_swaps(scene);
    drain_material_continuations(*scene.engine);
${finish}
    if (scene.state->material_group_rebuild_pending || scene.topology_rebuild_pending) rebuild_scene_renderables(scene);
}
${lowerPbrGroupUpdates(context)}
`;
}

/** Source owns scene hooks and invalidator inputs; GPU construction stays native. */
function lowerPbrGroupBuild(context: LoweringContext): string {
    const module = "src/material/pbr/pbr-renderable.ts";
    const {file, declaration} = context.functionDeclaration(module, "buildPbrRenderables");
    const gamma = context.variableInitializer(declaration, "hasGammaAlbedo").parent.parent.parent;
    const scan = declaration.body!.statements.find(statement => ts.isForStatement(statement) &&
        context.hasNode(statement, node => ts.isBinaryExpression(node) && context.expressionMatchesShape(node.left, "hasGammaAlbedo")));
    const guard = declaration.body!.statements.find(statement => ts.isIfStatement(statement) &&
        context.expressionMatchesShape(statement.expression, "!hasGammaAlbedo || !group.r"));
    if (!ts.isVariableStatement(gamma) || !scan || !ts.isForStatement(scan) || !ts.isBlock(scan.statement) || !guard)
        context.contractError(declaration, "Expected the PBR group gamma-albedo invalidator.");
    const statements = scan.statement.statements.filter(statement => ts.isVariableStatement(statement) ||
        ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
        context.expressionMatchesShape(statement.expression.left, "hasGammaAlbedo"));
    const projectedScan = ts.factory.updateForStatement(scan, scan.initializer, scan.condition, scan.incrementor,
        ts.factory.updateBlock(scan.statement, statements));
    const groupRead = context.variableInitializer(declaration, "group");
    context.assertExpressionShape(groupRead, "scene._groups.get(meshes[0]!.material!._buildGroup)!", "PBR builder group identity");
    const bindings = new Map<string, PinnedBinding>([
        ["meshes.length", {cpp: "static_cast<double>(meshes.size())", type: "scalar"}],
        ["mat._gammaAlbedo", {cpp: "mat.source_gamma_albedo", type: "bool"}],
        ["group.r", {cpp: "group->rebuild_ready", type: "bool"}],
        ["group._w", {cpp: "group->gamma_invalidates", type: "bool"}],
    ]);
    const body = lowerPinnedBody(file, [gamma, projectedScan, groupRead.parent.parent.parent as ts.VariableStatement, guard], {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
        statement(statement, lowerer, indent) {
            if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
                context.expressionMatchesShape(statement.expression.left, "hasGammaAlbedo")) {
                const expression = statement.expression;
                const operator = expression.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ? "||" :
                    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ? "&&" : undefined;
                if (!operator) context.contractError(expression, "Expected the PBR gamma-albedo fold.");
                return [`${indent}hasGammaAlbedo = hasGammaAlbedo ${operator} ${lowerer.expression(expression.right)};`];
            }
            if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
            const variable = statement.declarationList.declarations[0]!;
            if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
            if (variable.name.text === "group") return [
                `${indent}const auto* first_material = pbr_mesh_material(scene, meshes.at(0));`,
                `${indent}const auto group = first_material && first_material->source_pbr_group_builder ? scene.state->pbr_material_group : nullptr;`,
                `${indent}if (!group) throw std::runtime_error("PBR builder has no material group");`,
            ];
            if (variable.name.text === "m") {
                const read = context.unwrapExpression(variable.initializer);
                if (!ts.isElementAccessExpression(read) || !context.expressionMatchesShape(read.expression, "meshes"))
                    context.contractError(read, "Expected the gamma-albedo group mesh read.");
                return [`${indent}const auto m = meshes.at(static_cast<std::size_t>(${lowerer.expression(read.argumentExpression)}));`];
            }
            if (variable.name.text === "mat") {
                context.assertExpressionShape(variable.initializer, "m.material", "PBR group current material");
                return [`${indent}const auto& mat = scene.engine->materials.at(scene.engine->meshes.at(m.value).material.value);`];
            }
            return undefined;
        },
        expression(node) {
            if (node.kind === ts.SyntaxKind.NullKeyword) return "false";
            if (ts.isArrowFunction(node)) {
                context.assertExpressionShape(node, "(mesh) => (mesh.material as PbrMaterialProps | null)?._gammaAlbedo", "PBR gamma-albedo invalidation predicate");
                return "true";
            }
            return undefined;
        },
    });
    const result = declaration.body!.statements.at(-1);
    if (!result || !ts.isReturnStatement(result) || !result.expression || !ts.isObjectLiteralExpression(result.expression))
        context.contractError(declaration, "Expected the PBR group result.");
    context.assertExpressionShape(context.propertyInitializer(result.expression, "rebuildSingle"), "rebuildSingle", "PBR single-mesh rebuild result");
    const single = context.variableInitializer(declaration, "rebuildSingle");
    if (!ts.isArrowFunction(single)) context.contractError(single, "Expected the PBR single-mesh builder closure.");
    return `bool build_pbr_material_group(Scene& scene, const std::vector<MeshHandle>& meshes) {
${body}
    run_pbr_scene_hooks(scene, meshes);
    return hasGammaAlbedo;
}
`;
}

function lowerPbrGroupUpdates(context: LoweringContext): string {
    const swap = context.functionDeclaration("src/scene/scene-material-swap.ts", "processMaterialSwaps");
    const returned = swap.declaration.body!.statements.at(-1);
    if (!returned || !ts.isReturnStatement(returned) || !returned.expression || !ts.isCallExpression(returned.expression) ||
        !ts.isPropertyAccessExpression(returned.expression.expression) || returned.expression.expression.name.text !== "then")
        context.contractError(swap.declaration, "Expected the asynchronous first-build import continuation.");
    context.assertExpressionShape(returned.expression.expression.expression, 'import("./scene-runtime-mesh-build.js")', "First-build module boundary");
    const continuation = returned.expression.arguments[0];
    if (!continuation) context.contractError(returned, "Expected the first-build continuation.");
    context.assertExpressionShape(continuation, "({ C }) => C(scene, builds, pending)", "First-build continuation dispatch");
    const loop = swap.declaration.body!.statements.find(ts.isForOfStatement);
    if (!loop || !ts.isBlock(loop.statement)) context.contractError(swap.declaration, "Expected the material swap mesh loop.");
    const old = context.variableInitializer(loop, "old").parent.parent.parent;
    if (!ts.isVariableStatement(old)) context.contractError(loop, "Expected the material swap GPU boundary.");
    const directBuild = context.variableInitializer(loop, "built").parent.parent.parent;
    const prefix = [...loop.statement.statements.slice(0, loop.statement.statements.indexOf(old)), directBuild as ts.Statement];
    const bindings = new Map<string, PinnedBinding>([
        ["mat", {cpp: "mat", type: "opaque", absentCpp: "!mat"}],
        ["runtimeBuild", {cpp: "runtimeBuild", type: "bool"}],
        ["group", {cpp: "group", type: "opaque", absentCpp: "!group"}],
        ["rebuild", {cpp: "rebuild", type: "bool"}],
        ["q[0]", {cpp: "!queue.empty()", type: "bool"}],
        ["scene._runtimeBuilds?.w", {cpp: "false", type: "bool", staticallyAbsent: true}],
        ["firstBuilds", {cpp: "first_builds", type: "opaque", absentCpp: "first_builds.empty()"}],
    ]);
    const queueDeclaration = swap.declaration.body!.statements[0]!;
    const queueGuard = swap.declaration.body!.statements[1]!;
    const queueClear = swap.declaration.body!.statements.find(node => ts.isExpressionStatement(node) &&
        context.expressionMatchesShape(node.expression, "q.length = 0"));
    const noBuilds = swap.declaration.body!.statements.find(node => ts.isIfStatement(node) &&
        context.expressionMatchesShape(node.expression, "!firstBuilds"));
    if (!queueClear || !noBuilds) context.contractError(swap.declaration, "Expected material swap queue completion.");
    const projectedLoop = ts.factory.updateForOfStatement(loop, loop.awaitModifier, loop.initializer, loop.expression,
        ts.factory.updateBlock(loop.statement, prefix));
    const select = lowerPinnedBody(swap.file, [queueDeclaration, queueGuard, projectedLoop, queueClear, noBuilds], {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
        forOf: (iterated, element) => iterated === "q" ? {
            range: "queue", bindings: new Map([[element, {cpp: element, type: "opaque"}]]),
        } : undefined,
        returnValue: expression => {
            if (expression) context.assertExpressionShape(expression, "pending", "Native swap completion");
            return expression ? "dispatch_pbr_runtime_builds(scene, runtime_builds, {})" : "";
        },
        statement(statement, _lowerer, indent) {
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                if (statement === directBuild) return [`${indent}publish_single_material_output(scene, mesh, group);`];
                const named = new Map([
                    ["q", ["scene._materialSwapQueue", "auto& queue = scene.state->pbr_material_swap_queue;"]],
                    ["mat", ["mesh.material", "const auto* mat = pbr_mesh_material(scene, mesh);"]],
                    ["runtimeBuild", ["mesh._runtimeThinBuild", "const bool runtimeBuild = scene.engine->meshes.at(mesh.value).source_runtime_thin_builder;"]],
                    ["group", ["scene._groups.get(mat._buildGroup)", "const auto group = scene_material_group(scene, source_material_group_key(*mat));"]],
                    ["rebuild", ["group?.r", "const bool rebuild = group && group->rebuild_ready;"]],
                ]);
                const value = named.get(variable.name.text);
                if (!value) return undefined;
                context.assertExpressionShape(variable.initializer, value[0]!, "PBR material swap selection");
                return value[1] ? [`${indent}${value[1]}`] : [];
            }
            if (ts.isExpressionStatement(statement)) {
                if (context.expressionMatchesShape(statement.expression, "pending = runtimeBuild(scene, mesh, pending)"))
                    return [`${indent}runtime_builds.push_back({mesh, scene.engine->meshes.at(mesh.value).material});`];
                if (context.expressionMatchesShape(statement.expression, "(firstBuilds ??= []).push(mesh)"))
                    return [`${indent}first_builds.push_back({mesh, std::nullopt});`];
                if (context.expressionMatchesShape(statement.expression, "(firstBuilds ??= []).push([mesh, mat])"))
                    return [`${indent}first_builds.push_back({mesh, scene.engine->meshes.at(mesh.value).material});`];
                if (context.expressionMatchesShape(statement.expression, "q.length = 0")) return [`${indent}queue.clear();`];
            }
            return undefined;
        },
        expression(node) {
            if (context.expressionMatchesShape(node, "group._w?.(mesh)"))
                return "(group && group->gamma_invalidates && mat->source_gamma_albedo)";
            return undefined;
        },
    });
    const rebuild = context.functionDeclaration("src/scene/scene-rebuild.ts", "rebuildSceneGroups");
    const guard = rebuild.declaration.body!.statements.find(ts.isIfStatement);
    if (!guard) context.contractError(rebuild.declaration, "Expected the scene group rebuild guard.");
    const rebuildGuard = lowerPinnedBody(rebuild.file, [guard], {
        bindings: new Map([
            ["ctx._built", {cpp: "scene.state->material_groups_built", type: "bool"}],
            ["force", {cpp: "force", type: "bool"}],
        ]), calls: new Map(), booleanAnd: true,
        returnValue: expression => {
            if (expression) context.contractError(expression, "Expected a void group rebuild guard.");
            return "";
        },
    });
    return `${lowerPbrGroupReconciliation(context)}
void rebuild_pbr_material_group(Scene& scene, bool force = false, bool reconcile = false) {
${rebuildGuard}
    if (reconcile) reconcile_pbr_material_group(scene);
    bool rearmed = false, aborted = false;
    if (scene.state->source_material_groups) for (const auto& [builder, group] : *scene.state->source_material_groups) {
    if (!reconcile && builder != 1) continue;
    const auto rebuild_group = [&] {
${lowerPbrGroupRebuildBody(context)}
    };
    rebuild_group();
    }
    if (reconcile && !rearmed && !aborted) scene.state->material_group_rebuild_pending = false;
}

struct PbrPendingGroupBuild { MeshHandle mesh; std::optional<MaterialHandle> material; };
${lowerPbrRuntimeDispatch(context)}
void process_pbr_material_swaps(Scene& scene) {
    std::vector<PbrPendingGroupBuild> first_builds, runtime_builds;
${select}
    dispatch_pbr_runtime_builds(scene, runtime_builds, first_builds);
}
`;
}

/** Preserve the pin's insertion-ordered builder map through the shared JS Map carrier. */
function lowerPbrGroupReconciliation(context: LoweringContext): string {
    const {file, declaration} = context.functionDeclaration("src/scene/scene-rebuild.ts", "rebuildSceneGroups");
    const functions = context.findNodes(declaration, (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "reconcileGroups");
    const reconcile = functions[0];
    if (functions.length !== 1 || !reconcile?.body) context.contractError(declaration, "Expected group reconciliation.");
    const bindings = new Map<string, PinnedBinding>([
        ["build", {cpp: "build", type: "scalar"}],
        ["list", {cpp: "list", type: "opaque", absentCpp: "!list"}],
        ["group.length", {cpp: "group->meshes.size()", type: "scalar"}],
        ["next.length", {cpp: "next.size()", type: "scalar"}],
    ]);
    const lower = (statements: readonly ts.Statement[], indent = "    "): string => lowerPinnedBody(file, statements, {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
        forOf: (iterated, element) => iterated === "scene.meshes" ? {
            range: "scene.meshes", bindings: new Map([[element, {cpp: element, type: "opaque"}]]),
        } : undefined,
        expression(node) {
            if (context.expressionMatchesShape(node, "next.some((mesh, i) => group[i] !== mesh)"))
                return "!std::equal(next.begin(), next.end(), group->meshes.begin(), [](MeshHandle a, MeshHandle b) { return a.value == b.value; })";
            return undefined;
        },
        statement(node, _numeric, depth) {
            if (ts.isVariableStatement(node)) {
                const variable = node.declarationList.declarations[0];
                if (node.declarationList.declarations.length !== 1 || !variable || !ts.isIdentifier(variable.name) || !variable.initializer)
                    return undefined;
                const declarations = new Map([
                    ["wanted", ["new Map<MeshGroupBuilder, Mesh[]>()", "SourceMaterialGroups wanted;"]],
                    ["build", ["mesh.material?._buildGroup", "const auto* material = pbr_mesh_material(scene, mesh);\nconst auto build = material ? source_material_group_key(*material) : std::uint64_t{0};"]],
                    ["list", ["wanted.get(build)", "const auto list = material_group_map_get(wanted, build);"]],
                    ["next", ["wanted.get(build) ?? []", "const auto wanted_group = material_group_map_get(wanted, build);\nconst auto next = wanted_group ? wanted_group->meshes : std::vector<MeshHandle>{};"]],
                    ["group", ["next as SceneMeshGroup", "const auto group = next;"]],
                ]);
                const value = declarations.get(variable.name.text);
                if (!value) return undefined;
                context.assertExpressionShape(variable.initializer, value[0]!, "PBR group reconciliation carrier");
                return value[1]!.split("\n").map(line => depth + line);
            }
            if (ts.isForOfStatement(node) && ts.isBlock(node.statement) && ts.isVariableDeclarationList(node.initializer)) {
                const variable = node.initializer.declarations[0];
                if (!variable || !ts.isArrayBindingPattern(variable.name)) return undefined;
                const names = variable.name.elements.map(element => ts.isBindingElement(element) && ts.isIdentifier(element.name) ? element.name.text : "");
                if (context.expressionMatchesShape(node.expression, "scene._groups") && names.join(",") === "build,group")
                    return [`${depth}if (scene.state->source_material_groups) for (const auto& [build, group] : *scene.state->source_material_groups) {`, lower(node.statement.statements, depth + "    "), `${depth}}`];
                if (context.expressionMatchesShape(node.expression, "wanted") && names.join(",") === "build,next")
                    return [`${depth}for (const auto& [build, next] : wanted) {`, lower(node.statement.statements, depth + "    "), `${depth}}`];
                context.contractError(node, "Expected the source builder reconciliation map traversal.");
            }
            if (ts.isExpressionStatement(node)) {
                const operations = new Map([
                    ["list.push(mesh)", "list->meshes.push_back(mesh);"],
                    ["wanted.set(build, [mesh])", "auto created = std::make_shared<SourceMaterialGroupState>(); created->meshes.push_back(mesh); wanted.set(build, created);"],
                    ["group.length = 0", "group->meshes.clear();"],
                    ["group.push(...next)", "group->meshes.insert(group->meshes.end(), next.begin(), next.end());"],
                    ["wanted.delete(build)", "(void)wanted.erase(build);"],
                    ["scene._groups.set(build, group)", "store_scene_material_group(scene, build, group);"],
                ]);
                for (const [shape, cpp] of operations) if (context.expressionMatchesShape(node.expression, shape)) return [`${depth}${cpp}`];
            }
            return undefined;
        },
    }, indent);
    return `void reconcile_pbr_material_group(Scene& scene) {\n${lower(reconcile.body.statements)}\n}\n`;
}

function lowerPbrGroupRebuildBody(context: LoweringContext): string {
    const {file, declaration} = context.functionDeclaration("src/scene/scene-rebuild.ts", "rebuildSceneGroups");
    const initializer = context.variableInitializer(declaration, "groupMeshes");
    const variable = initializer.parent.parent.parent;
    if (!ts.isVariableStatement(variable) || !ts.isBlock(variable.parent)) context.contractError(initializer, "Expected the live rebuild group.");
    const empty = variable.parent.statements[variable.parent.statements.indexOf(variable) + 1];
    const gammaGuard = context.findNodes(declaration, (node): node is ts.IfStatement => ts.isIfStatement(node) &&
        context.expressionMatchesShape(node.expression, 'builder._materialFamily === "pbr" && result._G'))[0];
    const emptyGroup = context.findNodes(declaration, (node): node is ts.IfStatement => ts.isIfStatement(node) &&
        context.expressionMatchesShape(node.expression, "meshes.length === 0"))[0];
    if (!empty || !gammaGuard || !emptyGroup) context.contractError(declaration, "Expected the group rebuild publication.");
    const dropFunctions = context.findNodes(declaration, (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "dropGroupOutput");
    const drop = dropFunctions[0];
    if (dropFunctions.length !== 1 || !drop?.body) context.contractError(declaration, "Expected the group output teardown.");
    const retainedDrop = drop.body.statements.filter(node => {
        if (!ts.isExpressionStatement(node) || !ts.isBinaryExpression(node.expression)) return false;
        const expression = node.expression;
        return ["meshes.r", "ctx._rebuildHook", "rearmed"].some(shape => context.expressionMatchesShape(expression.left, shape));
    });
    if (retainedDrop.length !== 3) context.contractError(drop, "Expected group readiness teardown and rebuild rearming.");
    const dropSource = (indent: string) => `${indent}drop_material_group_outputs(scene, group);\n` + lowerPinnedBody(file, retainedDrop, {
        bindings: new Map([
            ["meshes.r", {cpp: "group->rebuild_ready", type: "bool"}],
            ["ctx._rebuildHook", {cpp: "scene.state->material_group_rebuild_pending", type: "bool"}],
            ["rearmRebuild", {cpp: "true", type: "bool"}],
            ["rearmed", {cpp: "rearmed", type: "bool"}],
        ]), calls: new Map(),
        expression(node) {
            if (ts.isIdentifier(node) && node.text === "undefined") return "false";
            return undefined;
        },
    }, indent);
    const bindings = new Map<string, PinnedBinding>([
        ["groupMeshes.length", {cpp: "group_meshes.size()", type: "scalar"}],
        ["mesh", {cpp: "mesh", type: "opaque"}],
        ["mesh.material?._buildGroup", {cpp: "(pbr_mesh_material(scene, mesh) ? source_material_group_key(*pbr_mesh_material(scene, mesh)) : std::uint64_t{0})", type: "scalar"}],
        ["builder", {cpp: "builder", type: "scalar"}],
        ["result._G", {cpp: "gamma", type: "bool"}],
        ["meshes.length", {cpp: "static_cast<double>(group->meshes.size())", type: "scalar"}],
        ["meshes.o", {cpp: "group->rebuild_ready", type: "bool"}],
        ["meshes.r", {cpp: "group->rebuild_ready", type: "bool"}],
        ["changed", {cpp: "changed", type: "bool"}],
    ]);
    const scope = {
        bindings, calls: new Map([["ctx.meshes.includes", (args: readonly string[]) => `pbr_mesh_list_contains(scene.meshes, ${args.join(", ")})`]]),
        booleanAnd: true, booleanOr: true,
        expression(node: ts.Expression) {
            if (context.expressionMatchesShape(node, 'builder._materialFamily === "pbr"')) return "builder == 1";
            return undefined;
        },
        statement(node: ts.Statement, numeric: import("./pinned-numeric-lowerer.js").PinnedNumericLowerer, indent: string) {
            if (ts.isContinueStatement(node)) return [`${indent}return;`];
            if (node === variable) {
                const call = context.unwrapExpression(initializer);
                if (!ts.isCallExpression(call) || !context.expressionMatchesShape(call.expression, "[...meshes].filter") ||
                    call.arguments.length !== 1 || !ts.isArrowFunction(call.arguments[0]!) || ts.isBlock(call.arguments[0]!.body))
                    context.contractError(initializer, "Expected the live PBR group filter.");
                return [`${indent}std::vector<MeshHandle> group_meshes;`, `${indent}for (const auto mesh : group->meshes) {`,
                    `${indent}    if (${numeric.expression(call.arguments[0]!.body)}) group_meshes.push_back(mesh);`, `${indent}}`];
            }
            if (ts.isExpressionStatement(node)) {
                if (context.expressionMatchesShape(node.expression, "dropGroupOutput(builder, meshes)")) return [dropSource(indent)];
                if (context.expressionMatchesShape(node.expression, "changed = true")) return [];
                if (context.expressionMatchesShape(node.expression, "meshes._w = null")) return [`${indent}group->gamma_invalidates = false;`];
            }
            return undefined;
        },
        returnValue: (expression: ts.Expression | undefined) => {
            if (expression) context.contractError(expression, "Expected an empty group rebuild return.");
            return "";
        },
    };
    // Native constructors resolve within the queued continuation. Source transaction
    // cancellation gates output replacement and its captured material identities.
    return `${lowerPinnedBody(file, [emptyGroup, variable, empty], scope)}
    const auto outputs = capture_material_outputs(scene, group_meshes);
    const auto rebuilt = builder == 1 ? run_pbr_rebuild_transaction(scene, group_meshes, build_pbr_material_group) : std::optional<bool>{false};
    if (!rebuilt) { aborted = true; return; }
    const bool gamma = *rebuilt;
    group->rebuild_ready = true;
${lowerPinnedBody(file, [gammaGuard], scope)}
    publish_full_material_outputs(scene, group, outputs);`;
}

function lowerPbrRuntimeDispatch(context: LoweringContext): string {
    const module = "src/scene/scene-runtime-mesh-build.ts";
    const a = context.functionDeclaration(module, "A"), b = context.functionDeclaration(module, "B"), c = context.functionDeclaration(module, "C");
    const move = context.functionDeclaration(module, "moveRuntimeMeshToGroup");
    const thin = context.functionDeclaration("src/mesh/thin-instance.ts", "buildRuntimeThinMesh");
    context.assertStatementShapes(thin.declaration, thin.declaration.body!.statements,
        'return import("../scene/scene-runtime-mesh-build.js").then((module) => module.A(scene, material, mesh, pending)).catch((error) => console.error(error));',
        "Runtime thin-instance group dispatch");
    const moveBody = move.declaration.body!.statements;
    const bindings = new Map<string, PinnedBinding>([
        ["material", {cpp: "material.value", type: "scalar", absentCpp: "material.value >= scene.engine->materials.size()"}],
        ["mesh", {cpp: "mesh", type: "opaque"}],
        ["mesh.material", {cpp: "scene.engine->meshes.at(mesh.value).material.value", type: "scalar"}],
        ["scene._z", {cpp: "scene.disposed", type: "bool"}],
        ["target", {cpp: "target", type: "opaque", absentCpp: "!target"}],
        ["builder", {cpp: "builder", type: "scalar"}],
        ["groupBuilder", {cpp: "groupBuilder", type: "scalar"}],
    ]);
    const lower = (file: ts.SourceFile, statements: readonly ts.Statement[]): string => lowerPinnedBody(file, statements, {
        bindings, calls: new Map([
            ["scene.meshes.includes", args => `pbr_mesh_list_contains(scene.meshes, ${args.join(", ")})`],
            ["target.includes", args => `pbr_mesh_list_contains(target->meshes, ${args.join(", ")})`],
            ["target.push", args => `target->meshes.push_back(${args.join(", ")})`],
            ["meshes.indexOf", args => `source_group_mesh_index(meshes->meshes, ${args.join(", ")})`],
        ]), booleanAnd: true, booleanOr: true,
        returnValue: () => "",
        statement(node, _numeric, indent): string[] | undefined {
            if (ts.isForOfStatement(node)) {
                if (!ts.isBlock(node.statement) || !ts.isVariableDeclarationList(node.initializer)) context.contractError(node, "Expected runtime group migration body.");
                const binding = node.initializer.declarations[0]?.name;
                if (!binding || !ts.isArrayBindingPattern(binding) || binding.elements.map(element =>
                    ts.isBindingElement(element) && ts.isIdentifier(element.name) ? element.name.text : "").join(",") !== "groupBuilder,meshes")
                    context.contractError(node, "Expected runtime builder and mesh-list identities.");
                context.assertExpressionShape(node.expression, "scene._groups", "Runtime source group traversal");
                return [`${indent}if (scene.state->source_material_groups) for (const auto& [groupBuilder, meshes] : *scene.state->source_material_groups) {`,
                    lower(file, node.statement.statements), `${indent}}`];
            }
            if (ts.isVariableStatement(node)) {
                const variable = node.declarationList.declarations[0];
                if (variable && ts.isIdentifier(variable.name) && variable.name.text === "index") return undefined;
                context.assertStatementShapes(node, [node], "let target = scene._groups.get(builder);", "Runtime PBR group target");
                return [`${indent}auto target = scene_material_group(scene, builder);`];
            }
            if (ts.isExpressionStatement(node)) {
                if (context.expressionMatchesShape(node.expression, "target = []")) return [`${indent}target = std::make_shared<SourceMaterialGroupState>();`];
                if (context.expressionMatchesShape(node.expression, "scene._groups.set(builder, target)")) return [`${indent}store_scene_material_group(scene, builder, target);`];
                if (context.expressionMatchesShape(node.expression, "meshes.splice(index, 1)"))
                    return [`${indent}meshes->meshes.erase(meshes->meshes.begin() + static_cast<std::ptrdiff_t>(index));`];
            }
            return undefined;
        },
    });
    const loop = c.declaration.body!.statements.find(ts.isForOfStatement);
    if (!loop || !ts.isBlock(loop.statement)) context.contractError(c.declaration, "Expected runtime build request traversal.");
    const dispatch = lowerPinnedBody(c.file, [loop], {
        bindings: new Map([
            ["pair", {cpp: "pair", type: "bool"}],
            ["mesh", {cpp: "mesh", type: "opaque"}],
        ]), calls: new Map(),
        forOf: (iterated, element) => iterated === "meshes" ? {range: "meshes", bindings: new Map([[element, {cpp: element, type: "opaque"}]])} : undefined,
        statement(node, _numeric, indent) {
            if (ts.isVariableStatement(node)) {
                const variable = node.declarationList.declarations[0];
                if (!variable || !ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                if (variable.name.text === "pair") {
                    context.assertExpressionShape(variable.initializer, "Array.isArray(entry)", "Runtime captured material request");
                    return [`${indent}const bool pair = entry.material.has_value();`];
                }
                context.assertStatementShapes(node, [node], "const mesh = pair ? entry[0] : entry;", "Runtime build mesh identity");
                return [`${indent}const auto mesh = entry.mesh;`];
            }
            if (ts.isExpressionStatement(node)) {
                context.assertExpressionShape(node.expression, "chain = A(scene, pair ? entry[1] : mesh.material, mesh, chain)", "Runtime build dispatch order");
                return [`${indent}queue_runtime_pbr_group(scene, pair ? *entry.material : scene.engine->meshes.at(mesh.value).material, mesh, pending);`];
            }
            return undefined;
        },
    });
    const schedule = lowerPinnedBody(b.file, b.declaration.body!.statements.slice(2), {
        bindings: new Map([
            ["scene._built", {cpp: "scene.state->material_groups_built", type: "bool"}],
            ["scene._groups.get(builder)?.r", {cpp: "(target && target->rebuild_ready)", type: "bool"}],
        ]), calls: new Map(), booleanAnd: true, booleanOr: true,
        expression(node) {
            if (context.expressionMatchesShape(node, 'builder._materialFamily === "pbr"')) return "builder == 1";
            return undefined;
        },
        statement(node) {
            if (!ts.isVariableStatement(node)) return undefined;
            const variable = node.declarationList.declarations[0];
            if (!variable || !ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
            if (variable.name.text === "hooks") {
                context.assertExpressionShape(variable.initializer, "scene._runtimeBuilds ?? installRuntimeBuilds(scene)", "Runtime build scheduler identity");
                return ["    install_material_runtime(scene);"];
            }
            if (variable.name.text === "rebuild") {
                const calls = context.findNodes(variable.initializer, (expression): expression is ts.CallExpression =>
                    ts.isCallExpression(expression) && context.expressionMatchesShape(expression.expression, "rebuildScenePbrPipelines"));
                if (calls.length !== 1) context.contractError(variable, "Expected one scheduled PBR rebuild.");
                context.assertExpressionShape(calls[0]!, "rebuildScenePbrPipelines(scene, true)", "Runtime forced group rebuild");
                const continuations = context.findNodes(variable.initializer, (expression): expression is ts.ArrowFunction => ts.isArrowFunction(expression) &&
                    !ts.isBlock(expression.body) && context.hasNode(expression.body, node => node === calls[0]));
                if (continuations.length !== 1) context.contractError(variable, "Expected one PBR rebuild continuation.");
                context.assertExpressionShape(continuations[0]!.body as ts.Expression,
                    "scene._z ? undefined : rebuildScenePbrPipelines(scene, true)", "Queued rebuild disposal guard");
                return [];
            }
            return undefined;
        },
        returnValue(expression) {
            if (!expression) context.contractError(b.declaration, "Expected a runtime build request.");
            if (context.expressionMatchesShape(expression, "hooks.track(rebuild)")) return "pending.push_back({mesh, builder, true})";
            context.assertExpressionShape(expression, "hooks.queue(builder, mesh).catch(() => undefined)", "Runtime single-mesh group build");
            return "pending.push_back({mesh, builder, false})";
        },
    });
    return `struct SourceRuntimeGroupBuild { MeshHandle mesh; std::uint64_t builder; bool full; };
double source_group_mesh_index(const std::vector<MeshHandle>& meshes, MeshHandle mesh) {
    const auto found = std::find_if(meshes.begin(), meshes.end(), [mesh](MeshHandle candidate) {return candidate.value == mesh.value;});
    return found == meshes.end() ? -1.0 : static_cast<double>(found - meshes.begin());
}
void queue_runtime_pbr_group(Scene& scene, MaterialHandle material, MeshHandle mesh, std::vector<SourceRuntimeGroupBuild>& pending) {
${lower(a.file, [a.declaration.body!.statements[0]!])}
    const auto builder = source_material_group_key(scene.engine->materials.at(material.value));
    if (!builder) return;
${lower(b.file, [b.declaration.body!.statements[0]!])}
${lower(move.file, moveBody)}
${schedule}
}
void append_pbr_runtime_builds(Scene& scene, const std::vector<PbrPendingGroupBuild>& meshes, std::vector<SourceRuntimeGroupBuild>& pending) {
${dispatch}
}
void dispatch_pbr_runtime_builds(Scene& scene, const std::vector<PbrPendingGroupBuild>& runtime_builds, const std::vector<PbrPendingGroupBuild>& meshes) {
    if (runtime_builds.empty() && meshes.empty()) return;
    scene.engine->drain_material_jobs = drain_material_continuations;
    scene.engine->material_continuations.emplace_back([owner = std::weak_ptr<SceneState>(scene.state), runtime_builds, meshes] {
    const auto state = owner.lock();
    if (!state || state->disposed) return;
    auto scene = Scene::from_state(state);
    std::vector<SourceRuntimeGroupBuild> pending;
    append_pbr_runtime_builds(scene, runtime_builds, pending);
    append_pbr_runtime_builds(scene, meshes, pending);
    // The source import continuation runs after request membership updates.
    // Keep one rebuild per request; the source does not coalesce this path.
    for (const auto& [mesh, builder, full] : pending) {
        if (scene.disposed) continue;
        try {
        if (full) rebuild_pbr_material_group(scene, true);
        else {
            const auto group = scene_material_group(scene, builder);
            const auto outputs = capture_material_outputs(scene, {mesh});
            if (builder == 1) build_pbr_material_group(scene, {mesh});
            publish_runtime_material_outputs(scene, mesh, group, outputs);
            group->rebuild_ready = true;
        }
        } catch (...) {
            scene.state->material_runtime_error = std::current_exception();
        }
    }
    });
}
`;
}
