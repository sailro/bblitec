import ts from "typescript";
import type {LoweringContext} from "./context.js";
import {lowerPinnedBody} from "./pinned-body-lowerer.js";
import type {PinnedBinding} from "./pinned-numeric-lowerer.js";
import {lowerPbrTransmissionTransaction} from "./pbr-transmission-transaction.js";

export function lowerPbrGammaAlbedo(context: LoweringContext): string {
    const module = "src/material/pbr/set-gamma-albedo.ts";
    const {file, declaration} = context.functionDeclaration(module, "setPbrGammaAlbedo");
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map([["mat._gammaAlbedo", {cpp: "engine.materials.at(material.value).source_gamma_albedo", type: "bool"}]]),
        calls: new Map(),
        statement(statement) {
            if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return undefined;
            context.assertExpressionShape(statement.expression, "_registerPbrExt(pbrExt)", "Gamma-albedo composition registration");
            return [];
        },
    });
    return `// ${context.provenance(module, "setPbrGammaAlbedo")}
void set_pbr_gamma_albedo(Engine& engine, MaterialHandle material) {
${body}
}
`;
}

/** Source-owned selection; frame-graph activation remains a separate adapter. */
export function lowerPbrTransmissionSelection(context: LoweringContext): string {
    const module = "src/material/pbr/pbr-transmission-ext.ts";
    const {file, declaration} = context.functionDeclaration(module, "registerPbrTransmission");
    const statements = declaration.body!.statements;
    const activation = statements.findIndex(statement => ts.isExpressionStatement(statement) &&
        context.findNodes(statement, (node): node is ts.CallExpression => ts.isCallExpression(node) &&
            context.expressionMatchesShape(node.expression, "enableSceneTransmission")).length > 0);
    if (activation < 0) context.contractError(declaration, "Expected the PBR transmission activation boundary.");
    context.assertStatementShapes(declaration, statements.slice(activation),
        "scene._p?.(_t(scene, engine)) || enableSceneTransmission(scene, engine);\n" +
        "_registerPbrExt(makeRefractionRttExt(_dispersionSampleWgsl));", "PBR transmission activation adapter");
    const bindings = new Map<string, PinnedBinding>([
        ["meshes.length", {cpp: "static_cast<double>(meshes.size())", type: "scalar"}],
        ["mat?._transmissive", {cpp: "(mat && mat->source_transmissive)", type: "bool"}],
    ]);
    const body = lowerPinnedBody(file, statements.slice(0, activation), {
        bindings, calls: new Map(), booleanAnd: true,
        expression(node, lowerer) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
                context.expressionMatchesShape(node.left, "mat._subsurface?.refraction?.intensity"))
                return `([&]() { if (!mat) throw std::runtime_error("Cannot read refraction from a null material."); return mat->source_refraction_intensity; }()).value_or(${lowerer.expression(node.right)})`;
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isReturnStatement(statement)) {
                if (statement.expression) context.contractError(statement, "Expected a void transmission early return.");
                return [`${indent}return false;`];
            }
            if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
            const variable = statement.declarationList.declarations[0]!;
            if (!ts.isIdentifier(variable.name) || variable.name.text !== "mat" || !variable.initializer) return undefined;
            const read = context.unwrapExpression(variable.initializer);
            if (!ts.isPropertyAccessExpression(read) || read.name.text !== "material")
                context.contractError(read, "Expected a transmission mesh material read.");
            const mesh = context.unwrapExpression(read.expression);
            if (!ts.isElementAccessExpression(mesh) || !context.expressionMatchesShape(mesh.expression, "meshes") || !mesh.argumentExpression)
                context.contractError(mesh, "Expected an indexed transmission mesh.");
            bindings.set("mat", {cpp: "mat", type: "opaque", absentCpp: "!mat"});
            return [`${indent}const auto material = engine.meshes.at(meshes.at(static_cast<std::size_t>(${lowerer.expression(mesh.argumentExpression)})).value).material;`,
                `${indent}const MaterialRecord* mat = material.value < engine.materials.size() ? &engine.materials[material.value] : nullptr;`];
        },
    });
    return `// ${context.provenance(module, "registerPbrTransmission")}
bool pbr_group_has_transmission(const Engine& engine, const std::vector<MeshHandle>& meshes) {
${body}
    return true;
}
`;
}

