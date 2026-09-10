import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";

/** Pinned parent-map publication over native records. */
export function lowerGltfHierarchy(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-parser.ts";
    const { file, declaration: parentMap } = context.functionDeclaration(module, "buildParentMap");
    const mapBindings = new Map<string, PinnedBinding>([
        ["json", { cpp: "json", type: "opaque" }],
        ["parentMap", { cpp: "parents", type: "opaque" }],
        ["nodes", { cpp: "nodes", type: "opaque" }],
        ["nodes.length", { cpp: "static_cast<std::int64_t>(nodes.size())", type: "index" }],
        ["children", { cpp: "children", type: "opaque", absentCpp: "(!children || !children->truthy())" }],
    ]);
    const mapBody = lowerPinnedBody(file, parentMap.body!.statements, {
        bindings: mapBindings, calls: new Map(), booleanAnd: true, booleanOr: true,
        forOf(iterated, element) {
            return iterated === "children" ? { range: "children->as_array()",
                bindings: new Map([[element, { cpp: `${element}.as_number()`, type: "scalar" }]]) } : undefined;
        },
        expression(node, lowerer) {
            if (context.expressionMatchesShape(node, "json.nodes ?? []")) return 'gltf_array_or_empty(json, "nodes")';
            if (ts.isPropertyAccessExpression(node) && node.name.text === "children" && ts.isElementAccessExpression(node.expression) &&
                context.expressionMatchesShape(node.expression.expression, "nodes"))
                return `optional(nodes.at(static_cast<std::size_t>(${lowerer.expression(node.expression.argumentExpression)})).as_object(), "children")`;
            if (ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "parentMap.set") && node.arguments.length === 2)
                return `set_gltf_parent(parents, static_cast<double>(${lowerer.expression(node.arguments[0]!)}), static_cast<double>(${lowerer.expression(node.arguments[1]!)}))`;
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
            const variable = statement.declarationList.declarations[0]!;
            if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
            const name = variable.name.text;
            if (name === "parentMap") {
                context.assertExpressionShape(variable.initializer, "new Map<number, number>()", "glTF parent map allocation");
                return [`${indent}std::vector<int> parents(gltf_array_or_empty(json, "nodes").size(), -1);`];
            }
            if (name === "nodes") return [`${indent}const auto& nodes = ${lowerer.expression(variable.initializer)};`];
            if (name === "children") return [`${indent}const auto* children = ${lowerer.expression(variable.initializer)};`];
            return undefined;
        },
        returnValue: (value, lowerer) => lowerer.expression(value!),
    });
    const { declaration: findParent } = context.functionDeclaration(module, "findParent");
    const findBody = lowerPinnedBody(file, findParent.body!.statements, {
        bindings: new Map([["childIdx", { cpp: "child_index", type: "scalar" }]]), calls: new Map(),
        expression(node, lowerer) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
                context.expressionMatchesShape(node.left, "parentMap.get(childIdx)"))
                return `(parents.at(static_cast<std::size_t>(child_index)) >= 0 ? double(parents.at(static_cast<std::size_t>(child_index))) : ${lowerer.expression(node.right)})`;
            return undefined;
        }, returnValue: (value, lowerer) => lowerer.expression(value!),
    });
    return `// ${context.provenance(module, "buildParentMap")}
void set_gltf_parent(std::vector<int>& parents, double child, double parent) {
    if (!std::isfinite(child) || child < 0 || std::floor(child) != child || child >= double(parents.size()) ||
        !std::isfinite(parent) || parent < 0 || std::floor(parent) != parent || parent >= double(parents.size()) || parent > double(std::numeric_limits<int>::max()))
        throw std::runtime_error("Invalid glTF parent index.");
    parents.at(static_cast<std::size_t>(child)) = static_cast<int>(parent);
}
std::vector<int> build_gltf_parents(const JsonObject& json) {
${mapBody}
}
double find_gltf_parent(const std::vector<int>& parents, double child_index) {
${findBody}
}
void validate_gltf_parents(const std::vector<int>& parents) {
    std::vector<std::uint8_t> states(parents.size());
    for (std::size_t start = 0; start < parents.size(); ++start) {
        auto node = static_cast<int>(start);
        while (node >= 0 && states.at(static_cast<std::size_t>(node)) == 0) {
            states.at(static_cast<std::size_t>(node)) = 1;
            node = parents.at(static_cast<std::size_t>(node));
        }
        if (node >= 0 && states.at(static_cast<std::size_t>(node)) == 1)
            throw std::runtime_error("glTF node hierarchy contains a cycle.");
        node = static_cast<int>(start);
        while (node >= 0 && states.at(static_cast<std::size_t>(node)) == 1) {
            states.at(static_cast<std::size_t>(node)) = 2;
            node = parents.at(static_cast<std::size_t>(node));
        }
    }
}
`;
}
