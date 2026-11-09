import ts from "typescript";
import { EmissionWeakMap } from "./emission-transaction.js";
import {
    DynamicBindingStorageRequired,
    demandedStorageType,
} from "./dynamic-binding-storage.js";
import { constInitializer } from "./browser-erasure.js";
import { literalMember, unwrapExpression } from "./syntax.js";
import type { CapturedClosure } from "./closure-captures.js";
import type { Value } from "./types.js";
import type { DataSinkHost } from "./data-sinks/contracts.js";

// Record aliases share this table even when an inline call renames the value.
const views = new EmissionWeakMap<object, Value>();

function sharedGetter(
    lowerer: DataSinkHost,
    body: CapturedClosure,
    parameter: string,
    parameterType: string,
): string {
    const context = lowerer.context;
    const name = context.allocateTemporaryCppName("dynamic_view_getter");
    const shared = context.nativeEmission.registerSharedNativeFunction(
        name,
        [
            `struct ${name} {`,
            "    template<typename Environment>",
            `    bbl::js::JsonValue operator()([[maybe_unused]] Environment& ${body.environment}, [[maybe_unused]] ${parameterType} ${parameter}) const {`,
            ...body.lines.map((line) => `        ${line}`),
            "    }",
            "};",
        ],
        [...body.localBindings, body.environment, parameter],
    );
    return `bbl::js::make_closure(${body.initializer}, bblscene::${shared}{})`;
}

/**
 * The literal a stored value was written as: the stored expression itself,
 * or the initializer of the const it names. A view's members are that
 * literal's members (`literalMember`).
 */
export function viewLiteral(
    lowerer: DataSinkHost,
    node: ts.Node,
): ts.Expression | undefined {
    const converted = lowerer.convertedExpression(node);
    const expression = converted && unwrapExpression(converted);
    return expression && ts.isIdentifier(expression)
        ? constInitializer(lowerer.context, expression)
        : expression;
}

/**
 * The members of the value a sink at `node` stores, one after another,
 * each joining the demands later members meet (`storeLiteralMember`); a
 * member the stored literal writes (`viewLiteral`) is named by its
 * expression there.
 */
export function storeMembers<M>(
    lowerer: DataSinkHost,
    node: ts.Node,
    members: readonly M[],
    key: (member: M) => string | number,
    store: (member: M) => string,
): string[] {
    const literal = viewLiteral(lowerer, node);
    return members.map((_, index) =>
        lowerer.storeLiteralMember(
            members,
            index,
            (member) => literal && literalMember(literal, key(member)),
            store,
        ),
    );
}

export function compileJsonTupleView(
    lowerer: DataSinkHost,
    tuple: Value,
    node: ts.Node,
    literal: ts.Expression | undefined = viewLiteral(lowerer, node),
): string | undefined {
    const elements = tuple.tupleElements;
    if (tuple.kind !== "tuple" || !elements || tuple.cpp) return undefined;
    const context = lowerer.context;
    const previous = views.get(elements);
    if (previous) {
        context.useNativeValue(previous);
        return previous.cpp;
    }
    const members = elements.map((value, slot) => {
        const expression = literal && literalMember(literal, slot);
        const nested =
            compileJsonRecordView(lowerer, value, node, expression) ??
            compileJsonTupleView(lowerer, value, node, expression);
        return {
            value: nested ? lowerer.leafValue(nested, { kind: "json" }) : value,
            expression,
            slot,
        };
    });
    const index = context.allocateTemporaryCppName("dynamic_index");
    const body = context.captureManagedClosureLines(() => {
        context.registerNativeBinding(index);
        members.forEach((_, slot) => {
            const cpp = lowerer.storeLiteralMember(
                members,
                slot,
                (member) => member.expression,
                (member) =>
                    lowerer.compileMemberForSink(
                        member.value,
                        { kind: "json" },
                        node,
                        member.slot,
                    ),
            );
            context.emit(`if (${index} == ${slot}) return ${cpp};`);
        });
        context.emit({
            kind: "control",
            code: "return {};",
            transfer: "return",
        });
    });
    const cpp = context.allocateTemporaryCppName("dynamic_tuple_view");
    context.emit({
        kind: "declaration",
        type: "auto",
        name: cpp,
        initializer: `bbl::js::JsonValue::from_tuple_view(${sharedGetter(lowerer, body, index, "std::size_t")}, ${members.length})`,
    });
    const result = {
        ...lowerer.leafValue(cpp, { kind: "json" }),
        nativeCaptures: [
            context.registerNativeBinding(
                cpp,
                false,
                false,
                "bbl::js::JsonValue",
            ),
        ],
    };
    views.set(elements, result);
    context.useNativeValue(result);
    return cpp;
}

