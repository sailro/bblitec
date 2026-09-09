import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";

/** Accessor lane counts and constructor widths come from resolveAccessor. */
export function lowerGltfAccessorShape(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-parser.ts";
    const { file, declaration } = context.functionDeclaration(module, "resolveAccessor");
    const sizes = context.moduleScopeConstant(file, "TYPE_SIZES");
    if (!sizes || !ts.isObjectLiteralExpression(context.unwrapExpression(sizes)))
        context.contractError(declaration, "Expected the accessor component-count table.");
    const table = context.unwrapExpression(sizes) as ts.ObjectLiteralExpression;
    const entries = table.properties.map(property => {
        if (!ts.isPropertyAssignment(property)) context.contractError(property, "Expected a component-count entry.");
        const key = context.propertyName(property.name), size = context.numericValue(property.initializer, file);
        if (!key || !Number.isSafeInteger(size) || size <= 0) context.contractError(property, "Expected a positive component count.");
        return `        {${JSON.stringify(key)}, ${size}},`;
    });
    const componentCount = context.variableInitializer(declaration, "componentCount");
    const count = lowerPinnedBody(file, [ts.factory.createReturnStatement(componentCount)], {
        bindings: new Map(), calls: new Map(),
        expression(node, lowerer) {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
                context.expressionMatchesShape(node.left, "TYPE_SIZES[accessor.type]"))
                return `(found != sizes.end() ? found->second : static_cast<std::size_t>(${lowerer.expression(node.right)}))`;
            return undefined;
        }, returnValue: (value, lowerer) => lowerer.expression(value!),
    });
    const switches = context.findNodes(declaration, (node): node is ts.SwitchStatement => ts.isSwitchStatement(node));
    const dispatch = switches[0];
    if (switches.length !== 1 || !dispatch) context.contractError(declaration, "Expected accessor constructor selection.");
    const nativeReads: Readonly<Record<number, string>> = { 5120: "I8", 5121: "U8", 5122: "I16", 5123: "U16", 5125: "U32", 5126: "F32" };
    for (const clause of dispatch.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        const assignments = context.findNodes(clause, (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && context.expressionMatchesShape(node.left, "Ctor"));
        if (assignments.length !== 1 || !context.expressionMatchesShape(assignments[0]!.right, nativeReads[context.numericValue(clause.expression, file)] ?? "undefined"))
            context.contractError(clause, "Accessor constructor does not match its native binary read.");
    }
    const bindings = new Map<string, PinnedBinding>([
        ["accessor.componentType", { cpp: "component_type", type: "scalar" }],
        ["Ctor", { cpp: "component_bytes", type: "index" }],
    ]);
    for (const [name, type] of [["F32", "float"], ["U32", "std::uint32_t"], ["U16", "std::uint16_t"],
        ["U8", "std::uint8_t"], ["I16", "std::int16_t"], ["I8", "std::int8_t"]] as const)
        bindings.set(name, { cpp: `sizeof(${type})`, type: "index" });
    const width = lowerPinnedBody(file, [dispatch], {
        bindings, calls: new Map(),
        statement(statement, _lowerer, indent) {
            if (!ts.isThrowStatement(statement)) return undefined;
            const value = context.unwrapExpression(statement.expression);
            if (!ts.isNewExpression(value) || !context.expressionMatchesShape(value.expression, "Error"))
                context.contractError(statement, "Expected an unsupported accessor type error.");
            return [`${indent}throw std::runtime_error("Unsupported glTF accessor component type.");`];
        },
    });
    return `// ${context.provenance(module, "resolveAccessor")}
std::size_t component_count(const std::string& type) {
    static const std::unordered_map<std::string, std::size_t> sizes{
${entries.join("\n")}
    };
    const auto found = sizes.find(type);
${count}
}
std::size_t component_size(std::uint32_t component_type) {
    std::size_t component_bytes = 0;
${width}
    return component_bytes;
}`;
}
