import ts from "typescript";
import type { JsonObject } from "./json-fields.js";
import { gltfFeatureModules, pinnedGltfFeatureId } from "./gltf-mesh-plan.js";
import {
    type LoweringContext,
    sharedPinnedContext,
    unexportedDeclarationText,
} from "./lowering/context.js";
import {
    createJavaScriptFunction,
    stripAsyncAndAwait,
    transpileCommonJs,
} from "./typescript-transpile.js";

type GltfFeatureSelection = (document: JsonObject) => boolean;
let thinInstances: GltfFeatureSelection | undefined;

/** Run the pinned loader gate and registry selection before entry projection. */
export function pinnedGltfThinInstanceSelection(
    source?: LoweringContext,
): GltfFeatureSelection {
    if (!source && thinInstances) return thinInstances;
    const context: LoweringContext = source ?? sharedPinnedContext();
    const module = "src/loader-gltf/gltf-feature-registry.ts";
    const file = context.sourceFile(module);
    const registry = context.variableInitializer(file, "_features");
    if (!ts.isArrayLiteralExpression(registry))
        context.contractError(registry, "Expected the glTF feature registry.");
    const rows = registry.elements.filter(
        (row) =>
            context.findNodes(
                row,
                (node): node is ts.CallExpression =>
                    ts.isCallExpression(node) &&
                    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
                    node.arguments.length === 1 &&
                    ts.isStringLiteralLike(node.arguments[0]!) &&
                    context.store.resolveImport(
                        module,
                        node.arguments[0].text,
                    ) === gltfFeatureModules.gpuInstancing,
            ).length > 0,
    );
    const row = rows[0];
    if (
        rows.length !== 1 ||
        !row ||
        !ts.isArrayLiteralExpression(row) ||
        row.elements.length !== 2
    )
        context.contractError(
            registry,
            "Expected one glTF thin-instance registry row.",
        );
    const trigger = row.elements[0]!;
    if (!ts.isStringLiteralLike(trigger))
        context.contractError(
            trigger,
            "Expected the pinned glTF thin-instance extension trigger.",
        );
    context.assertExpressionShape(
        row.elements[1]!,
        '() => import("./gltf-feature-gpu-instancing.js")',
        "glTF thin-instance feature loader",
    );
    const id = pinnedGltfFeatureId(context, gltfFeatureModules.gpuInstancing);
    const loaderModule = "src/loader-gltf/load-gltf.ts";
    const loader = context.sourceFile(loaderModule);
    const load = context.functionDeclaration(
        loaderModule,
        "loadGltf",
    ).declaration;
    const statements = load.body!.statements;
    const discovery = statements.findIndex(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
                (declaration) =>
                    ts.isIdentifier(declaration.name) &&
                    declaration.name.text === "featureRegistry",
            ),
    );
    const features = statements[discovery + 1];
    if (
        discovery < 0 ||
        !features ||
        !ts.isVariableStatement(features) ||
        features.declarationList.declarations.length !== 1 ||
        features.declarationList.declarations[0]!.name.getText(loader) !==
            "features"
    )
        context.contractError(
            load,
            "Expected the glTF registry discovery boundary.",
        );
    const declarations = [
        [loaderModule, "assetUsesGltfFeatures"],
        ["src/loader-gltf/gltf-parser.ts", "anyPrimitive"],
        ["src/loader-gltf/gltf-parser.ts", "needsOrmComposite"],
        ["src/loader-gltf/gltf-parser.ts", "getTextureImageIndex"],
        ["src/math/mat4-determinant3.ts", "mat4Determinant3"],
        [module, "loadGltfFeatures"],
    ] as const;
    // Imports carry only feature identity here. Promise.all transports this
    // already available row synchronously; both source predicates run intact.
    const selection = createJavaScriptFunction(
        "Promise",
        stripAsyncAndAwait(
            transpileCommonJs(
                [
                    `const _features = [[${trigger.getText(file)}, () => ({default: {id: ${JSON.stringify(id)}}})]];`,
                    ...declarations.map(([path, name]) =>
                        unexportedDeclarationText(
                            context.functionDeclaration(path, name).declaration,
                        ),
                    ),
                    "function importGltfFeatureRegistry() { return {loadGltfFeatures}; }",
                    "return function select(json) {",
                    ...statements
                        .slice(discovery, discovery + 2)
                        .map((statement) => statement.getText(loader)),
                    `return features.some(feature => feature.id === ${JSON.stringify(id)});`,
                    "};",
                ].join("\n"),
                module,
            ),
        ),
    )({ all: (values: unknown[]) => values });
    if (typeof selection !== "function")
        context.contractError(
            load,
            "Expected a callable glTF feature selection.",
        );
    const result = selection as GltfFeatureSelection;
    if (!source) thinInstances = result;
    return result;
}
