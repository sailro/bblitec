import ts from "typescript";
import { cppIdentifierPattern } from "../cpp-literals.js";
import { refuseEitherAbsence } from "./absence-tag-storage.js";
import { numericSlotKind } from "./numeric-slot-storage.js";
import { unwrapExpression } from "./syntax.js";
import type { DataLowerer } from "./data-lowering.js";
import { dataTypesEqual, type DataType } from "./data-types.js";
import {
    absenceKind,
    absentValueKind,
    nullability,
    type Absence,
} from "./type-facts.js";
import { optionalPresentCpp, optionalValueCpp, type Value } from "./types.js";

/**
 * One operand of a strict equality between two values that may be absent:
 * the expression and, where a read produced one, its value, whose recorded
 * slot presence (`Value.slotFoundCpp`) tells a stored `null` from a missing
 * `undefined`.
 */
export interface AbsentOperand {
    readonly node: ts.Expression;
    readonly value: Value | undefined;
}

/**
 * `value` with its slot-presence test read now, as a `const bool` dropped
 * when unused: an operand evaluated later may change the slot it tests.
 */
export function pinSlotFound(lowerer: DataLowerer, value: Value): Value {
    const found = value.slotFoundCpp;
    if (found === undefined || cppIdentifierPattern.test(found)) return value;
    const name = lowerer.context.allocateTemporaryCppName("slot_found");
    lowerer.context.emit({
        kind: "declaration",
        type: "const bool",
        name,
        initializer: found,
        attributes: "[[maybe_unused]] ",
        discardIfUnused: true,
    });
    return { ...value, slotFoundCpp: name };
}

/** Which absent value `operand` is when absent ({@link absenceKind}). */
function operandAbsence(lowerer: DataLowerer, operand: AbsentOperand): Absence {
    const { checker } = lowerer.context;
    return operand.value
        ? absenceKind(checker, operand.value, operand.node)
        : (absentValueKind(
              nullability(checker.getTypeAtLocation(operand.node)),
          ) ?? "unconstrained");
}

/**
 * Whether an operand, when absent, is `null`: "true", "false" or a run-time
 * test. An operand that may be either demands storage that tells them
 * apart, or refuses.
 */
function absentIsNull(
    lowerer: DataLowerer,
    operand: AbsentOperand,
    state: Exclude<Absence, "unconstrained">,
): string {
    if (state === "either")
        refuseEitherAbsence(
            lowerer.context,
            operand.node,
            operand.value,
            "A value that may be null or undefined is compared strictly with another value that may be absent only once one of them is ruled out (narrow the type).",
        );
    return typeof state === "object"
        ? state.slotFoundCpp
        : String(state === "null");
}

/**
 * Whether two operands of a strict equality, both absent, are the same
 * absent value (`null === undefined` is false): "true", "false" or a
 * run-time test over their slot presence. An operand whose type names
 * neither absent value is never absent (or only its representation says),
 * so the other's kind does not matter.
 */
export function sameAbsenceCpp(
    lowerer: DataLowerer,
    left: AbsentOperand,
    right: AbsentOperand,
): string {
    const leftState = operandAbsence(lowerer, left);
    const rightState = operandAbsence(lowerer, right);
    if (leftState === "unconstrained" || rightState === "unconstrained")
        return "true";
    const leftNull = absentIsNull(lowerer, left, leftState);
    const rightNull = absentIsNull(lowerer, right, rightState);
    const constant = (test: string): boolean =>
        test === "true" || test === "false";
    if (leftNull === rightNull) return "true";
    if (constant(leftNull) && constant(rightNull)) return "false";
    if (constant(leftNull))
        return leftNull === "true" ? rightNull : `!(${rightNull})`;
    if (constant(rightNull))
        return rightNull === "true" ? leftNull : `!(${leftNull})`;
    return `(${leftNull} == ${rightNull})`;
}

/**
 * Strict equality of two operands that may each be absent: both present and
 * `presentEqual`, or both absent as the same absent value
 * ({@link sameAbsenceCpp}). `leftPresent` and `rightPresent` test presence;
 * `presentEqual` reads both present values.
 */
export function absentAwareEquality(
    same: string,
    leftPresent: string,
    rightPresent: string,
    presentEqual: string,
): string {
    if (same === "true")
        return `(${leftPresent} == ${rightPresent} && (!${leftPresent} || ${presentEqual}))`;
    if (same === "false")
        return `(${leftPresent} && ${rightPresent} && ${presentEqual})`;
    return `(${leftPresent} == ${rightPresent} && (${leftPresent} ? ${presentEqual} : ${same}))`;
}

/**
 * Strict equality of two references whose absent states are themselves
 * identical (null pointers, empty functions): `identical(operator)` compares
 * them, and two absent ones must also be the same absent value
 * ({@link sameAbsenceCpp}). `leftPresent` tests the left one.
 */
export function absentAwareIdentity(
    same: string,
    leftPresent: string,
    identical: (operator: "==" | "!=") => string,
    negated: boolean,
): string {
    if (same === "true") return identical(negated ? "!=" : "==");
    const equal =
        same === "false"
            ? `(${leftPresent} && ${identical("==")})`
            : `(${identical("==")} && (${leftPresent} || ${same}))`;
    return negated ? `!${equal}` : equal;
}

