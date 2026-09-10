import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";
import { identifierParameters } from "./shared.js";

/** Source inverse-bind selection and identity initialization, with accessor storage adapters. */
export function lowerGltfInverseBindMatrices(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-animation.ts";
    const { file, declaration } = context.functionDeclaration(module, "resolveIBMs");
    const names = identifierParameters("resolveIBMs", file, declaration);
    if (names.length !== 3) context.contractError(declaration, "Expected document, binary and skin parameters.");
    const [json, binary, skin] = names;
    const bindings = new Map<string, PinnedBinding>([
        [`${skin}.joints.length`, { cpp: 'static_cast<double>(required(skin, "joints").as_array().size())', type: "scalar" }],
        [`${skin}.inverseBindMatrices`, { cpp: 'gltf_json_number(optional(skin, "inverseBindMatrices"))', type: "scalar",
            absentCpp: 'optional(skin, "inverseBindMatrices") == nullptr' }],
    ]);
    const accessorResults = new Set<string>();
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings, calls: new Map(),
        expression(node, lowerer) {
            if (ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "resolveAccessor")) {
                if (node.arguments.length !== 3) context.contractError(node, "Expected skin accessor arguments.");
                context.assertExpressionShape(node.arguments[0]!, json!, "Skin accessor document");
                context.assertExpressionShape(node.arguments[1]!, binary!, "Skin accessor binary");
                return `resolve_accessor(${lowerer.expression(node.arguments[2]!)})`;
            }
            if (ts.isNewExpression(node) && context.expressionMatchesShape(node.expression, "F32") && node.arguments?.length === 3) {
                const source = context.unwrapExpression(node.arguments[0]!);
                const buffer = ts.isPropertyAccessExpression(source) && source.name.text === "buffer" ? context.unwrapExpression(source.expression) : undefined;
                const owner = buffer && ts.isPropertyAccessExpression(buffer) && buffer.name.text === "_data" ? buffer.expression : undefined;
                if (!owner || !ts.isIdentifier(owner) || !accessorResults.has(owner.text) || bindings.get(owner.text)?.type !== "opaque")
                    context.contractError(node, "Expected a resolved skin accessor view.");
                context.assertExpressionShape(node.arguments[1]!, `${owner.text}._data.byteOffset`, "Skin view offset");
                return `float32_view(${lowerer.expression(owner)}, ${lowerer.expression(node.arguments[2]!)})`;
            }
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
            const variable = statement.declarationList.declarations[0]!;
            if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
            const initializer = context.unwrapExpression(variable.initializer);
            if (!ts.isCallExpression(initializer) || !context.expressionMatchesShape(initializer.expression, "resolveAccessor")) return undefined;
            const value = lowerer.expression(initializer);
            const name = variable.name.text;
            accessorResults.add(name);
            bindings.set(name, { cpp: name, type: "opaque" });
            return [`${indent}const auto ${name} = ${value};`];
        },
        returnValue: (expression, lowerer) => lowerer.expression(expression!),
    });
    return `// ${context.provenance(module, "resolveIBMs")}
template<class ResolveAccessor, class Float32View>
std::vector<float> gltf_inverse_bind_matrices(const JsonObject& skin, ResolveAccessor resolve_accessor, Float32View float32_view) {
${body}
}`;
}
