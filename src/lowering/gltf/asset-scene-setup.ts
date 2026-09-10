import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";
import type {PinnedBinding} from "../pinned-numeric-lowerer.js";

const module = "src/loader-gltf/load-gltf.ts";
const registryModule = "src/loader-gltf/gltf-feature-registry.ts";

/** Project the source fragment fold onto the callbacks retained by the native asset. */
export function lowerGltfAssetSceneSetup(context: LoweringContext): string {
    const {file, declaration} = context.functionDeclaration(module, "loadGltf");
    context.assertExpressionShape(context.variableInitializer(declaration, "assetFragments"),
        "await Promise.all(features.flatMap((f) => (f.applyAsset ? [f.applyAsset(meshes, root, ctx)] : [])))",
        "glTF asset fragment collection order");
    const loop = declaration.body?.statements.find(statement => ts.isForOfStatement(statement) &&
        context.expressionMatchesShape(statement.expression, "assetFragments"));
    if (!loop || !ts.isForOfStatement(loop)) context.contractError(declaration, "Expected the glTF asset fragment fold.");
    context.assertStatementShapes(declaration, declaration.body!.statements.slice(declaration.body!.statements.indexOf(loop) + 1),
        "return container;", "glTF completed fragment projection");
    const bindings = new Map<string, PinnedBinding>([
        ["container._sceneSetup", {cpp: "container.scene_setup", type: "opaque", absentCpp: "!container.scene_setup"}],
        ["_sceneSetup", {cpp: "_sceneSetup", type: "opaque", absentCpp: "!_sceneSetup"}],
    ]);
    const body = lowerPinnedBody(file, [loop], {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
        forOf(iterated, element) {
            if (iterated !== "assetFragments" || element !== "frag") return undefined;
            return {range: "assetFragments", bindings: new Map([[element, {cpp: element, type: "opaque"}]])};
        },
        statement(statement, lowerer, indent) {
            // Entity registration and the other fragment fields execute in the
            // mesh planner or their feature adapter. This projection owns only
            // the setup field; changes across that boundary must be represented.
            if (ts.isIfStatement(statement) && context.expressionMatchesShape(statement.expression, "frag.entities?.length")) {
                context.assertStatementShapes(statement, [statement.thenStatement],
                    "{ container.entities.push(...frag.entities); }", "glTF fragment entity projection");
                if (statement.elseStatement) context.contractError(statement, "Unrepresented glTF fragment entity alternative.");
                return [];
            }
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (ts.isObjectBindingPattern(variable.name)) {
                    context.assertStatementShapes(statement, [statement],
                        "const { entities: _ignored, _sceneSetup, ...rest } = frag;", "glTF fragment field projection");
                    return [`${indent}const auto _sceneSetup = frag;`];
                }
                if (ts.isIdentifier(variable.name) && variable.name.text === "prev" && variable.initializer) {
                    const initializer = lowerer.expression(variable.initializer);
                    bindings.set("prev", {cpp: "prev", type: "opaque", absentCpp: "!prev"});
                    return [`${indent}const auto prev = ${initializer};`];
                }
            }
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = context.unwrapExpression(statement.expression);
            if (context.expressionMatchesShape(expression, "void _ignored") ||
                context.expressionMatchesShape(expression, "Object.assign(container, rest)")) return [];
            if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
                ["prev", "_sceneSetup"].includes(expression.expression.text)) {
                const name = expression.expression.text;
                context.assertExpressionShape(expression, `${name}${expression.questionDotToken ? "?." : ""}(scene, target)`,
                    "glTF setup scene and target forwarding");
                return [`${indent}${expression.questionDotToken ? `if (${name}) ` : ""}${name}(scene);`];
            }
            if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                context.expressionMatchesShape(expression.left, "container._sceneSetup")) {
                const callback = context.unwrapExpression(expression.right);
                if (!ts.isArrowFunction(callback) || !ts.isBlock(callback.body) || callback.parameters.length !== 2 ||
                    callback.parameters.some((parameter, index) => parameter.name.getText(file) !== ["scene", "target"][index] ||
                        parameter.initializer || parameter.dotDotDotToken))
                    context.contractError(callback, "Expected the glTF scene setup callback boundary.");
                return [`${indent}container.scene_setup = [prev, _sceneSetup](Scene& scene) {`,
                    ...lowerer.statements(callback.body.statements, indent + "    "), `${indent}};`];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(module, "loadGltf")}
void compose_gltf_scene_setup([[maybe_unused]] AssetRecord& container,
    std::initializer_list<js::Callback<void(Scene&)>> assetFragments) {
${body}
}
`;
}

/** Bind feature adapters in the source registry's order, independently of allocation order. */
export function gltfAssetSceneSetupOrder(context: LoweringContext, gaussianSplats: boolean, interactivity: boolean): string[] {
    const file = context.sourceFile(registryModule);
    context.assertFunctionBodyShape(context.functionDeclaration(registryModule, "loadGltfFeatures").declaration, `{
        const used: string[] = json.extensionsUsed ?? [];
        const mods = await Promise.all(_features.flatMap(([t, load]) => ((typeof t === "string" ? used.includes(t) : t(json)) ? [load()] : [])));
        return mods.map((m) => m.default);
    }`, "glTF registry order transport");
    const registry = context.variableInitializer(file, "_features");
    if (!ts.isArrayLiteralExpression(registry)) context.contractError(registry, "Expected the glTF feature registry.");
    const adapters = new Map([
        ["./gltf-feature-gaussian-splatting.js", gaussianSplats ? "gaussian_splat_setup" : undefined],
        ["./gltf-ext-lights-image-based.js", "ibl_scene_setup"],
        ["./gltf-feature-interactivity.js", interactivity ? "interactivity_scene_setup" : undefined],
    ]);
    const seen = new Set<string>(), ordered: string[] = [];
    for (const row of registry.elements) {
        if (!ts.isArrayLiteralExpression(row) || row.elements.length !== 2) context.contractError(row, "Expected a glTF trigger and feature loader.");
        const imports = context.findNodes(row.elements[1]!, (node): node is ts.CallExpression =>
            ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword);
        for (const call of imports) {
            const path = call.arguments[0];
            if (!path || !ts.isStringLiteralLike(path) || !adapters.has(path.text)) continue;
            if (seen.has(path.text)) context.contractError(row, "Repeated glTF setup feature needs distinct native fragment resources.");
            context.assertExpressionShape(row.elements[1]!, `() => import(${JSON.stringify(path.text)})`, "glTF setup feature loader");
            seen.add(path.text);
            const adapter = adapters.get(path.text);
            if (adapter) ordered.push(adapter);
        }
    }
    if (seen.size !== adapters.size) context.contractError(registry, "Missing glTF scene setup feature in the registry.");
    return ordered;
}
