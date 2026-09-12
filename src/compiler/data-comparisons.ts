import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { dataTypesEqual, type DataType } from "./data-types.js";

interface Operand { cpp: string; type: DataType; }

/** A union compares its current JavaScript type and scalar value or identity.
 * Capture both operands before inspecting tags so branch selection never skips
 * operand effects or rereads a left operand changed by the right operand. */
export function dataUnionEquality(
    lowerer: DataLowerer, left: ts.Expression, right: ts.Expression, negated: boolean,
): string | undefined {
    const union = (type: DataType | undefined): boolean =>
        type?.kind === "union" || (type?.kind === "optional" && union(type.inner));
    const supported = (type: DataType | undefined): boolean => type !== undefined &&
        (type.kind === "union" ? type.members.every(supported) : type.kind === "optional" ? supported(type.inner)
            : ["number", "boolean", "string", "enum", "vector", "map", "set", "tuple", "product", "iterator"].includes(type.kind) ||
                (type.kind === "struct" && lowerer.context.dataTypes.isReferenceStruct(type.name)));
    const storageType = (expression: ts.Expression): DataType | undefined => {
        const node = lowerer.context.unwrap(expression);
        if (ts.isIdentifier(node)) return lowerer.context.lookupIdentifierValue(node)?.dataType ?? lowerer.dataTypeAt(node);
        if (ts.isElementAccessExpression(node)) {
            let owner = lowerer.dataTypeAt(node.expression);
            if (owner?.kind === "optional") owner = owner.inner;
            if (owner?.kind === "vector" || owner?.kind === "span") return owner.element;
        }
        return lowerer.dataTypeAt(node);
    };
    const leftType = storageType(left), rightType = storageType(right);
    const distinctScalars = leftType && rightType && leftType.kind !== rightType.kind &&
        [leftType.kind, rightType.kind].every(kind => ["number", "boolean", "string"].includes(kind));
    if ((!union(leftType) && !union(rightType) && !distinctScalars) || !supported(leftType) || !supported(rightType)) return undefined;
    const snapshot = (node: ts.Expression): Operand => {
        const value = lowerer.compileDataPath(node, "read") ?? lowerer.context.compileValue(node);
        const type: DataType | undefined = value.kind === "string" || value.kind === "number" || value.kind === "boolean"
            ? {kind: value.kind} : value.dataType ?? lowerer.dataTypeAt(node);
        if (!type || !supported(type)) lowerer.context.fail(node, "Union comparison requires represented scalar or reference operands.");
        const cpp = lowerer.context.allocateTemporaryCppName("union_compare");
        const initializer = value.kind === "json-null"
            ? `${lowerer.context.dataTypes.cppType(type)}{std::nullopt}`
            : type.kind === "optional" ? `(${value.cpp}).to_optional()` : value.cpp;
        lowerer.context.emit(`const auto ${cpp} = ${initializer};`);
        return {cpp, type};
    };
    const a = snapshot(left), b = snapshot(right);
    const compare = (a: Operand, b: Operand): string => {
        if (a.type.kind === "optional" && b.type.kind === "optional") {
            const present = compare({cpp:`(*${a.cpp})`,type:a.type.inner}, {cpp:`(*${b.cpp})`,type:b.type.inner});
            return `(${a.cpp}.has_value() == ${b.cpp}.has_value() && (!${a.cpp}.has_value() || ${present}))`;
        }
        if (a.type.kind === "optional")
            return `(${a.cpp}.has_value() && ${compare({cpp:`(*${a.cpp})`,type:a.type.inner}, b)})`;
        if (b.type.kind === "optional")
            return `(${b.cpp}.has_value() && ${compare(a, {cpp:`(*${b.cpp})`,type:b.type.inner})})`;
        if (a.type.kind === "union") {
            const clauses = a.type.members.map((type,index) =>
                `(${a.cpp}.index() == ${index} && ${compare({cpp:`std::get<${index}>(${a.cpp})`,type},b)})`);
            return `(${clauses.join(" || ")})`;
        }
        if (b.type.kind === "union") return compare(b, a);
        const string = (value: Operand): string => value.type.kind === "enum"
            ? lowerer.context.dataTypes.enumToStringCpp(value.type, value.cpp, left) : value.cpp;
        if (["string", "enum"].includes(a.type.kind) && ["string", "enum"].includes(b.type.kind))
            return `(std::string(${string(a)}) == std::string(${string(b)}))`;
        return dataTypesEqual(a.type, b.type) ? `(${a.cpp} == ${b.cpp})` : "false";
    };
    const equal = compare(a, b);
    return negated ? `!(${equal})` : equal;
}
