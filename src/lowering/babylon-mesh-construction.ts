import ts from "typescript";
import { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { babylonNodeTransformScope } from "./babylon-node-transforms.js";
import { babylonSubmeshMaterialScope } from "./babylon-submesh-material.js";

/** Source control flow with native geometry upload and node-storage adapters. */
export function lowerBabylonMeshConstruction(context: LoweringContext): string {
    const module = "src/loader-babylon/load-babylon.ts";
    const { file, declaration } = context.functionDeclaration(module, "loadBabylon");
    const loops = context.findNodes(declaration, (node): node is ts.ForOfStatement =>
        ts.isForOfStatement(node) && context.expressionMatchesShape(node.expression, "data.meshes") &&
        context.hasCall(node, "initMeshTransform"));
    const loop = loops[0];
    if (loops.length !== 1 || !loop || !ts.isBlock(loop.parent)) context.contractError(declaration, "Expected the mesh construction pass.");
    const transform = babylonNodeTransformScope(context, "md");
    const material = babylonSubmeshMaterialScope(context, "md", 'sub.at("materialIndex").get<double>()');
    const bindings = new Map<string, PinnedBinding>([
        ...transform.bindings, ...material.bindings,
        ["engine", { cpp: "engine", type: "opaque" }],
        ["md.name", { cpp: 'string_or(md, "name")', type: "opaque" }],
        ["md.id", { cpp: 'string_or(md, "id")', type: "opaque" }],
        ["md.isVisible", { cpp: 'md.value("isVisible", Json{})', type: "opaque" }],
        ["md.indices.length", { cpp: 'static_cast<double>(md.at("indices").size())', type: "scalar" }],
        ["subMeshes.length", { cpp: "static_cast<double>(subMeshes.size())", type: "scalar" }],
        ["sub.indexCount", { cpp: 'sub.at("indexCount").get<double>()', type: "scalar" }],
        ["sub.indexStart", { cpp: 'sub.at("indexStart").get<double>()', type: "scalar" }],
        ["mat", { cpp: "material", type: "opaque" }],
        ["firstMesh", { cpp: "firstMesh", type: "opaque", absentCpp: "firstMesh == invalid_handle" }],
    ]);
    for (const field of ["positions", "normals", "indices", "uvs", "uvs2", "localMatrix"])
        bindings.set(`md.${field}`, { cpp: `md.at(${JSON.stringify(field)})`, type: "opaque",
            absentCpp: `!babylon_json_truthy(md, ${JSON.stringify(field)})` });
    const upload = context.callExpression(loop, "uploadMeshToGPU");
    const cpuAttributes = new Map([
        ["_cpuPositions", upload.arguments[1]!], ["_cpuNormals", upload.arguments[2]!],
        ["_cpuIndices", upload.arguments[3]!], ["_cpuUvs", upload.arguments[4]!],
    ]);
    const body = lowerPinnedBody(file, loop.parent.statements.slice(0, loop.parent.statements.indexOf(loop) + 1), {
        bindings, booleanAnd: true,
        calls: new Map([...transform.calls, ...material.calls,
            ["uploadMeshToGPU", args => `upload_babylon_mesh(${args.join(", ")})`],
            ["bakeLocalMatrix", args => {
                if (args.length !== 3) context.contractError(loop, "Expected the pivot bake buffers and matrix.");
                return `bake_local_matrix(${args[0]}, ${args[1]}, babylon_local_matrix(${args[2]}))`;
            }],
        ]),
        forOf(iterated, element) {
            const range = iterated === "data.meshes" ? "mesh_sources" : iterated === "subMeshes" ? "subMeshes" : undefined;
            return range ? { range, bindings: new Map([[element, { cpp: element, type: "opaque" }]]) } : undefined;
        },
        expression(node, lowerer) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
                context.expressionMatchesShape(node.left, "opts.maxMeshes")) return lowerer.expression(node.right);
            if (ts.isConditionalExpression(node)) {
                const condition = bindings.get(context.unwrapExpression(node.condition).getText(file));
                if (condition?.absentCpp) return `(!(${condition.absentCpp}) ? ${lowerer.expression(node.whenTrue)} : ${lowerer.expression(node.whenFalse)})`;
            }
            if (ts.isBinaryExpression(node) && context.expressionMatchesShape(node.left, "firstMesh") &&
                node.right.kind === ts.SyntaxKind.NullKeyword) {
                const operator = node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? "==" :
                    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ? "!=" : undefined;
                if (operator) return `(firstMesh ${operator} invalid_handle)`;
            }
            const fromMaterial = material.expression?.(node, lowerer);
            if (fromMaterial !== undefined) return fromMaterial;
            if (ts.isStringLiteralLike(node)) return `std::string{${JSON.stringify(node.text)}}`;
            if (ts.isIdentifier(node) && node.text === "undefined") return "std::vector<float>{}";
            if (ts.isTemplateExpression(node)) return `(std::string{${JSON.stringify(node.head.text)}}${node.templateSpans.map(span =>
                ` + js::number_to_string(${lowerer.expression(span.expression)}) + ${JSON.stringify(span.literal.text)}`).join("")})`;
            if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.arguments?.length === 1 &&
                (node.expression.text === "F32" || node.expression.text === "U32"))
                return `${node.expression.text === "F32" ? "babylon_f32" : "babylon_u32"}(${lowerer.expression(node.arguments[0]!)})`;
            if (ts.isCallExpression(node)) {
                if (context.expressionMatchesShape(node.expression, "initMeshTransform")) {
                    const record = context.unwrapExpression(node.arguments[0]!);
                    if (!ts.isObjectLiteralExpression(record)) context.contractError(record, "Expected the mesh factory record.");
                    const values = new Map<string, string>();
                    for (const property of record.properties) {
                        if (!ts.isPropertyAssignment(property)) context.contractError(property, "Unsupported mesh record property.");
                        const name = context.propertyName(property.name);
                        if (!name || !["name", "id", "material", "receiveShadows", "_gpu"].includes(name))
                            context.contractError(property, `Unrepresented mesh record property '${name}'.`);
                        values.set(name, lowerer.expression(property.initializer));
                    }
                    const args = ["name", "id", "material", "receiveShadows", "_gpu"].map(name => {
                        const value = values.get(name);
                        if (!value) context.contractError(record, `Missing mesh record property '${name}'.`);
                        return value;
                    });
                    return `create_babylon_mesh(engine, nodes, ${args.join(", ")}, ${transform.expression!(node, lowerer)})`;
                }
                if (context.expressionMatchesShape(node.expression, "createTransformNode"))
                    return `create_babylon_container(nodes, ${transform.expression!(node, lowerer)})`;
                if (context.expressionMatchesShape(node.expression, "meshesByNodeId.has") && node.arguments.length === 1)
                    return `meshes_by_id.contains(${lowerer.expression(node.arguments[0]!)})`;
                if (context.expressionMatchesShape(node.expression, "allIndices.slice") && node.arguments.length === 2)
                    return `js::typed_array_slice(allIndices, ${node.arguments.map(arg => lowerer.expression(arg)).join(", ")})`;
            }
            return transform.expression?.(node, lowerer);
        },
        statement(statement, lowerer, indent) {
            const fromMaterial = material.statement?.(statement, lowerer, indent);
            if (fromMaterial !== undefined) return fromMaterial;
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                const name = variable.name.text;
                if (name === "hasAnyLocalMatrix") {
                    context.assertExpressionShape(variable.initializer, "data.meshes.some((m) => m.localMatrix)", "Local matrix import demand");
                    bindings.set(name, { cpp: name, type: "bool" });
                    return [`${indent}const bool ${name} = std::any_of(mesh_sources.begin(), mesh_sources.end(), [](const Json& m) { return babylon_json_truthy(m, "localMatrix"); });`];
                }
                if (name === "bakeLocalMatrix") {
                    context.assertExpressionShape(variable.initializer, 'hasAnyLocalMatrix ? (await import("./bake-local-matrix.js")).bakeLocalMatrix : null', "Local matrix module boundary");
                    bindings.set(name, { cpp: "hasAnyLocalMatrix", type: "bool" });
                    return [];
                }
                if (name === "firstMesh") {
                    if (variable.initializer.kind !== ts.SyntaxKind.NullKeyword) context.contractError(variable, "Expected an absent first mesh.");
                    return [`${indent}std::size_t firstMesh = invalid_handle;`];
                }
                if (name === "subMeshes") {
                    bindings.set(name, { cpp: name, type: "opaque" });
                    return [`${indent}const auto subMeshes = babylon_submeshes(md, positions.size(), allIndices.size());`];
                }
                if (["positions", "normals", "allIndices", "uvs", "uvs2", "subIndices", "gpu", "mesh", "tn"].includes(name)) {
                    const value = lowerer.expression(variable.initializer);
                    bindings.set(name, { cpp: name, type: name === "allIndices" || name === "subIndices" ? "u32" :
                        ["positions", "normals", "uvs", "uvs2"].includes(name) ? "f32" : "opaque" });
                    return [`${indent}auto ${name} = ${value};`];
                }
            }
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = context.unwrapExpression(statement.expression);
            if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(expression.left) && context.expressionMatchesShape(expression.left.expression, "mesh")) {
                const attribute = cpuAttributes.get(expression.left.name.text);
                if (!attribute) return undefined;
                context.assertExpressionShape(expression.right, attribute.getText(file), "Uploaded CPU attribute alias");
                return [];
            }
            if (!ts.isCallExpression(expression)) return undefined;
            const args = (): string[] => expression.arguments.map(arg => lowerer.expression(arg));
            if (context.expressionMatchesShape(expression.expression, "nodeMap.set") && expression.arguments.length === 2)
                return [`${indent}set_babylon_node(node_map, ${args().join(", ")});`];
            if (context.expressionMatchesShape(expression.expression, "allMeshes.push") && expression.arguments.length === 1)
                return [`${indent}all_meshes.push_back(${args()[0]});`];
            if (context.expressionMatchesShape(expression.expression, "meshesByNodeId.set") && expression.arguments.length === 2) {
                context.assertExpressionShape(expression.arguments[1]!, "[]", "Empty submesh list");
                return [`${indent}meshes_by_id[${lowerer.expression(expression.arguments[0]!)}] = {};`];
            }
            if (ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "push") {
                const receiver = context.unwrapExpression(expression.expression.expression);
                if (ts.isCallExpression(receiver) && context.expressionMatchesShape(receiver.expression, "meshesByNodeId.get") &&
                    receiver.arguments.length === 1 && expression.arguments.length === 1)
                    return [`${indent}meshes_by_id.at(${lowerer.expression(receiver.arguments[0]!)}).push_back(${args()[0]});`];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(module, "loadBabylon")}
void construct_babylon_meshes(Engine& engine, const Json& mesh_sources,
    const std::unordered_map<std::string, MaterialHandle>& materials,
    const std::unordered_map<std::string, std::vector<std::string>>& multi_materials,
    std::vector<BabylonHierarchyNode>& nodes, BabylonNodeMap& node_map,
    std::unordered_map<std::string, std::vector<std::size_t>>& meshes_by_id, std::vector<std::size_t>& all_meshes) {
${body}
}`;
}
