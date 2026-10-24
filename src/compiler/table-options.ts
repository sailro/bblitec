// Enum-like intrinsic options: a string the pin's table names a native
// spelling for (an address mode, a filter, a depth compare, a topology).
// One reader for all of them: a generation-known string looks its entry
// up, a `?:` lowers each arm, and a run-time member of a string literal
// union selects among its members' entries. A string outside the table
// refuses with the reader's own message.
import type ts from "typescript";
import { unlessRuntimeValue } from "./compile-error.js";
import type { LoweringServices } from "./lowering-services.js";
import { conditionalExpression } from "./syntax.js";
import type { Value } from "./types.js";

/** Each accepted string's native spelling. */
export type OptionTable = Readonly<Record<string, string>>;

/** What selecting among a compiled value's entries reads. */
export type TableValueContext = Pick<
    LoweringServices,
    "bindings" | "dataTypes" | "fail"
>;

export type TableOptionContext = TableValueContext &
    Pick<
        LoweringServices,
        "compileStringLiteral" | "compileValue" | "dataLowerer"
    >;

/** What a reader names its option and the strings it accepts. */
export interface TableOption {
    readonly table: OptionTable;
    /** The refusal of a string outside the table. */
    readonly refusal: string | ((key: string) => string);
    /** The option's name in a run-time refusal: "texture address mode". */
    readonly name: string;
    /** The label of a run-time selection's temporary. */
    readonly label: string;
}

/** A string's entry, or the option's refusal at `node`. */
export function tableEntry(
    context: Pick<LoweringServices, "fail">,
    option: TableOption,
    key: string,
    node: ts.Node,
): string {
    return Object.prototype.hasOwnProperty.call(option.table, key)
        ? option.table[key]!
        : context.fail(
              node,
              typeof option.refusal === "string"
                  ? option.refusal
                  : option.refusal(key),
          );
}

/**
 * The generation-known string an option expression names, checked against
 * the table: for an option a generation-time decision reads.
 */
export function staticTableOption(
    context: Pick<LoweringServices, "compileStringLiteral" | "fail">,
    option: TableOption,
    expression: ts.Expression,
): string {
    const key =
        unlessRuntimeValue(() => context.compileStringLiteral(expression)) ??
        context.fail(
            expression,
            `A ${option.name} must be a generation-known string.`,
        );
    tableEntry(context, option, key, expression);
    return key;
}

/** The native spelling of a generation-known option string. */
export function staticTableEntry(
    context: Pick<LoweringServices, "compileStringLiteral" | "fail">,
    option: TableOption,
    expression: ts.Expression,
): string {
    return tableEntry(
        context,
        option,
        staticTableOption(context, option, expression),
        expression,
    );
}

/** {@link staticTableOption} of an option value already compiled. */
export function staticTableValue(
    context: Pick<LoweringServices, "fail">,
    option: TableOption,
    value: Value,
    node: ts.Node,
): string {
    const key =
        value.staticString ??
        context.fail(
            node,
            `A ${option.name} must be a generation-known string.`,
        );
    tableEntry(context, option, key, node);
    return key;
}

/** The native spelling an option expression selects. */
export function compileTableOption(
    context: TableOptionContext,
    option: TableOption,
    expression: ts.Expression,
): string {
    const conditional = conditionalExpression(expression);
    if (conditional)
        return context.dataLowerer.selectArms(conditional, (arm) =>
            compileTableOption(context, option, arm),
        );
    const key = unlessRuntimeValue(() =>
        context.compileStringLiteral(expression),
    );
    if (key !== undefined) return tableEntry(context, option, key, expression);
    return tableOptionValue(
        context,
        option,
        context.compileValue(expression),
        expression,
    );
}

/**
 * The native spelling a compiled option value selects: its generation-known
 * string's entry, or a run-time member of a literal union compared against
 * each member's entry.
 */
export function tableOptionValue(
    context: TableValueContext,
    option: TableOption,
    value: Value,
    node: ts.Expression,
): string {
    if (value.staticString !== undefined)
        return tableEntry(context, option, value.staticString, node);
    const type = value.dataType;
    if (type?.kind !== "enum")
        return context.fail(
            node,
            `A run-time ${option.name} requires a string literal union.`,
        );
    const selected = context.bindings.pinValueToTemporary(
        value,
        option.label,
        node,
    );
    const arms = context.dataTypes.enumMembers(type.name).map((member) => ({
        member: context.dataTypes.enumMemberCpp(type, member, node),
        spelling: tableEntry(context, option, member, node),
    }));
    return arms
        .slice(0, -1)
        .reduceRight(
            (rest, arm) =>
                `(${selected.cpp} == ${arm.member} ? ${arm.spelling} : ${rest})`,
            arms.at(-1)!.spelling,
        );
}
