import ts from "typescript";
import { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding, PinnedNumericLowerer } from "./pinned-numeric-lowerer.js";

/** Parent assignment, child traversal entries and root ordering follow loadBabylon. */
export function lowerBabylonHierarchy(context: LoweringContext): string {
    const module = "src/loader-babylon/load-babylon.ts";
    const { file, declaration } = context.functionDeclaration(module, "loadBabylon");
    const loops = context.findNodes(declaration, (node): node is ts.ForOfStatement =>
        ts.isForOfStatement(node) && context.findNodes(node, (child): child is ts.CallExpression =>
            ts.isCallExpression(child) && context.expressionMatchesShape(child.expression, "childNodeIds.add")).length > 0);
    const loop = loops[0];
    if (loops.length !== 1 || !loop) context.contractError(declaration, "Expected the Babylon hierarchy pass.");
    const rootDeclaration = context.variableInitializer(declaration, "rootMeshes").parent.parent.parent;
    if (!ts.isVariableStatement(rootDeclaration) || rootDeclaration.parent !== declaration.body)
        context.contractError(declaration, "Expected root filtering after hierarchy construction.");
    const rootStatements = declaration.body!.statements.slice(declaration.body!.statements.indexOf(rootDeclaration));
    const bindings = new Map<string, PinnedBinding>([
        ["md.parentId", { cpp: 'string_or(md, "parentId")', type: "opaque", absentCpp: 'string_or(md, "parentId").empty()' }],
        ["parent", { cpp: "parent", type: "opaque", absentCpp: "parent == invalid_handle" }],
        ["childNode", { cpp: "child_node", type: "opaque", absentCpp: "child_node == invalid_handle" }],
        ["childMeshes.length", { cpp: "child_meshes.size()", type: "index" }],
    ]);
    const expression = (node: ts.Expression, lowerer: PinnedNumericLowerer): string | undefined => {
        if (context.expressionMatchesShape(node, "md.isVisible === false"))
            return '(md.contains("isVisible") && md.at("isVisible") == false)';
        if (context.expressionMatchesShape(node, "md.id")) return 'string_or(md, "id")';
        if (context.expressionMatchesShape(node, "m.id")) return "nodes.at(m).id";
        if (ts.isCallExpression(node) && node.arguments.length === 1) {
            const key = (): string => lowerer.expression(node.arguments[0]!);
            if (context.expressionMatchesShape(node.expression, "childNodeIds.has")) return `child_node_ids.contains(${key()})`;
            if (context.expressionMatchesShape(node.expression, "meshesByNodeId.has")) return `meshes_by_id.contains(${key()})`;
            if (context.expressionMatchesShape(node.expression, "nodeMap.get")) return `find_babylon_node(node_map, ${key()})`;
        }
        return undefined;
    };
    const body = lowerPinnedBody(file, [loop, ...rootStatements], {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true, expression,
        forOf(iterated, element) {
            const range = iterated === "data.meshes" ? "mesh_sources" : iterated === "childMeshes" ? "child_meshes" : undefined;
            return range ? { range, bindings: new Map([[element, { cpp: element, type: "opaque" }]]) } : undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                const name = variable.name.text;
                if (name === "parent" || name === "childNode")
                    return [`${indent}const auto ${name === "parent" ? "parent" : "child_node"} = ${lowerer.expression(variable.initializer)};`];
                if (name === "childMeshes") {
                    context.assertExpressionShape(variable.initializer, "meshesByNodeId.get(md.id) ?? []", "Babylon child mesh lookup");
                    return [`${indent}const auto found = meshes_by_id.find(string_or(md, "id"));`,
                        `${indent}const auto child_meshes = found != meshes_by_id.end() ? found->second : std::vector<std::size_t>{};`];
                }
                if (name === "rootMeshes") {
                    const filter = context.unwrapExpression(variable.initializer);
                    if (!ts.isCallExpression(filter) || !context.expressionMatchesShape(filter.expression, "allMeshes.filter") || filter.arguments.length !== 1 ||
                        !ts.isArrowFunction(filter.arguments[0]!) || ts.isBlock(filter.arguments[0]!.body))
                        context.contractError(filter, "Expected the mesh root filter.");
                    const predicate = filter.arguments[0]!;
                    if (predicate.parameters.length !== 1 || !ts.isIdentifier(predicate.parameters[0]!.name) || predicate.parameters[0]!.name.text !== "m")
                        context.contractError(predicate, "Expected the mesh root filter parameter.");
                    return [`${indent}std::vector<std::size_t> root_meshes;`,
                        `${indent}for (const auto m : all_meshes) if (${lowerer.expression(predicate.body as ts.Expression)}) root_meshes.push_back(m);`];
                }
                if (name === "rootTransformNodes") {
                    context.assertExpressionShape(variable.initializer, "[]", "Babylon container root list");
                    return [`${indent}std::vector<std::size_t> root_containers;`];
                }
            }
            if (ts.isForOfStatement(statement) && context.expressionMatchesShape(statement.expression, "nodeMap")) {
                if (!ts.isVariableDeclarationList(statement.initializer) || statement.initializer.declarations.length !== 1)
                    context.contractError(statement, "Expected node map iteration.");
                const name = statement.initializer.declarations[0]!.name;
                if (!ts.isArrayBindingPattern(name) || name.elements.length !== 2 || !ts.isBlock(statement.statement))
                    context.contractError(statement, "Expected the node map's ID and node bindings.");
                const names = name.elements.map(element => {
                    if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) context.contractError(element, "Expected a node map binding.");
                    bindings.set(element.name.text, { cpp: element.name.text, type: "opaque" });
                    return element.name.text;
                });
                return [`${indent}for (const auto& [${names.join(", ")}] : node_map) {`,
                    ...lowerer.statements(statement.statement.statements, indent + "    "), `${indent}}`];
            }
            if (ts.isReturnStatement(statement)) {
                if (!statement.expression || !ts.isObjectLiteralExpression(statement.expression)) context.contractError(statement, "Expected the Babylon asset result.");
                const entities = context.unwrapExpression(context.propertyInitializer(statement.expression, "entities"));
                if (!ts.isArrayLiteralExpression(entities)) context.contractError(entities, "Expected Babylon entity ordering.");
                const ranges = entities.elements.flatMap(element => {
                    if (!ts.isSpreadElement(element) || !ts.isIdentifier(element.expression)) context.contractError(element, "Unknown Babylon root entity.");
                    const name = element.expression.text;
                    if (name === "lights") return [];
                    const range = name === "rootMeshes" ? "root_meshes" : name === "rootTransformNodes" ? "root_containers" : undefined;
                    if (!range) context.contractError(element, "Unknown Babylon root entity collection.");
                    return [`${indent}roots.insert(roots.end(), ${range}.begin(), ${range}.end());`];
                });
                return [`${indent}std::vector<std::size_t> roots;`, ...ranges, `${indent}return roots;`];
            }
            if (!ts.isExpressionStatement(statement)) return undefined;
            const node = context.unwrapExpression(statement.expression);
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(node.left) && node.left.name.text === "parent")
                return [`${indent}nodes.at(${lowerer.expression(node.left.expression)}).parent = ${lowerer.expression(node.right)};`];
            if (ts.isCallExpression(node) && node.arguments.length === 1) {
                const argument = (): string => lowerer.expression(node.arguments[0]!);
                if (context.expressionMatchesShape(node.expression, "childNodeIds.add")) return [`${indent}child_node_ids.insert(${argument()});`];
                if (context.expressionMatchesShape(node.expression, "parent.children.push")) return [`${indent}nodes.at(parent).children.push_back(${argument()});`];
                if (context.expressionMatchesShape(node.expression, "rootTransformNodes.push")) return [`${indent}root_containers.push_back(${argument()});`];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(module, "loadBabylon")}
struct BabylonHierarchyNode {
    std::string id;
    std::size_t parent = invalid_handle;
    std::vector<std::size_t> children;
    upstream::TrsLanes transform;
    MeshHandle mesh;
};
struct BabylonNodeMap {
    std::vector<std::pair<std::string, std::size_t>> entries;
    std::unordered_map<std::string, std::size_t> indices;
    auto begin() const { return entries.begin(); }
    auto end() const { return entries.end(); }
};
std::size_t find_babylon_node(const BabylonNodeMap& nodes, const std::string& id) {
    const auto found = nodes.indices.find(id);
    return found != nodes.indices.end() ? nodes.entries.at(found->second).second : invalid_handle;
}
void set_babylon_node(BabylonNodeMap& nodes, const std::string& id, std::size_t node) {
    const auto [found, inserted] = nodes.indices.try_emplace(id, nodes.entries.size());
    if (inserted) nodes.entries.emplace_back(id, node);
    else nodes.entries.at(found->second).second = node;
}
std::vector<std::size_t> wire_babylon_hierarchy(const Json& mesh_sources,
    std::vector<BabylonHierarchyNode>& nodes, const BabylonNodeMap& node_map,
    const std::unordered_map<std::string, std::vector<std::size_t>>& meshes_by_id,
    const std::vector<std::size_t>& all_meshes) {
    std::unordered_set<std::string> child_node_ids;
${body}
}`;
}