/** A borrowed view (a span, a table) reads another array's storage. */
function hasBorrowedArrayIdentity(type: DataType | undefined): boolean {
    if (type?.kind === "optional") return hasBorrowedArrayIdentity(type.inner);
    if (type?.kind === "union")
        return type.members.some(hasBorrowedArrayIdentity);
    return type?.kind === "span" || type?.kind === "table";
}

/** A record keyed by a closed union is stored by value, one copy per location. */
function isRecordTable(type: DataType | undefined): boolean {
    return type?.kind === "optional"
        ? isRecordTable(type.inner)
        : type?.kind === "enummap";
}

/**
 * Strict equality (`!==` when `negated`) of two compiled, narrowed operands
 * of `expression` where their kinds decide it: a BigInt equals only a
 * BigInt, a numeric view is the array it views, and a shared record or a
 * function is identical to the other one, two absent ones being the same
 * absent value ({@link sameAbsenceCpp}). A borrowed array view and a record
 * table, stored by value, refuse: neither keeps JavaScript's identity.
 * Undefined when the operands compare as their native values.
 */
export function strictEqualsCpp(
    lowerer: DataLowerer,
    expression: ts.BinaryExpression,
    left: Value,
    right: Value,
    negated: boolean,
): string | undefined {
    const { context } = lowerer;
    const operator = negated ? "!=" : "==";
    if (
        (left.dataType?.kind === "bigint") !==
        (right.dataType?.kind === "bigint")
    ) {
        context.emitDiscardedValue(left);
        context.emitDiscardedValue(right);
        return negated ? "true" : "false";
    }
    if (
        hasBorrowedArrayIdentity(left.dataType) ||
        hasBorrowedArrayIdentity(right.dataType)
    )
        context.fail(
            expression,
            "A borrowed array view cannot preserve JavaScript object identity in a comparison.",
        );
    if (isRecordTable(left.dataType) && isRecordTable(right.dataType))
        context.fail(
            expression,
            "A record keyed by a closed union is stored by value and cannot preserve JavaScript object identity in a comparison.",
        );
    // A numeric view is the array it views: it is another numeric array
    // when the two name one array (two views compare as such).
    if (
        (left.dataType?.kind === "numberindex") !==
        (right.dataType?.kind === "numberindex")
    ) {
        const present = (value: Value): boolean =>
            value.dataType?.kind !== "optional" &&
            numericSlotKind(value.dataType) !== undefined;
        if (!present(left) || !present(right))
            context.fail(
                expression,
                "A numeric view compares by identity only with a present numeric array.",
            );
        return `(${left.cpp}).identity() ${operator} (${right.cpp}).identity()`;
    }
    // A shared record or a function is absent as one native null; two
    // absent ones must also be the same absent value.
    const nullable = (value: Value): boolean =>
        value.kind === "data" &&
        (value.dataType?.kind === "function" ||
            value.dataType?.kind === "struct") &&
        context.dataTypes.slotPresentCpp(value.dataType, value.cpp) !==
            undefined;
    if (!nullable(left) || !nullable(right)) return undefined;
    const same = sameAbsenceCpp(
        lowerer,
        { node: expression.left, value: left },
        { node: expression.right, value: right },
    );
    if (same === "true") return undefined;
    const stable = cppIdentifierPattern.test(left.cpp)
        ? left
        : context.bindings.pinValueToTemporary(
              left,
              "comparison_left",
              expression.left,
          );
    return absentAwareIdentity(
        same,
        `static_cast<bool>(${stable.cpp})`,
        (identity) => `${stable.cpp} ${identity} ${right.cpp}`,
        negated,
    );
}

interface Operand {
    cpp: string;
    type: DataType;
    /** The compared operand itself, which an absent state belongs to. */
    absent?: AbsentOperand;
}

/** A union compares its current JavaScript type and scalar value or identity.
 * Capture both operands before inspecting tags so branch selection never skips
 * operand effects or rereads a left operand changed by the right operand. */
