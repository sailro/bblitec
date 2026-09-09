import ts from "typescript";
import { floatLiteral } from "../../cpp-literals.js";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";
import { pinnedRootFlip } from "./shared.js";

/** Pinned parent-map publication and cached world traversal over native records. */
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
    const { declaration: compute } = context.functionDeclaration(module, "computeNodeWorldMatrix");
    const flip = pinnedRootFlip(file);
    const root = context.unwrapExpression(context.moduleScopeConstant(file, "RH_TO_LH_ROOT")!);
    if (!ts.isNewExpression(root) || root.arguments?.length !== 1 || !ts.isArrayLiteralExpression(root.arguments[0]!))
        context.contractError(root, "Expected the glTF root conversion matrix.");
    const rootValues = root.arguments[0].elements.map(value => floatLiteral(context.numericValue(value, file)));
    const bindings = new Map<string, PinnedBinding>([
        ["json", { cpp: "json", type: "opaque" }], ["nodeIdx", { cpp: "node_index", type: "index" }],
        ["parentMap", { cpp: "parents", type: "opaque" }], ["cache", { cpp: "cache", type: "opaque" }],
        ["cached", { cpp: "*cached", type: "f32", absentCpp: "cached == nullptr" }],
        ["node", { cpp: "node", type: "opaque" }], ["localBuf", { cpp: "local_buffer", type: "f32" }],
        ["parentWorld", { cpp: "parent_world", type: "f32" }], ["world", { cpp: "world", type: "f32" }],
        ["RH_TO_LH_ROOT", { cpp: "gltf_root_conversion", type: "f32" }],
    ]);
    const worldBody = lowerPinnedBody(file, compute.body!.statements, {
        bindings,
        calls: new Map([
            ["findParent", args => `find_gltf_parent(${args.join(", ")})`],
            ["computeNodeWorldMatrix", args => {
                if (args.length !== 4) context.contractError(compute, "Expected glTF world traversal arguments.");
                return `compute_gltf_node_world(${args[0]}, static_cast<std::size_t>(${args[1]}), ${args[2]}, ${args[3]})`;
            }],
        ]),
        expression(node, lowerer) {
            if (context.expressionMatchesShape(node, "json.nodes[nodeIdx]")) return 'gltf_array_or_empty(json, "nodes").at(node_index).as_object()';
            if (ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "cache.get") && node.arguments.length === 1)
                return `cache.get(static_cast<std::size_t>(${lowerer.expression(node.arguments[0]!)}))`;
            if (ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "cache.set") && node.arguments.length === 2)
                return `cache.set(static_cast<std::size_t>(${lowerer.expression(node.arguments[0]!)}), ${lowerer.expression(node.arguments[1]!)})`;
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name)) return undefined;
                const name = variable.name.text, initializer = variable.initializer;
                if (name === "localBuf" && !initializer) return [`${indent}Matrix local_buffer{};`];
                if (!initializer) return undefined;
                if (name === "cached") return [`${indent}const Matrix* cached = ${lowerer.expression(initializer)};`];
                if (name === "node") return [`${indent}GltfWorldVisit visit(cache, node_index);`, `${indent}const auto& node = ${lowerer.expression(initializer)};`];
                if (name === "parentWorld") return [`${indent}const Matrix parent_world = ${lowerer.expression(initializer)};`];
                if (name === "world") {
                    context.assertExpressionShape(context.unwrapExpression(initializer), "new F32(16)", "glTF cached world allocation");
                    return [`${indent}Matrix world{};`];
                }
            }
            if (ts.isIfStatement(statement) && context.expressionMatchesShape(statement.expression, "node.matrix"))
                return [`${indent}local_buffer = local_matrix(node);`];
            if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
                const call = statement.expression;
                if (context.expressionMatchesShape(call.expression, "mat4MultiplyInto")) {
                    if (call.arguments.length !== 6 || [1, 3, 5].some(index => context.numericValue(call.arguments[index]!, file) !== 0))
                        context.contractError(call, "Expected complete glTF world matrix multiplication.");
                    return [`${indent}${lowerer.expression(call.arguments[0]!)} = upstream::matrix_product(${lowerer.expression(call.arguments[2]!)}, ${lowerer.expression(call.arguments[4]!)});`];
                }
            }
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
struct GltfWorldCache {
    std::vector<Matrix> values;
    std::vector<std::uint8_t> states;
    explicit GltfWorldCache(std::size_t count) : values(count), states(count) {}
    const Matrix* get(std::size_t index) const { return states.at(index) == 2 ? &values.at(index) : nullptr; }
    void set(std::size_t index, const Matrix& value) { values.at(index) = value; states.at(index) = 2; }
};
struct GltfWorldVisit {
    GltfWorldCache& cache;
    std::size_t index;
    GltfWorldVisit(GltfWorldCache& values, std::size_t node) : cache(values), index(node) {
        if (cache.states.at(index) == 1) throw std::runtime_error("glTF node hierarchy contains a cycle.");
        cache.states.at(index) = 1;
    }
    GltfWorldVisit(const GltfWorldVisit&) = delete;
    GltfWorldVisit& operator=(const GltfWorldVisit&) = delete;
    ~GltfWorldVisit() { if (cache.states.at(index) == 1) cache.states.at(index) = 0; }
};
constexpr Matrix gltf_root_conversion{${rootValues.join(", ")}};
// ${context.provenance(module, "computeNodeWorldMatrix")}
Matrix compute_gltf_node_world(const JsonObject& json, std::size_t node_index, const std::vector<int>& parents, GltfWorldCache& cache) {
${worldBody}
}
Matrix gltf_document_world(Matrix value) {
    for (std::size_t column = 0; column < 4; ++column) value[column * 4 + ${flip.lane}] *= ${floatLiteral(flip.sign)};
    return value;
}`;
}
