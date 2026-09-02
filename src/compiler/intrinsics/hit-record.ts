import ts from "typescript";
import type { DataType, DataTypeRegistry } from "../data-types.js";
import type { Value } from "../types.js";

/**
 * The nullable hit record a synchronous pick answers with.
 *
 * Both pick surfaces this port reaches return the same SHAPE -- upstream's
 * `SpritePickInfo | null` and `BillboardPickInfo | null` -- and the shape
 * is what costs code: the record may arrive as an optional value struct or
 * as a reference struct, its fields have to be validated against what this
 * port can fill, and the native answer has to be tested for a miss before
 * the record is built. Written per intrinsic, that is forty lines twice,
 * with the reference-vs-value fork -- the half most likely to move with the
 * data model -- stated in both.
 *
 * So it is stated here once, and the fork itself defers to
 * `DataLowerer.structAggregate`, whose own doc says it is the one place
 * that fork lives. What each intrinsic still owns is the only part that
 * differs: which native call produces the answer, what a miss looks like,
 * and which field each member reads.
 */

/** One member of the record, and the native expression that fills it. */
export interface HitRecordField {
    /** The C++ expression, in terms of the probe's own local. */
    readonly cpp: string;
    /** Whether the pin's declared type for it is one this port fills. */
    readonly accepts: (type: DataType) => boolean;
}

/** The commonest `HitRecordField.accepts`: a plain number lane. */
export const numberField = (type: DataType): boolean =>
    type.kind === "number";

export interface HitRecordContext {
    readonly dataTypes: DataTypeRegistry;
    readonly checker: ts.TypeChecker;
    readonly dataLowerer: {
        structAggregate(
            dataType: DataType & { kind: "struct" },
            parts: readonly string[],
        ): string;
    };
    fail(node: ts.Node, message: string): never;
}

export interface NullableHitRecord {
    /** The intrinsic's own name, for the refusals below. */
    readonly intrinsic: string;
    /** The record type at the call site, already unwrapped from a promise. */
    readonly resultType: DataType | undefined;
    /** One entry per member the pin declares; an unlisted one refuses. */
    readonly fields: Readonly<Record<string, HitRecordField>>;
    /** The statement that produces the native answer. */
    readonly probe: string;
    /** The condition under which that answer is a miss. */
    readonly miss: string;
}

export function compileNullableHitRecord(
    context: HitRecordContext,
    call: ts.CallExpression,
    record: NullableHitRecord,
): Value {
    const resultType = record.resultType;
    // Either shape the data model gives a nullable record: an optional
    // wrapping a value struct, or a reference struct (which carries null
    // itself, so the model never wraps one).
    const resultStruct =
        resultType?.kind === "optional" &&
        resultType.inner.kind === "struct"
            ? resultType.inner
            : resultType?.kind === "struct" &&
                context.dataTypes.isReferenceStruct(resultType.name)
              ? resultType
              : undefined;
    if (!resultType || !resultStruct) {
        context.fail(
            call,
            `${record.intrinsic} must return the pin's own nullable hit ` +
                "record.",
        );
    }
    const declared = context.dataTypes.structFields(
        resultStruct.name,
        call,
    );
    const names = Object.keys(record.fields);
    if (declared.length !== names.length) {
        context.fail(
            call,
            `${record.intrinsic} hit record must retain ` +
                `${names.join(", ")}.`,
        );
    }
    for (const field of declared) {
        const rule = record.fields[field.name];
        if (rule === undefined) {
            context.fail(
                call,
                `${record.intrinsic} hit record has unsupported field ` +
                    `'${field.name}'.`,
            );
        }
        if (!rule.accepts(field.type)) {
            context.fail(
                call,
                `${record.intrinsic} hit record field '${field.name}' ` +
                    "has an unsupported type.",
            );
        }
    }
    const cppType = context.dataTypes.cppType(resultType);
    const referenceBacked = resultType.kind === "struct";
    const aggregate = context.dataLowerer.structAggregate(
        resultStruct,
        declared.map((field) => record.fields[field.name]!.cpp),
    );
    return {
        kind: "data",
        cpp:
            `([&]() -> ${cppType} { ${record.probe} ` +
            `if (${record.miss}) return ${
                referenceBacked ? `${cppType}{}` : `${cppType}{std::nullopt}`
            }; ` +
            `return ${referenceBacked ? aggregate : `${cppType}{${aggregate}}`}; }())`,
        dataType: resultType,
    };
}
