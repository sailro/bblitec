import ts from "typescript";
import { LoweringContext } from "./context.js";
import { PinnedNumericLowerer, type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedNumericConstant } from "./pinned-numeric-constant.js";
import { javascriptModuleUrl } from "../data-url.js";
import { transpileForBrowser } from "../typescript-transpile.js";
import { sharedUpstreamStore } from "../upstream-source.js";

const MODULE = "src/material/standard/standard-renderable.ts";
const FLAG_MODULE = "src/material/standard/standard-flags.ts";

/** The same pinned expressions feed the generation evaluator and C++ lowerer. */
function alphaExpressions(context: LoweringContext): {
    file: ts.SourceFile;
    initializer: ts.Expression;
    features: ts.Expression;
} {
    const { file, declaration } = context.functionDeclaration(MODULE, "buildStandardMeshRenderables");
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
    return { file, initializer, features: featureStore.expression.right };
}

function alphaFlags(context: LoweringContext): ReadonlyMap<string, number> {
    return new Map(["VERTEX_ALPHA", "MATERIAL_ALPHA_BLEND"].map((name) =>
        [name, pinnedNumericConstant(context, FLAG_MODULE, name)]));
}

export type StandardMeshAlphaDecision = (
    shadowOutput: boolean,
    hasVertexAlpha: boolean,
    hasVertexColor: boolean,
    instanceAlpha: boolean,
) => { colorAlphaBlend: boolean; features: number };

let executedAlpha: Promise<StandardMeshAlphaDecision> | undefined;

/** Execute the pin's local decision without constructing a renderable or GPU. */
export function pinnedStandardMeshAlpha(): Promise<StandardMeshAlphaDecision> {
    if (executedAlpha) return executedAlpha;
    const context = new LoweringContext(sharedUpstreamStore());
    const { file, initializer, features } = alphaExpressions(context);
    const source = `
${[...alphaFlags(context)].map(([name, value]) => `const ${name} = ${value};`).join("\n")}
export function decide(shadowOutput, hasVertexAlpha, hasVertexColor, instanceAlpha) {
    const mesh = { hasVertexAlpha };
    const tiFrag = { _alphaBlend: instanceAlpha };
    const colorAlphaBlend = ${initializer.getText(file)};
    return { colorAlphaBlend, features: ${features.getText(file)} };
}
`;
    executedAlpha = import(javascriptModuleUrl(transpileForBrowser(source, MODULE)))
        .then((module: { decide: StandardMeshAlphaDecision }) => module.decide);
    return executedAlpha;
}

/** The pin's shared decision for the draw bucket and the shader feature word. */
export function lowerStandardMeshAlpha(context: LoweringContext, vertexColors = false): string {
    const { file, initializer, features } = alphaExpressions(context);
    const bindings = new Map<string, PinnedBinding>([
        ["shadowOutput", { cpp: "shadow_output", type: "bool" }],
        ["mesh.hasVertexAlpha", { cpp: "has_vertex_alpha", type: "bool" }],
        ["hasVertexColor", { cpp: "has_vertex_color", type: "bool" }],
        ["tiFrag?._alphaBlend", { cpp: "instance_alpha", type: "bool" }],
        ["colorAlphaBlend", { cpp: "color_alpha_blend", type: "bool" }],
    ]);
    for (const [name, value] of alphaFlags(context)) {
        bindings.set(name, { cpp: `${value}u`, type: "scalar" });
    }
    const lowerer = new PinnedNumericLowerer(file, {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
    });
    return `
#define BBLITE_STANDARD_VERTEX_ALPHA 1
inline constexpr bool standard_vertex_colors_enabled = ${vertexColors};
// ${context.provenance(MODULE, "buildStandardMeshRenderables colour alpha")}
inline std::uint32_t standard_color_alpha_features(
    bool shadow_output, bool has_vertex_alpha,
    bool has_vertex_color, bool instance_alpha) {
    const bool color_alpha_blend = ${lowerer.expression(initializer)};
    return static_cast<std::uint32_t>(${lowerer.expression(features)});
}
`;
}
