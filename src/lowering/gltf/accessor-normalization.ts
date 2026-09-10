import ts from "typescript";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import { pinnedNumericMathCalls } from "../pinned-operators.js";
import { identifierParameters, refuseNode, topLevelFunction, unwrapExpression } from "./shared.js";

/** DataView reads supported by the native little-endian transport. */
const accessorReadsByGetter: Readonly<Record<string, { cppType: string; littleEndian: boolean }>> = {
    getInt8: { cppType: "std::int8_t", littleEndian: false },
    getUint8: { cppType: "std::uint8_t", littleEndian: false },
    getInt16: { cppType: "std::int16_t", littleEndian: true },
    getUint16: { cppType: "std::uint16_t", littleEndian: true },
    getFloat32: { cppType: "float", littleEndian: true },
};

/** Lower the complete quantized component reader at JavaScript-number width. */
export function lowerAccessorNormalizationCpp(
    file: ts.SourceFile,
): string {
    const declaration = topLevelFunction(file, "readComponent");
    const parameters = identifierParameters("readComponent", file, declaration);
    if (parameters.length !== 4) refuseNode("readComponent", file, declaration, "requires a DataView, offset, component type and normalization flag");
    const body = lowerPinnedBody(file, declaration.body.statements, {
        bindings: new Map([
            [parameters[0]!, { cpp: "view", type: "opaque" }],
            [parameters[1]!, { cpp: "offset", type: "scalar" }],
            [parameters[2]!, { cpp: "component_type", type: "scalar" }],
            [parameters[3]!, { cpp: "normalized", type: "bool" }],
        ]), calls: pinnedNumericMathCalls(),
        methods: new Map(Object.entries(accessorReadsByGetter).map(([getter, read]) => [getter, (receiver, args) => {
            if (receiver !== "view" || args.length !== (read.littleEndian ? 2 : 1) || (read.littleEndian && args[1] !== "true"))
                refuseNode("readComponent", file, declaration, `requires the native little-endian '${getter}' read`);
            return `static_cast<double>(read_value<${read.cppType}>(view + static_cast<std::size_t>(${args[0]})))`;
        }])),
        expression(node, lowerer) {
            if (ts.isStringLiteralLike(node)) return `std::string{${JSON.stringify(node.text)}}`;
            if (ts.isTemplateExpression(node)) return `(std::string{${JSON.stringify(node.head.text)}}${node.templateSpans.map(span =>
                ` + js::number_to_string(${lowerer.expression(span.expression)}) + ${JSON.stringify(span.literal.text)}`).join("")})`;
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (!ts.isThrowStatement(statement)) return undefined;
            const value = unwrapExpression(statement.expression);
            if (!ts.isNewExpression(value) || !ts.isIdentifier(value.expression) || value.expression.text !== "Error" || value.arguments?.length !== 1)
                refuseNode("readComponent", file, statement, "throws an unrepresented error");
            return [`${indent}throw std::runtime_error(${lowerer.expression(value.arguments[0]!)});`];
        },
        returnValue: (expression, lowerer) => lowerer.expression(expression!),
    });
    return `// ${file.fileName}#readComponent\ndouble read_quantized_component(const std::uint8_t* view, double offset, double component_type, bool normalized) {\n${body}\n}`;
}
