// The runtime object a (non-`const`) enum declaration creates: each
// member's name keys its value, and each numeric value keys its name back
// (the reverse mapping). A computed-key read of that object lowers to a
// lookup over the members the checker folds; the object itself has no
// other native representation.
import ts from "typescript";
import { doubleLiteral, stringLiteral } from "../cpp-literals.js";
import type { DataType } from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import { enumMemberConstant, resolvedSymbol } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";
import type { Value } from "./types.js";

type EnumObjectContext = Pick<
    LoweringServices,
    "checker" | "compileValue" | "dataLowerer" | "dataTypes" | "fail"
>;

/** The enum whose runtime object an expression names, if it names one. */
export function enumObjectSymbol(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): ts.Symbol | undefined {
    const owner = unwrapExpression(expression);
    if (!ts.isIdentifier(owner)) return undefined;
    const symbol = resolvedSymbol(checker, owner);
    return symbol && (symbol.flags & ts.SymbolFlags.RegularEnum) !== 0
        ? symbol
        : undefined;
}

/** Whether a type, or each member of its union, has one of `flags`. */
function everyMember(type: ts.Type, flags: ts.TypeFlags): boolean {
    return type.isUnion()
        ? type.types.every((member) => (member.flags & flags) !== 0)
        : (type.flags & flags) !== 0;
}

/** Every member of a (possibly merged) enum with its folded value. */
function enumMembers(
    context: EnumObjectContext,
    symbol: ts.Symbol,
    node: ts.Node,
): { name: string; value: string | number }[] {
    return (symbol.declarations ?? [])
        .filter(ts.isEnumDeclaration)
        .flatMap((declaration) => declaration.members)
        .map((member) => {
            const value = context.checker.getConstantValue(member);
            if (
                value === undefined ||
                !(
                    ts.isIdentifier(member.name) ||
                    ts.isStringLiteral(member.name)
                )
            )
                return context.fail(
                    node,
                    `Enum member '${member.name.getText()}' has no constant value, so its enum object has no static layout.`,
                );
            return { name: member.name.text, value };
        });
}

/**
 * `E[key]` with a key only known at run time: a number reads the reverse
 * mapping (the name of the numeric member holding it), a string reads the
 * member it names. A key naming nothing reads `undefined`.
 */
export function compileEnumElementAccess(
    context: EnumObjectContext,
    access: ts.ElementAccessExpression,
): Value | undefined {
    const symbol = enumObjectSymbol(context.checker, access.expression);
    if (!symbol || enumMemberConstant(context.checker, access) !== undefined)
        return undefined;
    const members = enumMembers(context, symbol, access);
    const keyType = context.checker.getTypeAtLocation(
        access.argumentExpression,
    );
    const key = context.compileValue(access.argumentExpression);
    if (everyMember(keyType, ts.TypeFlags.NumberLike)) {
        const arms = members.flatMap(({ name, value }) =>
            typeof value === "number"
                ? [
                      `if (key == ${doubleLiteral(value)}) return ${stringLiteral(name)};`,
                  ]
                : [],
        );
        return lookup(
            context,
            access,
            key,
            { kind: "number" },
            { kind: "string" },
            arms,
        );
    }
    if (!everyMember(keyType, ts.TypeFlags.StringLike))
        context.fail(
            access.argumentExpression,
            "An enum object is read by a number (its reverse mapping) or a string key.",
        );
    const numeric = members.every(({ value }) => typeof value === "number");
    if (!numeric && !members.every(({ value }) => typeof value === "string"))
        context.fail(
            access,
            "A string key reads a mixed enum's members as values of different types.",
        );
    const arms = members.map(
        ({ name, value }) =>
            `if (key == ${stringLiteral(name)}) return ${typeof value === "number" ? doubleLiteral(value) : stringLiteral(value)};`,
    );
    // A numeric member's value as a string keys its name back, which a
    // member-typed result cannot hold.
    if (numeric)
        arms.push(
            ...members.map(
                ({ value }) =>
                    `if (key == ${stringLiteral(String(value))}) throw std::runtime_error("An enum's reverse mapping read through a member-typed key.");`,
            ),
        );
    return lookup(
        context,
        access,
        key,
        { kind: "string" },
        numeric ? { kind: "number" } : { kind: "string" },
        arms,
    );
}

function lookup(
    context: EnumObjectContext,
    access: ts.ElementAccessExpression,
    key: Value,
    keyType: DataType,
    resultType: DataType,
    arms: string[],
): Value {
    const optional = context.dataTypes.nullableType(resultType);
    const keyCpp = context.dataLowerer.compileKnownValueForSink(
        key,
        keyType,
        access.argumentExpression,
    );
    const keyParameter =
        keyType.kind === "number" ? "double key" : "const std::string& key";
    return {
        ...context.dataLowerer.leafValue(
            `[](${keyParameter}) -> ${context.dataTypes.cppType(optional)} { ${arms.join(" ")} return std::nullopt; }(${keyCpp})`,
            optional,
        ),
        preserveUncheckedLookup: true,
    };
}