/** Module-wide Set identity, registration and build-time iteration come from the pin. */
export function lowerPbrSceneHookRegistry(context: LoweringContext): string {
    const module = "src/material/pbr/pbr-flags.ts";
    const source = context.sourceFile(module);
    context.assertExpressionShape(context.variableInitializer(source, "_pbrSceneHooks"), "null", "Initial PBR hook registry");
    const register = context.functionDeclaration(module, "_registerPbrSceneHook");
    const get = context.functionDeclaration(module, "_getPbrSceneHooks");
    const bindings = new Map<string, PinnedBinding>([
        ["hook", {cpp: "hook", type: "opaque"}],
        ["_pbrSceneHooks", {cpp: "pbr_scene_hooks", type: "opaque", absentCpp: "!pbr_scene_hooks"}],
    ]);
    const registerBody = lowerPinnedBody(register.file, register.declaration.body!.statements, {
        bindings, calls: new Map(),
        expression(node, lowerer) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken &&
                context.expressionMatchesShape(node.left, "_pbrSceneHooks")) {
                context.assertExpressionShape(node.right, "new Set()", "PBR hook Set allocation");
                return "(pbr_scene_hooks ? *pbr_scene_hooks : pbr_scene_hooks.emplace())";
            }
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "add" && node.arguments.length === 1)
                return `${lowerer.expression(node.expression.expression)}.add(${lowerer.expression(node.arguments[0]!)})`;
            return undefined;
        },
    });
    const getBody = lowerPinnedBody(get.file, get.declaration.body!.statements, {
        bindings, calls: new Map(),
        returnValue: (expression, lowerer) => {
            if (!expression) context.contractError(get.declaration, "Expected the PBR hook iterable return.");
            return lowerer.expression(expression);
        },
        expression(node) {
            if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
                !context.expressionMatchesShape(node.left, "_pbrSceneHooks")) return undefined;
            context.assertExpressionShape(node.right, "[]", "Empty PBR hook iterable");
            return "pbr_scene_hooks ? *pbr_scene_hooks : js::Set<PbrSceneHook>{}";
        },
    });
    const builderModule = "src/material/pbr/pbr-renderable.ts";
    const builder = context.functionDeclaration(builderModule, "buildPbrRenderables");
    const loop = builder.declaration.body!.statements.find(statement => ts.isForOfStatement(statement) &&
        context.expressionMatchesShape(statement.expression, "_getPbrSceneHooks()"));
    if (!loop || !ts.isForOfStatement(loop)) context.contractError(builder.declaration, "Expected PBR scene hook dispatch.");
    const dispatch = lowerPinnedBody(builder.file, [loop], {
        bindings: new Map([["hook", {cpp: "hook", type: "opaque"}]]), calls: new Map(),
        statement(statement, lowerer, indent) {
            if (ts.isForOfStatement(statement)) {
                context.assertStatementShapes(statement, [statement],
                    "for (const hook of _getPbrSceneHooks()) { await hook(scene as SceneContext, engine, meshes); }", "PBR scene hook iteration");
                const body = ts.isBlock(statement.statement) ? statement.statement.statements : [statement.statement];
                return [`${indent}for (const auto& hook : get_pbr_scene_hooks()) {`,
                    ...lowerer.statements(body, indent + "    "), `${indent}}`];
            }
            if (!ts.isExpressionStatement(statement)) return undefined;
            context.assertExpressionShape(statement.expression, "await hook(scene as SceneContext, engine, meshes)", "PBR hook invocation");
            return [`${indent}hook(scene, *scene.engine, meshes);`];
        },
    });
    const hook = context.functionDeclaration("src/material/pbr/pbr-transmission-ext.ts", "registerPbrTransmission");
    const activation = lowerPinnedBody(hook.file, hook.declaration.body!.statements.slice(-2), {
        bindings: new Map([["scene", {cpp: "scene", type: "opaque"}], ["engine", {cpp: "engine", type: "opaque"}]]),
        calls: new Map([["enableSceneTransmission", () => "(enable_scene_transmission(scene), false)"]]),
        booleanOr: true,
        expression(node) {
            if (!context.expressionMatchesShape(node, "scene._p?.(_t(scene, engine))")) return undefined;
            return "(scene.state->pbr_transmission_transaction && scene.state->pbr_transmission_transaction(make_pbr_transmission_transaction(scene)))";
        },
        statement(statement, numeric, indent) {
            if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
                return [`${indent}static_cast<void>(${numeric.expression(statement.expression)});`];
            if (!ts.isExpressionStatement(statement) || !context.expressionMatchesShape(statement.expression,
                "_registerPbrExt(makeRefractionRttExt(_dispersionSampleWgsl))")) return undefined;
            return [];
        },
    });
    return `${lowerPbrTransmissionTransaction(context)}
using PbrSceneHook = void (*)(Scene&, Engine&, const std::vector<MeshHandle>&);
std::optional<js::Set<PbrSceneHook>> pbr_scene_hooks;
// ${context.provenance(module, "_registerPbrSceneHook")}
void register_pbr_scene_hook(PbrSceneHook hook) {
${registerBody}
}
// ${context.provenance(module, "_getPbrSceneHooks")}
js::Set<PbrSceneHook> get_pbr_scene_hooks() {
${getBody}
}
// ${context.provenance(builderModule, "buildPbrRenderables")}
void run_pbr_scene_hooks_impl(Scene& scene, const std::vector<MeshHandle>& meshes) {
${dispatch}
}
${lowerPbrTransmissionSelection(context)}
void register_pbr_transmission(Scene& scene, Engine& engine, const std::vector<MeshHandle>& meshes) {
    if (!pbr_group_has_transmission(engine, meshes)) return;
${activation}
}
`;
}
