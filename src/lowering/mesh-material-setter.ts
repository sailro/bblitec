import ts from "typescript";
import type {LoweringContext} from "./context.js";
import {lowerPinnedBody} from "./pinned-body-lowerer.js";
import type {PinnedBinding} from "./pinned-numeric-lowerer.js";

/** Native handles use an engine-local map; weak owners follow SceneState lifetime. */
export function lowerMeshMaterialSetter(context: LoweringContext): string {
    const module = "src/scene/mesh-scene-registry.ts";
    const source = context.sourceFile(module);
    context.assertExpressionShape(context.variableInitializer(source, "_meshScenes"), "null", "Initial mesh owner registry");
    const install = context.functionDeclaration(module, "installMaterialSetter");
    const methods = context.findNodes(install.declaration, (node): node is ts.MethodDeclaration =>
        ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "set");
    const setter = methods[0];
    if (methods.length !== 1 || !setter?.body || setter.parameters.length !== 1 || setter.parameters[0]!.name.getText() !== "v")
        context.contractError(install.declaration, "Expected the installed mesh material setter.");
    const lookup = "[&]() { const auto found = engine.mesh_material_scenes.find(mesh.value); return found == engine.mesh_material_scenes.end() ? std::shared_ptr<MeshMaterialSceneOwners>{} : found->second; }()";
    const bindings = new Map<string, PinnedBinding>([
        ["v", {cpp: "material.value", type: "scalar"}],
        ["_mat", {cpp: "engine.meshes.at(mesh.value).material.value", type: "scalar"}],
        ["scenes", {cpp: "scenes", type: "opaque", absentCpp: "!scenes"}],
        ["scenes.size", {cpp: "scenes->size()", type: "scalar"}],
    ]);
    const body = (declaration: ts.FunctionDeclaration | ts.MethodDeclaration, statements: readonly ts.Statement[]) =>
        lowerPinnedBody(declaration.getSourceFile(), statements, {
            bindings: new Map(bindings), calls: new Map(),
            expression(node, lowerer) {
                if (ts.isNewExpression(node) && context.expressionMatchesShape(node, "new Set()"))
                    return "std::make_shared<MeshMaterialSceneOwners>()";
                if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && context.expressionMatchesShape(node.left, "scenes"))
                    return `(scenes = ${lowerer.expression(node.right)})`;
                if (!ts.isCallExpression(node)) return undefined;
                if (context.expressionMatchesShape(node.expression, "map.set") && node.arguments.length === 2) {
                    context.assertExpressionShape(node.arguments[0]!, "mesh", "Mesh owner map key");
                    return `engine.mesh_material_scenes.insert_or_assign(mesh.value, ${lowerer.expression(node.arguments[1]!)})`;
                }
                if (context.expressionMatchesShape(node, "scenes.add(scene)"))
                    return "insert_mesh_material_scene(*scenes, scene.state)";
                if (context.expressionMatchesShape(node, "scenes.delete(scene)"))
                    return "erase_mesh_material_scene(*scenes, scene.state)";
                return undefined;
            },
            statement(statement, lowerer, indent) {
                if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                    const variable = statement.declarationList.declarations[0]!;
                    if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                    if (variable.name.text === "map") {
                        context.assertExpressionShape(variable.initializer, "(_meshScenes ??= new WeakMap())", "Mesh owner map allocation");
                        return [];
                    }
                    if (variable.name.text === "scenes") {
                        const shape = declaration === setter ? "_meshScenes?.get(mesh)"
                            : declaration.name?.getText() === "registerMeshScene" ? "map.get(mesh)" : "_meshScenes?.get(mesh)";
                        context.assertExpressionShape(variable.initializer, shape, "Mesh scene owner lookup");
                        return [`${indent}auto scenes = ${lookup};`];
                    }
                }
                if (ts.isForOfStatement(statement)) {
                    context.assertExpressionShape(statement.expression, "scenes", "Material setter subscribers");
                    if (!ts.isVariableDeclarationList(statement.initializer) || statement.initializer.declarations.length !== 1 ||
                        statement.initializer.declarations[0]!.name.getText() !== "scene")
                        context.contractError(statement, "Expected a scene subscriber binding.");
                    const statements = ts.isBlock(statement.statement) ? statement.statement.statements : [statement.statement];
                    return [`${indent}for (const auto& owner : *scenes) {`,
                        `${indent}    const auto state = owner.lock();`, `${indent}    if (!state) continue;`,
                        `${indent}    auto scene = Scene::from_state(state);`, ...lowerer.statements(statements, indent + "    "), `${indent}}`];
                }
                if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
                    if (context.expressionMatchesShape(statement.expression, "installMaterialSetter(mesh)")) return [];
                    if (context.expressionMatchesShape(statement.expression, "enqueueMaterialSwap(scene, mesh)"))
                        return [`${indent}if (scene.state->enqueue_material_group) scene.state->enqueue_material_group(scene, mesh);`];
                }
                return undefined;
            },
            returnValue: (expression, lowerer) => expression ? lowerer.expression(expression) : "",
        });
    const register = context.functionDeclaration(module, "registerMeshScene").declaration;
    const guard = register.body!.statements[0];
    if (!guard || !ts.isIfStatement(guard)) context.contractError(register, "Expected disposed mesh validation before subscription.");
    context.assertExpressionShape(guard.expression, "mesh._disposed", "Mesh registration disposal guard");
    const unregister = context.functionDeclaration(module, "unregisterMeshScene").declaration;
    return `void insert_mesh_material_scene(MeshMaterialSceneOwners& owners, const std::shared_ptr<SceneState>& scene) {
    if (std::none_of(owners.begin(), owners.end(), [&](const auto& owner) { return owner.lock() == scene; })) owners.push_back(scene);
}
void erase_mesh_material_scene(MeshMaterialSceneOwners& owners, const std::shared_ptr<SceneState>& scene) {
    std::erase_if(owners, [&](const auto& owner) { const auto live = owner.lock(); return !live || live == scene; });
}
// ${context.provenance(module, "registerMeshScene")}
void register_mesh_material_scene(Scene& scene, MeshHandle mesh) {
    // add_to_scene has validated the native handle and disposed state.
    Engine& engine = *scene.engine;
${body(register, register.body!.statements.slice(1))}
}
// ${context.provenance(module, "unregisterMeshScene")}
bool unregister_mesh_material_scene(Scene& scene, MeshHandle mesh) {
    Engine& engine = *scene.engine;
${body(unregister, unregister.body!.statements)}
}
// ${context.provenance(module, "installMaterialSetter")}
void set_mesh_material(Engine& engine, MeshHandle mesh, MaterialHandle material) {
${body(setter, setter.body.statements)}
}
`;
}
