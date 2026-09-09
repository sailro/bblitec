import ts from "typescript";
import { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

export function lowerBabylonSubmeshDefaults(context: LoweringContext): string {
    const module = "src/loader-babylon/load-babylon.ts";
    const { file, declaration } = context.functionDeclaration(module, "loadBabylon");
    const initializer = context.variableInitializer(declaration, "subMeshes");
    const defaults = lowerPinnedBody(file, [ts.factory.createReturnStatement(initializer)], {
        bindings: new Map([
            ["positions.length", { cpp: "static_cast<double>(position_count)", type: "scalar" }],
            ["allIndices.length", { cpp: "static_cast<double>(index_count)", type: "scalar" }],
        ]), calls: new Map(), returnValue: (value, lowerer) => lowerer.expression(value!),
        expression(node, lowerer) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
                context.expressionMatchesShape(node.left, "md.subMeshes"))
                return `((source.contains("subMeshes") && !source.at("subMeshes").is_null()) ? source.at("subMeshes") : ${lowerer.expression(node.right)})`;
            if (ts.isArrayLiteralExpression(node)) return `Json::array({${node.elements.map(value => lowerer.expression(value)).join(", ")}})`;
            if (ts.isObjectLiteralExpression(node)) return `Json{${node.properties.map(property => {
                if (!ts.isPropertyAssignment(property)) context.contractError(property, "Unsupported submesh descriptor property.");
                return `{${JSON.stringify(context.propertyName(property.name))}, ${lowerer.expression(property.initializer)}}`;
            }).join(", ")}}`;
            return undefined;
        },
    });
    return `Json babylon_submeshes(const Json& source, std::size_t position_count, std::size_t index_count) {\n${defaults}\n}`;
}

export function lowerBabylonSubmeshIndices(context: LoweringContext): string {
    const module = "src/loader-babylon/load-babylon.ts";
    const { file, declaration } = context.functionDeclaration(module, "loadBabylon");
    const bindings = new Map<string, PinnedBinding>([
        ["allIndices", { cpp: "indices", type: "u32" }],
        ["sub.indexStart", { cpp: "index_start", type: "scalar" }],
        ["sub.indexCount", { cpp: "index_count", type: "scalar" }],
    ]);
    const slice = lowerPinnedBody(file, [ts.factory.createReturnStatement(context.variableInitializer(declaration, "subIndices"))], {
        bindings, calls: new Map(),
        methods: new Map([["slice", (receiver, args) => {
            if (args.length !== 2) context.contractError(declaration, "Expected the submesh's index slice boundaries.");
            return `js::typed_array_slice(${receiver}, ${args.join(", ")})`;
        }]]), returnValue: (value, lowerer) => lowerer.expression(value!),
    });
    const loops = context.findNodes(declaration, (node): node is ts.ForOfStatement =>
        ts.isForOfStatement(node) && context.expressionMatchesShape(node.expression, "subMeshes"));
    const loop = loops[0];
    const guard = loop && ts.isBlock(loop.statement) && loop.statement.statements[0];
    if (loops.length !== 1 || !guard || !ts.isIfStatement(guard)) context.contractError(declaration, "Expected the empty-submesh guard.");
    const keep = lowerPinnedBody(file, [guard], {
        bindings, calls: new Map(),
        statement(statement, _lowerer, indent) {
            return ts.isContinueStatement(statement) && !statement.label ? [`${indent}return false;`] : undefined;
        },
    });
    return `// ${context.provenance(module, "loadBabylon")}
${lowerBabylonSubmeshDefaults(context)}
std::vector<std::uint32_t> babylon_submesh_indices(const std::vector<std::uint32_t>& indices, double index_start, double index_count) {
${slice}
}
bool keep_babylon_submesh(double index_count) {
${keep}
    return true;
}`;
}