/** Plain record facts that either JSON ownership strategy can preserve. */
export function isPlainJsonRecord(record: Value): boolean {
    return (
        record.kind === "record" &&
        !record.classDeclaration &&
        !record.moduleNamespace &&
        !record.objectIdentityCpp &&
        Object.keys(record.recordMethods ?? {}).length === 0 &&
        Object.keys(record.recordGetters ?? {}).length === 0 &&
        Object.keys(record.recordSetters ?? {}).length === 0
    );
}

/** A fixed plain record keeps its existing cells behind an observing view. */
export function compileJsonRecordView(
    lowerer: DataSinkHost,
    record: Value,
    node: ts.Node,
    literal: ts.Expression | undefined = viewLiteral(lowerer, node),
): string | undefined {
    const properties = record.recordProperties;
    // A view lists its keys once; a key a conditional spread wrote is own
    // only while its value is present.
    if (
        !isPlainJsonRecord(record) ||
        !properties ||
        Object.values(properties).some((member) => member.conditionalOwnKey)
    )
        return undefined;
    const context = lowerer.context;
    const expression = lowerer.convertedExpression(node);
    const declaration =
        expression && context.bindings.recordDeclaration(record, expression);
    // A binding whose type has no native storage (an open record of unknown
    // values) keeps the observing view below over its existing cells.
    if (
        declaration &&
        demandedStorageType(
            context,
            declaration,
            "source",
            declaration.initializer &&
                unwrapExpression(declaration.initializer),
        )
    ) {
        // A retained alias needs one owner in the source binding's scope.
        // A cached view created here could belong to a nested callback.
        if (context.dynamicBindings.has(declaration))
            context.fail(
                node,
                "A retained record requires a represented document owner.",
            );
        throw new DynamicBindingStorageRequired(declaration, "source");
    }
    const previous = views.get(properties);
    if (previous) {
        context.useNativeValue(previous);
        return previous.cpp;
    }
    // This path retains the original property table and mutable scalar cells.
    // Supplying a source expression here could instead construct a second record.
    context.bindings.materializeEscapingValue(record, "dynamic_record");
    const fields = Object.entries(properties).map(([name, value]) => {
        const expression = literal && literalMember(literal, name);
        const nested =
            compileJsonRecordView(lowerer, value, node, expression) ??
            compileJsonTupleView(lowerer, value, node, expression);
        return {
            name,
            value: nested ? lowerer.leafValue(nested, { kind: "json" }) : value,
            expression,
        };
    });
    const key = context.allocateTemporaryCppName("dynamic_key");
    const body = context.captureManagedClosureLines(() => {
        context.registerNativeBinding(key);
        for (const [index, field] of fields.entries()) {
            const value = lowerer.storeLiteralMember(
                fields,
                index,
                (member) => member.expression,
                (member) =>
                    lowerer.compileMemberForSink(
                        member.value,
                        { kind: "json" },
                        node,
                        member.name,
                    ),
            );
            context.emit(
                `if (${key} == ${context.cppString(field.name)}) return ${value};`,
            );
        }
        context.emit({
            kind: "control",
            code: "return {};",
            transfer: "return",
        });
    });
    const cpp = context.allocateTemporaryCppName("dynamic_record_view");
    context.emit({
        kind: "declaration",
        type: "auto",
        name: cpp,
        initializer:
            `bbl::js::JsonValue::from_record_view(${sharedGetter(lowerer, body, key, "std::string_view")}, ` +
            `bbl::js::Array<std::string>{${fields.map((field) => context.cppString(field.name)).join(", ")}})`,
    });
    const result = {
        ...lowerer.leafValue(cpp, { kind: "json" }),
        nativeCaptures: [
            context.registerNativeBinding(
                cpp,
                false,
                false,
                "bbl::js::JsonValue",
            ),
        ],
    };
    views.set(properties, result);
    context.useNativeValue(result);
    return cpp;
}
