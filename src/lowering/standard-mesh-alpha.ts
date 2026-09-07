import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { PinnedNumericLowerer, type PinnedBinding } from "./pinned-numeric-lowerer.js";

/** The pin's shared decision for the draw bucket and the shader feature word. */
export function lowerStandardMeshAlpha(context: LoweringContext, vertexColors = false): string {
    const module = "src/material/standard/standard-renderable.ts";
    const { file, declaration } = context.functionDeclaration(module, "buildStandardMeshRenderables");
    const initializer = context.variableInitializer(declaration, "colorAlphaBlend");
    const variable = initializer.parent;
    const statement = variable.parent.parent;
    const block = statement.parent;
    if (!ts.isVariableDeclaration(variable) || !ts.isVariableStatement(statement) || !ts.isBlock(block)) {
        throw new Error("Pinned Standard colour alpha initializer moved outside its renderable block.");
    }
    const featureStore = block.statements[block.statements.indexOf(statement) + 1];
    if (!featureStore || !ts.isExpressionStatement(featureStore) ||
        !ts.isBinaryExpression(featureStore.expression) ||
        featureStore.expression.operatorToken.kind !== ts.SyntaxKind.BarEqualsToken ||
        featureStore.expression.left.getText(file) !== "features") {
        throw new Error("Pinned Standard colour alpha no longer contributes to the feature word.");
    }
    const bindings = new Map<string, PinnedBinding>([
        ["shadowOutput", { cpp: "shadow_output", type: "bool" }],
        ["mesh.hasVertexAlpha", { cpp: "has_vertex_alpha", type: "bool" }],
        ["hasVertexColor", { cpp: "has_vertex_color", type: "bool" }],
        ["tiFrag?._alphaBlend", { cpp: "instance_alpha", type: "bool" }],
        ["colorAlphaBlend", { cpp: "color_alpha_blend", type: "bool" }],
    ]);
    for (const name of ["VERTEX_ALPHA", "MATERIAL_ALPHA_BLEND"]) {
        const flagFile = context.sourceFile("src/material/standard/standard-flags.ts");
        const expression = context.variableInitializer(flagFile, name);
        // The same numeric lowerer reads the flag's own shift expression.
        const numeric = new PinnedNumericLowerer(flagFile, { bindings: new Map(), calls: new Map() });
        bindings.set(name, { cpp: numeric.expression(expression), type: "scalar" });
    }
    const lowerer = new PinnedNumericLowerer(file, {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
    });
    return `
#define BBLITE_STANDARD_VERTEX_ALPHA 1
inline constexpr bool standard_vertex_colors_enabled = ${vertexColors};
// ${context.provenance(module, "buildStandardMeshRenderables colour alpha")}
inline std::uint32_t standard_color_alpha_features(
    bool shadow_output, bool has_vertex_alpha,
    bool has_vertex_color, bool instance_alpha) {
    const bool color_alpha_blend = ${lowerer.expression(initializer)};
    return static_cast<std::uint32_t>(${lowerer.expression(featureStore.expression.right)});
}
`;
}