export function dataUnionEquality(
    lowerer: DataLowerer,
    left: ts.Expression,
    right: ts.Expression,
    negated: boolean,
): string | undefined {
    const union = (type: DataType | undefined): boolean =>
        type?.kind === "union" ||
        (type?.kind === "optional" && union(type.inner));
    const supported = (type: DataType | undefined): boolean =>
        type !== undefined &&
        (type.kind === "union"
            ? type.members.every(supported)
            : type.kind === "optional"
              ? supported(type.inner)
              : [
                    "number",
                    "boolean",
                    "string",
                    "enum",
                    "vector",
                    "map",
                    "set",
                    "tuple",
                    "product",
                    "iterator",
                    "json",
                    "handle",
                ].includes(type.kind) ||
                (type.kind === "struct" &&
                    lowerer.context.dataTypes.isReferenceStruct(type.name)));
    const storageType = (expression: ts.Expression): DataType | undefined => {
        const node = lowerer.context.options.workers
            ? unwrapExpression(expression)
            : lowerer.context.unwrap(expression);
        if (ts.isIdentifier(node)) {
            const bound = lowerer.context.bindings.lookupOptional(node);
            if (
                bound?.kind === "number" ||
                bound?.kind === "boolean" ||
                bound?.kind === "string"
            )
                return { kind: bound.kind };
            return bound?.dataType ?? lowerer.dataTypeAt(node);
        }
        if (ts.isElementAccessExpression(node)) {
            let owner = storageType(node.expression);
            if (owner?.kind === "optional") owner = owner.inner;
            if (owner?.kind === "vector" || owner?.kind === "span")
                return owner.element;
        }
        return lowerer.dataTypeAt(node);
    };
    const leftType = storageType(left),
        rightType = storageType(right);
    const distinctScalars =
        leftType &&
        rightType &&
        leftType.kind !== rightType.kind &&
        [leftType.kind, rightType.kind].every((kind) =>
            ["number", "boolean", "string"].includes(kind),
        );
    if (
        (!union(leftType) && !union(rightType) && !distinctScalars) ||
        !supported(leftType) ||
        !supported(rightType)
    )
        return undefined;
    const compileOperand = (node: ts.Expression) =>
        lowerer.compileDataPath(node, "read") ??
        lowerer.context.compileValue(node);
    if (distinctScalars) {
        lowerer.context.emitDiscardedValue(compileOperand(left));
        lowerer.context.emitDiscardedValue(compileOperand(right));
        return negated ? "true" : "false";
    }
    const snapshot = (node: ts.Expression): Operand => {
        const value = pinSlotFound(lowerer, compileOperand(node));
        const type: DataType | undefined =
            value.kind === "string" ||
            value.kind === "number" ||
            value.kind === "boolean"
                ? { kind: value.kind }
                : (value.dataType ?? lowerer.dataTypeAt(node));
        if (!type || !supported(type))
            lowerer.context.fail(
                node,
                "Union comparison requires represented scalar or reference operands.",
            );
        const cpp = lowerer.context.allocateTemporaryCppName("union_compare");
        const initializer =
            value.kind === "json-null"
                ? `${lowerer.context.dataTypes.cppType(type)}{std::nullopt}`
                : type.kind === "optional"
                  ? `(${value.cpp}).to_optional()`
                  : type.kind === "handle"
                    ? lowerer.compileKnownValueForSink(value, type, node)
                    : value.cpp;
        lowerer.context.emit({
            kind: "declaration",
            type: "const auto",
            name: cpp,
            initializer: initializer,
        });
        return { cpp, type, absent: { node, value } };
    };
    const a = snapshot(left),
        b = snapshot(right);
    const compare = (a: Operand, b: Operand): string => {
        if (a.type.kind === "json" || b.type.kind === "json") {
            const boxed = (value: Operand, node: ts.Expression): string =>
                lowerer.compileKnownValueForSink(
                    lowerer.leafValue(value.cpp, value.type),
                    { kind: "json" },
                    node,
                );
            return `${boxed(a, left)}.strict_equals(${boxed(b, right)})`;
        }
        if (a.type.kind === "optional" && b.type.kind === "optional") {
            const present = compare(
                { cpp: optionalValueCpp(a.cpp), type: a.type.inner },
                { cpp: optionalValueCpp(b.cpp), type: b.type.inner },
            );
            return absentAwareEquality(
                sameAbsenceCpp(
                    lowerer,
                    a.absent ?? { node: left, value: undefined },
                    b.absent ?? { node: right, value: undefined },
                ),
                optionalPresentCpp(a.cpp),
                optionalPresentCpp(b.cpp),
                present,
            );
        }
        if (a.type.kind === "optional")
            return `(${optionalPresentCpp(a.cpp)} && ${compare({ cpp: optionalValueCpp(a.cpp), type: a.type.inner }, b)})`;
        if (b.type.kind === "optional")
            return `(${optionalPresentCpp(b.cpp)} && ${compare(a, { cpp: optionalValueCpp(b.cpp), type: b.type.inner })})`;
        if (a.type.kind === "union") {
            const clauses = a.type.members.map(
                (type, index) =>
                    `(${a.cpp}.index() == ${index} && ${compare({ cpp: `std::get<${index}>(${a.cpp})`, type }, b)})`,
            );
            return `(${clauses.join(" || ")})`;
        }
        if (b.type.kind === "union") return compare(b, a);
        const string = (value: Operand): string =>
            value.type.kind === "enum"
                ? lowerer.context.dataTypes.enumToStringCpp(
                      value.type,
                      value.cpp,
                      left,
                  )
                : value.cpp;
        if (
            ["string", "enum"].includes(a.type.kind) &&
            ["string", "enum"].includes(b.type.kind)
        )
            return `(std::string(${string(a)}) == std::string(${string(b)}))`;
        return dataTypesEqual(a.type, b.type)
            ? `(${a.cpp} == ${b.cpp})`
            : "false";
    };
    const equal = compare(a, b);
    return negated ? `!(${equal})` : equal;
}
