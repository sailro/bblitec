import ts from "typescript";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";
import { identifierParameters, refuseNode, topLevelFunction, unwrapExpression } from "./shared.js";

/** Lower the complete local-matrix branch and its numeric writer. */
export function lowerLocalMatrixCpp(parserFile: ts.SourceFile, composeFile: ts.SourceFile): string {
    const symbol = "computeNodeWorldMatrix", declaration = topLevelFunction(parserFile, symbol);
    const statements = declaration.body.statements;
    const start = statements.findIndex(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(variable => ts.isIdentifier(variable.name) && variable.name.text === "localBuf"));
    if (start < 0 || !statements[start + 1] || !ts.isIfStatement(statements[start + 1]!))
        refuseNode(symbol, parserFile, declaration, "has no local matrix branch");
    const compose = topLevelFunction(composeFile, "mat4ComposeInto");
    const composeParameters = identifierParameters("mat4ComposeInto", composeFile, compose);
    if (composeParameters.length !== 12) refuseNode("mat4ComposeInto", composeFile, compose, "has an unrepresented parameter list");
    const writer = lowerPinnedBody(composeFile, compose.body.statements, {
        bindings: new Map(composeParameters.map((name, index) => [name, { cpp: name, type: index === 0 ? "f32" : "scalar" }])), calls: new Map(),
    });
    const bindings = new Map<string, PinnedBinding>([
        ["node", { cpp: "node", type: "opaque" }], ["localBuf", { cpp: "local_buffer", type: "f32" }],
    ]);
    const property = (node: ts.Expression): string | undefined => ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) && node.expression.text === "node" ? `optional(node, ${JSON.stringify(node.name.text)})` : undefined;
    const body = lowerPinnedBody(parserFile, [statements[start]!, statements[start + 1]!, ts.factory.createReturnStatement(ts.factory.createIdentifier("localBuf"))], {
        bindings,
        calls: new Map([["mat4ComposeInto", args => `gltf_compose_into(${args.join(", ")})`]]),
        expression(node, lowerer) {
            const pointer = property(node);
            if (pointer) return pointer;
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
                const source = property(unwrapExpression(node.left)), fallback = unwrapExpression(node.right);
                if (source && ts.isArrayLiteralExpression(fallback))
                    return `gltf_number_array(${source}, {${fallback.elements.map(value => lowerer.expression(value)).join(", ")}})`;
            }
            if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "F32" && node.arguments?.length === 1) {
                const source = property(unwrapExpression(node.arguments[0]!));
                if (source) return `gltf_matrix_from_json(${source})`;
            }
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isIfStatement(statement)) {
                const pointer = property(unwrapExpression(statement.expression));
                if (!pointer) return undefined;
                return [`${indent}if (${pointer} && ${pointer}->truthy()) {`,
                    ...lowerer.statements(ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement], indent + "    "),
                    ...(statement.elseStatement ? [`${indent}} else {`,
                        ...lowerer.statements(ts.isBlock(statement.elseStatement) ? statement.elseStatement.statements : [statement.elseStatement], indent + "    ")] : []), `${indent}}`];
            }
            if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
                ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === "mat4ComposeInto") {
                const call = statement.expression, offset = call.arguments[1] && unwrapExpression(call.arguments[1]);
                if (call.arguments.length !== composeParameters.length || !offset || !ts.isNumericLiteral(offset) || Number(offset.text) !== 0)
                    refuseNode(symbol, parserFile, call, "does not compose into a complete local matrix");
            }
            if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
            const variable = statement.declarationList.declarations[0]!;
            if (!ts.isIdentifier(variable.name)) return undefined;
            const name = variable.name.text, initializer = variable.initializer && unwrapExpression(variable.initializer);
            if (name === "localBuf" && !initializer) return [`${indent}Matrix local_buffer{};`];
            if (initializer && ts.isBinaryExpression(initializer) && initializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && property(unwrapExpression(initializer.left))) {
                bindings.set(name, { cpp: name, type: "f64-buffer" });
                return [`${indent}const GltfNumberArray ${name} = ${lowerer.expression(initializer)};`];
            }
            if (initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === "getLoaderTmpLocal" && initializer.arguments.length === 0) {
                bindings.set(name, { cpp: name, type: "f32" });
                return [`${indent}Matrix ${name}{};`];
            }
            return undefined;
        },
        returnValue: (value, lowerer) => lowerer.expression(value!),
    });
    return `struct GltfNumberArray {
    std::vector<double> values;
    double operator[](std::size_t index) const { return index < values.size() ? values[index] : std::numeric_limits<double>::quiet_NaN(); }
};
GltfNumberArray gltf_number_array(const ts::JsonValue* source, std::vector<double> fallback) {
    if (!source || source->is_null()) return GltfNumberArray{std::move(fallback)};
    GltfNumberArray result;
    for (const auto& value : source->as_array()) result.values.push_back(value.as_number());
    return result;
}
Matrix gltf_matrix_from_json(const ts::JsonValue* source) {
    if (!source || source->as_array().size() != 16) throw std::runtime_error("glTF node matrix must have 16 values.");
    Matrix result{};
    for (std::size_t index = 0; index < result.size(); ++index) result[index] = static_cast<float>(source->as_array()[index].as_number());
    return result;
}
// ${composeFile.fileName}#mat4ComposeInto
void gltf_compose_into(${composeParameters.map((name, index) => `${index === 0 ? "Matrix&" : "double"} ${name}`).join(", ")}) {
${writer}
}
// ${parserFile.fileName}#computeNodeWorldMatrix
Matrix local_matrix(const JsonObject& node) {
${body}
}`;
}
