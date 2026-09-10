import ts from "typescript";
import type {LoweringContext} from "./context.js";
import {lowerPinnedBody} from "./pinned-body-lowerer.js";

/** Output identities and captured material handles transport the source renderables. */
export function lowerMaterialPublication(context: LoweringContext): string {
    const source = "src/scene/scene-material-swap.ts";
    const {file, declaration} = context.functionDeclaration(source, "processMaterialSwaps");
    const loop = declaration.body!.statements.find(ts.isForOfStatement);
    if (!loop || !ts.isBlock(loop.statement)) context.contractError(declaration, "Expected the source material swap loop.");
    const old = context.variableInitializer(loop, "o").parent.parent.parent;
    const changed = loop.statement.statements.at(-1)!;
    if (!ts.isVariableStatement(old)) context.contractError(old, "Expected the output publication start.");
    context.assertStatementShapes(changed, [changed], "changed = renderables.push(built);", "Single output publication");
    const statements = loop.statement.statements.slice(loop.statement.statements.indexOf(old));
    const single = lowerPinnedBody(file, statements, {
        bindings: new Map(), calls: new Map(),
        statement(node, _lowerer, indent) {
            if (ts.isVariableStatement(node)) {
                const variable = node.declarationList.declarations[0];
                if (!variable || !ts.isIdentifier(variable.name)) return undefined;
                const values = new Map([
                    ["o", ["const o = group.o;", "auto& outputs = group->outputs;"]],
                    ["dead", ["let dead: Renderable | undefined;", "SourceMaterialOutput dead;"]],
                    ["built", ["const built = rebuild(scene, mesh);", "const auto built = capture_material_output(scene, mesh);"]],
                ]);
                const value = values.get(variable.name.text);
                if (!value) return undefined;
                context.assertStatementShapes(node, [node], value[0]!, "Single output carrier");
                return [`${indent}${value[1]}`];
            }
            if (ts.isForStatement(node)) {
                context.assertStatementShapes(node, [node], `for (let i = renderables.length; i--;) {
                    if (renderables[i]!.mesh === mesh) { dead = renderables.splice(i, 1)[0]; }
                }`, "Single output removal");
                return [`${indent}for (std::size_t i = scene.state->material_outputs.size(); i--;) {`,
                    `${indent}    const auto& output = scene.state->material_outputs[i];`,
                    `${indent}    if (output->mesh == mesh) { dead = output; scene.state->material_outputs.erase(scene.state->material_outputs.begin() + static_cast<std::ptrdiff_t>(i)); }`,
                    `${indent}}`];
            }
            if (ts.isIfStatement(node)) {
                context.assertStatementShapes(node, [node], `if (o) {
                    const oi = o.indexOf(dead!); oi < 0 ? o.push(built) : (o[oi] = built);
                }`, "Tracked single output replacement");
                // A built group's source o is always present, including the empty array.
                return [`${indent}const auto previous = std::find(outputs.begin(), outputs.end(), dead);`,
                    `${indent}if (previous == outputs.end()) outputs.push_back(built); else *previous = built;`];
            }
            if (ts.isExpressionStatement(node)) {
                if (context.expressionMatchesShape(node.expression, "mat._csmGen = -~mat._csmGen!")) return [];
                if (context.expressionMatchesShape(node.expression, "changed = renderables.push(built)"))
                    return [`${indent}append_material_outputs(scene, {built});`, `${indent}++scene.render_topology_version;`];
            }
            return undefined;
        },
    });
    const pbr = context.functionDeclaration("src/material/pbr/pbr-renderable.ts", "buildPbrRenderables");
    const draw = context.variableInitializer(pbr.declaration, "drawWith");
    if (!ts.isArrowFunction(draw) || !ts.isBlock(draw.body)) context.contractError(draw, "Expected the captured PBR draw closure.");
    const first = draw.body.statements[0]!;
    const guard = lowerPinnedBody(pbr.file, [first], {
        bindings: new Map([
            ["isOverride", {cpp: "is_override", type: "bool"}],
            ["mesh.material", {cpp: "current.value", type: "scalar"}],
            ["mat", {cpp: "captured.value", type: "scalar"}],
        ]), calls: new Map(), booleanAnd: true,
        returnValue(expression) {
            if (!expression) context.contractError(first, "Expected the captured-material draw result.");
            context.assertExpressionShape(expression, "0", "Suppressed stale draw");
            return "false";
        },
    });
    const familyGuard = (module: string, name: string, condition: string, current: string, captured: string): string => {
        const source = context.functionDeclaration(module, name);
        const checks = context.findNodes(source.declaration, (node): node is ts.IfStatement => ts.isIfStatement(node) &&
            context.expressionMatchesShape(node.expression, condition) && ts.isBlock(node.thenStatement) &&
            node.thenStatement.statements.some(statement => ts.isReturnStatement(statement) && statement.expression !== undefined &&
                context.expressionMatchesShape(statement.expression, "0")));
        if (checks.length !== 1) context.contractError(source.declaration, "Expected the family's captured-material draw guard.");
        return lowerPinnedBody(source.file, checks, {
            bindings: new Map([
                ["isOverride", {cpp: "is_override", type: "bool"}],
                [current, {cpp: "current.value", type: "scalar"}],
                [captured, {cpp: "captured.value", type: "scalar"}],
            ]), calls: new Map(), booleanAnd: true,
            returnValue: () => "false",
        });
    };
    const standardGuard = familyGuard("src/material/standard/standard-renderable.ts", "buildStandardMeshRenderables",
        "!isOverride && mesh.material !== mat", "mesh.material", "mat");
    const shaderGuard = familyGuard("src/material/shader/shader-renderable.ts", "createTransparentRenderable",
        "!isOverride && packet.mesh.material !== material", "packet.mesh.material", "material");
    const runtime = context.functionDeclaration("src/scene/scene-runtime-mesh-build.ts", "materializeRuntimeMesh");
    const runtimeRemoval = runtime.declaration.body!.statements.find(node => ts.isForStatement(node) &&
        context.expressionMatchesShape(node.condition!, "i >= 0") && node.getText().includes("scene._renderables"));
    const runtimeAppend = runtime.declaration.body!.statements.find(node => ts.isExpressionStatement(node) &&
        context.expressionMatchesShape(node.expression, "scene._renderables.push(...result.renderables)"));
    const runtimeTracked = runtime.declaration.body!.statements.find(node => ts.isIfStatement(node) &&
        context.expressionMatchesShape(node.expression, "runtimeGroup"));
    if (!runtimeRemoval || !runtimeAppend || !runtimeTracked)
        context.contractError(runtime.declaration, "Expected completed runtime output publication.");
    const runtimeOutput = lowerPinnedBody(runtime.file, [runtimeRemoval, runtimeAppend, runtimeTracked], {
        bindings: new Map(), calls: new Map(),
        statement(node, _numeric, indent) {
            if (node === runtimeRemoval) {
                context.assertStatementShapes(node, [node], `for (let i = scene._renderables.length - 1; i >= 0; i--) {
                    if (scene._renderables[i]!.mesh === mesh) { scene._renderables.splice(i, 1); }
                }`, "Completed runtime output removal");
                return [`${indent}std::erase_if(scene.state->material_outputs, [mesh](const auto& output) { return output->mesh == mesh; });`];
            }
            if (node === runtimeAppend) return [`${indent}append_material_outputs(scene, outputs);`];
            if (node === runtimeTracked) {
                context.assertStatementShapes(node, [node], `if (runtimeGroup) {
                    runtimeGroup.o = [...(runtimeGroup.o ?? []).filter((renderable) => renderable.mesh !== mesh), ...result.renderables];
                }`, "Runtime tracked output replacement");
                return [`${indent}if (group) {`,
                    `${indent}    std::erase_if(group->outputs, [mesh](const auto& output) { return output->mesh == mesh; });`,
                    `${indent}    group->outputs.insert(group->outputs.end(), outputs.begin(), outputs.end());`, `${indent}}`];
            }
            return undefined;
        },
    });
    const rebuild = context.functionDeclaration("src/scene/scene-rebuild.ts", "rebuildSceneGroups");
    const drop = context.findNodes(rebuild.declaration, (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "dropGroupOutput")[0];
    if (!drop?.body) context.contractError(rebuild.declaration, "Expected source group output disposal.");
    context.assertStatementShapes(drop, drop.body.statements.slice(0, 3), `
        const owned = meshes.o;
        if (owned?.length) {
            const ownedSet = new Set<Renderable>(owned);
            for (let i = ctx._renderables.length - 1; i >= 0; i--) {
                if (ownedSet.has(ctx._renderables[i]!)) { ctx._renderables.splice(i, 1); }
            }
        }
        meshes.o = undefined;
    `, "Dropped group output identity");
    const dropOutput = lowerPinnedBody(rebuild.file, drop.body.statements.slice(0, 3), {
        bindings: new Map(), calls: new Map(),
        statement(node, _numeric, indent) {
            if (ts.isVariableStatement(node)) return [`${indent}const auto owned = group->outputs;`];
            if (ts.isIfStatement(node)) return [`${indent}if (!owned.empty()) {`,
                `${indent}    const std::unordered_set<SourceMaterialOutput> owned_set(owned.begin(), owned.end());`,
                `${indent}    std::erase_if(scene.state->material_outputs, [&](const auto& output) { return owned_set.contains(output); });`, `${indent}}`];
            if (ts.isExpressionStatement(node)) return [`${indent}group->outputs.clear();`];
            return undefined;
        },
    });
    const stale = context.variableInitializer(rebuild.declaration, "stale").parent.parent.parent;
    if (!ts.isVariableStatement(stale) || !ts.isBlock(stale.parent)) context.contractError(stale, "Expected full rebuild output publication.");
    const fullAssignments = stale.parent.statements.slice(stale.parent.statements.indexOf(stale), stale.parent.statements.indexOf(stale) + 6);
    context.assertStatementShapes(stale, fullAssignments, `
        const stale = meshes.o;
        const staleSet = stale?.length ? new Set<Renderable>(stale) : null;
        for (let i = ctx._renderables.length - 1; i >= 0; i--) {
            const existing = ctx._renderables[i]!;
            if (liveMeshes.has(existing.mesh as Mesh) || staleSet?.has(existing)) { ctx._renderables.splice(i, 1); }
        }
        const kept = result.renderables.filter((renderable) => !renderable.mesh || liveMeshes.has(renderable.mesh));
        ctx._renderables.push(...kept);
        meshes.o = kept;
    `, "Full rebuilt output replacement");
    const fullOutput = lowerPinnedBody(rebuild.file, fullAssignments, {
        bindings: new Map(), calls: new Map(),
        statement(node, _numeric, indent) {
            if (ts.isVariableStatement(node)) {
                const variable = node.declarationList.declarations[0]!;
                if (variable.name.getText() === "stale") return [`${indent}const auto stale = group->outputs;`];
                if (variable.name.getText() === "staleSet") return [
                    `${indent}const std::unordered_set<SourceMaterialOutput> stale_set(stale.begin(), stale.end());`,
                    `${indent}std::unordered_set<std::uint32_t> live_meshes;`,
                    `${indent}for (const auto& output : outputs) live_meshes.insert(output->mesh.value);`,
                ];
                if (variable.name.getText() === "kept") return [`${indent}const auto& kept = outputs;`];
            }
            if (ts.isForStatement(node)) return [
                `${indent}std::erase_if(scene.state->material_outputs, [&](const auto& existing) {`,
                `${indent}    return live_meshes.contains(existing->mesh.value) || stale_set.contains(existing);`, `${indent}});`,
            ];
            if (ts.isExpressionStatement(node)) {
                if (context.expressionMatchesShape(node.expression, "ctx._renderables.push(...kept)")) return [`${indent}append_material_outputs(scene, kept);`];
                if (context.expressionMatchesShape(node.expression, "meshes.o = kept")) return [`${indent}group->outputs = kept;`];
            }
            return undefined;
        },
    });
    const install = context.functionDeclaration("src/scene/scene-runtime-mesh-build.ts", "installRuntimeBuilds");
    const hooks = context.variableInitializer(install.declaration, "hooks");
    if (!ts.isObjectLiteralExpression(hooks)) context.contractError(hooks, "Expected runtime build hooks.");
    const errorCheck = context.propertyInitializer(hooks, "_e");
    if (!ts.isArrowFunction(errorCheck) || !ts.isBlock(errorCheck.body)) context.contractError(errorCheck, "Expected runtime error delivery.");
    const errorBody = lowerPinnedBody(install.file, errorCheck.body.statements, {
        bindings: new Map([
            ["state.error", {cpp: "scene.state->material_runtime_error", type: "opaque", absentCpp: "!scene.state->material_runtime_error"}],
            ["clear", {cpp: "clear", type: "bool"}],
            ["error", {cpp: "error", type: "opaque"}],
        ]), calls: new Map(),
        statement(node, _numeric, indent) {
            if (ts.isVariableStatement(node)) {
                context.assertStatementShapes(node, [node], "const error = state.error;", "Runtime error identity");
                return [`${indent}const auto error = scene.state->material_runtime_error;`];
            }
            if (ts.isExpressionStatement(node)) {
                context.assertExpressionShape(node.expression, "state.error = null", "Runtime error consumption");
                return [`${indent}scene.state->material_runtime_error = nullptr;`];
            }
            if (ts.isThrowStatement(node)) {
                context.assertExpressionShape(node.expression, "error", "Runtime error rethrow");
                return [`${indent}std::rethrow_exception(error);`];
            }
            return undefined;
        },
    });
    const errorHook = install.declaration.body!.statements.find(node => ts.isExpressionStatement(node) &&
        context.hasNode(node, child => ts.isCallExpression(child) && context.expressionMatchesShape(child.expression, "hooks._e")));
    if (!errorHook) context.contractError(install.declaration, "Expected the before-render runtime error hook.");
    context.assertStatementShapes(errorHook, [errorHook], `(scene._beforeRender ??= []).push(() => { hooks._e(); });`, "Runtime error callback placement");
    return `void deliver_material_runtime_error(Scene& scene, bool clear = true) {
${errorBody}
}
void install_material_runtime(Scene& scene) {
    if (scene.state->material_runtime_installed) return;
    scene.state->material_runtime_installed = true;
    scene.before_render.push_back([owner = std::weak_ptr<SceneState>(scene.state)](float) {
        const auto state = owner.lock();
        if (!state) return;
        auto scene = Scene::from_state(state);
        deliver_material_runtime_error(scene);
    });
}
bool source_material_draw_matches(MaterialHandle current, MaterialHandle captured, bool is_override);
bool source_standard_material_draw_matches(MaterialHandle current, MaterialHandle captured, bool is_override);
bool source_shader_material_draw_matches(MaterialHandle current, MaterialHandle captured, bool is_override);
SourceMaterialOutput capture_material_output(Scene& scene, MeshHandle mesh) {
    const auto material = scene.engine->meshes.at(mesh.value).material;
    const auto& record = scene.engine->materials.at(material.value);
    const auto guard = record.source_pbr_group_builder ? source_material_draw_matches :
        record.source_group_builder == 2 ? source_standard_material_draw_matches :
        record.source_group_builder == 3 ? source_shader_material_draw_matches : nullptr;
    return std::make_shared<SourceMaterialDraw>(SourceMaterialDraw{mesh, material, guard});
}
SourceMaterialOutputs capture_material_outputs(Scene& scene, const std::vector<MeshHandle>& meshes) {
    SourceMaterialOutputs outputs;
    outputs.reserve(meshes.size());
    for (const auto mesh : meshes) outputs.push_back(capture_material_output(scene, mesh));
    return outputs;
}
void append_material_outputs(Scene& scene, const SourceMaterialOutputs& outputs) {
    scene.state->material_outputs.insert(scene.state->material_outputs.end(), outputs.begin(), outputs.end());
    for (const auto& output : outputs) scene.material_family_mask |= bbl::material_family_bit(scene.engine->materials.at(output->material.value));
}
// ${context.provenance(source, "processMaterialSwaps")}
void publish_single_material_output(Scene& scene, MeshHandle mesh, const std::shared_ptr<SourceMaterialGroupState>& group) {
${single}
}
// ${context.provenance("src/scene/scene-runtime-mesh-build.ts", "materializeRuntimeMesh")}
void publish_runtime_material_outputs(Scene& scene, MeshHandle mesh, const std::shared_ptr<SourceMaterialGroupState>& group, const SourceMaterialOutputs& outputs) {
${runtimeOutput}
    ++scene.render_topology_version;
}
// ${context.provenance("src/scene/scene-rebuild.ts", "rebuildSceneGroups")}
void publish_full_material_outputs(Scene& scene, const std::shared_ptr<SourceMaterialGroupState>& group, const SourceMaterialOutputs& outputs) {
${fullOutput}
    ++scene.render_topology_version;
}
void drop_material_group_outputs(Scene& scene, const std::shared_ptr<SourceMaterialGroupState>& group) {
${dropOutput}
    ++scene.render_topology_version;
}
// ${context.provenance("src/material/pbr/pbr-renderable.ts", "buildPbrRenderables")}
bool source_material_draw_matches(MaterialHandle current, MaterialHandle captured, bool is_override) {
${guard}
    return true;
}
bool source_standard_material_draw_matches(MaterialHandle current, MaterialHandle captured, bool is_override) {
${standardGuard}
    return true;
}
bool source_shader_material_draw_matches(MaterialHandle current, MaterialHandle captured, bool is_override) {
${shaderGuard}
    return true;
}
`;
}

/** Native module/GPU construction resolves synchronously; its continuation runs after submission. */
export function materialPublicationTransport(): string {
    return `// Host continuation queue: unlike setTimeout, jobs added by jobs drain at this checkpoint.
void drain_material_continuations(Engine& engine) {
    while (!engine.material_continuations.empty()) {
        auto jobs = std::move(engine.material_continuations);
        engine.material_continuations.clear();
        for (auto& job : jobs) job();
    }
}
`;
}
