import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";

/** The complete node-rest construction section of parseAnimationData. */
export function lowerGltfAnimationNodeRest(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-animation.ts";
    const { file, declaration } = context.functionDeclaration(module, "parseAnimationData");
    const statements = declaration.body!.statements;
    const declares = (statement: ts.Statement, name: string) => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(variable => ts.isIdentifier(variable.name) && variable.name.text === name);
    const start = statements.findIndex(statement => declares(statement, "nodeCount"));
    const end = statements.findIndex(statement => declares(statement, "nodeToMeshIndices"));
    if (start < 0 || end <= start) context.contractError(declaration, "Expected the complete animation node-rest section.");
    const bindings = new Map<string, PinnedBinding>();
    const jsonLocals = new Set<string>();
    const property = (expression: ts.Expression): { owner: string; key: string } | undefined => {
        const node = context.unwrapExpression(expression);
        return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && jsonLocals.has(node.expression.text) && bindings.get(node.expression.text)?.type === "opaque"
            ? { owner: node.expression.text, key: node.name.text } : undefined;
    };
    const fields = ["parentIdx", "_matrix", "tx", "ty", "tz", "rx", "ry", "rz", "rw", "sx", "sy", "sz"];
    const body = lowerPinnedBody(file, statements.slice(start, end), {
        bindings, calls: new Map(),
        expression(node, lowerer) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
                context.expressionMatchesShape(node.left, "json.nodes?.length"))
                return `(optional(document, "nodes") && !optional(document, "nodes")->is_null() ? ` +
                    `static_cast<double>(required(document, "nodes").as_array().size()) : ${lowerer.expression(node.right)})`;
            const member = property(node);
            if (member) return `optional(${member.owner}, ${JSON.stringify(member.key)})`;
            if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && bindings.get(node.expression.text)?.type === "f64-buffer")
                return `${node.expression.text}.at(gltf_checked_index(static_cast<double>(${lowerer.expression(node.argumentExpression)})))`;
            if (ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "findParent")) {
                if (node.arguments.length !== 2) context.contractError(node, "Expected animation parent lookup arguments.");
                context.assertExpressionShape(node.arguments[0]!, "parentMap", "Animation parent map");
                return `find_parent(static_cast<double>(${lowerer.expression(node.arguments[1]!)}))`;
            }
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                const name = variable.name.text, initializer = context.unwrapExpression(variable.initializer);
                if (ts.isArrayLiteralExpression(initializer) && variable.type?.getText(file) === "NodeRest[]") {
                    if (initializer.elements.length) context.contractError(initializer, "Expected empty node-rest storage.");
                    bindings.set(name, { cpp: name, type: "opaque" });
                    return [`${indent}std::vector<GltfNodeRest> ${name};`];
                }
                if (ts.isElementAccessExpression(initializer) && context.expressionMatchesShape(initializer.expression, "json.nodes")) {
                    const value = lowerer.expression(initializer.argumentExpression);
                    jsonLocals.add(name);
                    bindings.set(name, { cpp: name, type: "opaque" });
                    return [`${indent}const auto& ${name} = required(document, "nodes").as_array().at(gltf_checked_index(static_cast<double>(${value}))).as_object();`];
                }
                if (ts.isBinaryExpression(initializer) && initializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && property(initializer.left)) {
                    const fallback = context.unwrapExpression(initializer.right);
                    if (!ts.isArrayLiteralExpression(fallback)) context.contractError(fallback, "Expected an animation TRS array default.");
                    const source = lowerer.expression(initializer.left);
                    const values = fallback.elements.map(element => lowerer.expression(element)).join(", ");
                    bindings.set(name, { cpp: name, type: "f64-buffer" });
                    return [`${indent}const auto ${name} = gltf_rest_numbers<${fallback.elements.length}>(${source}, [&]() { return std::array<double, ${fallback.elements.length}>{${values}}; });`];
                }
            }
            if (ts.isExpressionStatement(statement)) {
                const call = context.unwrapExpression(statement.expression);
                if (!ts.isCallExpression(call) || !context.expressionMatchesShape(call.expression, "nodes.push")) return undefined;
                const value = call.arguments[0];
                if (call.arguments.length !== 1 || !value || !ts.isObjectLiteralExpression(value))
                    context.contractError(call, "Expected a node-rest record append.");
                const entries = new Map<string, ts.Expression>();
                for (const property of value.properties) {
                    if (!ts.isPropertyAssignment(property)) context.contractError(property, "Expected a named node-rest field.");
                    const key = context.propertyName(property.name);
                    if (!key || !fields.includes(key) || entries.has(key)) context.contractError(property, "Unsupported node-rest field.");
                    entries.set(key, property.initializer);
                }
                if (entries.size !== fields.length) context.contractError(value, "Expected all node-rest fields.");
                // Preserve initializer evaluation order independently of native record layout.
                return [`${indent}{`, `${indent}    GltfNodeRest rest;`,
                    ...[...entries].map(([key, expression]) => `${indent}    rest.${key === "_matrix" ? "matrix" : key} = ${lowerer.expression(expression)};`),
                    `${indent}    nodes.push_back(rest);`, `${indent}}`];
            }
            return undefined;
        },
    });
    return `struct GltfNodeRest {
    double parentIdx = -1;
    const ts::JsonValue* matrix = nullptr;
    double tx = 0, ty = 0, tz = 0, rx = 0, ry = 0, rz = 0, rw = 0, sx = 0, sy = 0, sz = 0;
};
template<std::size_t N>
struct GltfRestNumbers {
    const JsonArray* source;
    std::array<double, N> fallback;
    double at(std::size_t index) const { return source ? source->at(index).as_number() : fallback.at(index); }
};
template<std::size_t N, class Fallback>
GltfRestNumbers<N> gltf_rest_numbers(const ts::JsonValue* source, Fallback fallback) {
    return source && !source->is_null() ? GltfRestNumbers<N>{&source->as_array(), {}} : GltfRestNumbers<N>{nullptr, fallback()};
}
// ${context.provenance(module, "parseAnimationData")}
template<class FindParent>
std::vector<GltfNodeRest> gltf_animation_node_rest(const JsonObject& document, FindParent find_parent) {
${body}
    return nodes;
}`;
}
