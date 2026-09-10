import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";

/** Source scene setup over prepared row buffers and the synchronous native upload. */
export function lowerGltfGaussianSplatSetup(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-feature-gaussian-splatting.ts";
    const {file, declaration} = context.methodDeclaration(module, "feature.applyAsset");
    const setup = context.unwrapExpression(context.variableInitializer(declaration, "sceneSetup"));
    if (!ts.isArrowFunction(setup) || !ts.isBlock(setup.body))
        context.contractError(declaration, "Expected the Gaussian-splat scene setup body.");
    const body = lowerPinnedBody(file, setup.body.statements, {
        bindings: new Map([["mesh", {cpp: "mesh", type: "opaque"}],
            ["Math.PI", {cpp: String(Math.PI), type: "scalar", staticNumber: Math.PI}]]), calls: new Map(),
        forOf(iterated, element) {
            return iterated === "prepared" && element === "item" ? {range: "prepared",
                bindings: new Map([["item", {cpp: "item", type: "opaque"}]])} : undefined;
        },
        returnValue: (value, lowerer) => value ? lowerer.expression(value) : "",
        statement(statement, lowerer, indent) {
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = context.unwrapExpression(statement.expression);
            if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(expression.left) && context.expressionMatchesShape(expression.left.expression, "mesh.rotation")) {
                const lane = expression.left.name.text;
                if (!["x", "y", "z"].includes(lane)) context.contractError(expression.left, "Unrepresented splat rotation member.");
                return [`${indent}scene.engine->splat_meshes.at(mesh.value).rotation.${lane} = static_cast<float>(${lowerer.expression(expression.right)});`];
            }
            if (!ts.isCallExpression(expression) || !context.expressionMatchesShape(expression.expression, "ready.push")) return undefined;
            const then = expression.arguments[0];
            if (expression.arguments.length !== 1 || !then || !ts.isCallExpression(then) ||
                !ts.isPropertyAccessExpression(then.expression) || then.expression.name.text !== "then" || then.arguments.length !== 1)
                context.contractError(expression, "Expected one Gaussian-splat upload continuation.");
            context.assertExpressionShape(then.expression.expression, "attachParsedSplat(scene, item.name, { data: item.buffer })", "Gaussian-splat upload boundary");
            const callback = then.arguments[0]!;
            if (!ts.isArrowFunction(callback) || callback.parameters.length !== 1 ||
                callback.parameters[0]!.name.getText(file) !== "mesh" || !ts.isBlock(callback.body))
                context.contractError(callback, "Expected the Gaussian-splat rotation continuation.");
            return [`${indent}container.gaussian_splats.push_back([&] {`,
                `${indent}    const auto mesh = attach(scene, item);`,
                ...lowerer.statements(callback.body.statements, indent + "    "), `${indent}}());`];
        },
    });
    return `// ${context.provenance(module, "feature")}
template <typename Prepared, typename Attach>
void setup_gltf_gaussian_splats(Scene& scene, AssetRecord& container, const Prepared& prepared, const Attach& attach) {
${body}
}
`;
}
