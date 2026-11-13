import type ts from "typescript";
import type { DataLowerer } from "../data-lowering.js";
import type { DataKind, DataType } from "../data-types/model.js";
import type { Value } from "../types.js";

export type DataSinkHost = Pick<
    DataLowerer,
    | "context"
    | "compileStringSink"
    | "compileKnownValueForSink"
    | "compileMemberForSink"
    | "storeLiteralMember"
    | "convertedExpression"
    | "convertedElementOf"
    | "recordMemberEntry"
    | "ownObjectContext"
    | "compileForSink"
    | "compileDataPath"
    | "narrowOptional"
    | "compileOptionalSink"
    | "compileNullishCoalesce"
    | "emitSpreadStructDeclaration"
    | "registerLocal"
    | "structLiteral"
    | "markEscaped"
    | "requireDataValue"
    | "enumMapLiteral"
    | "compileVectorSink"
    | "noteConstructedArray"
    | "requireStoredStructSource"
    | "openRecordLiteral"
    | "compileMapOrSetNew"
    | "compileTypedArrayNew"
    | "spanLikeForSink"
    | "dataTypeAt"
    | "leafValue"
    | "spanCompatible"
    | "invalidateEscapingCollection"
    | "knownValueFitsSink"
    | "noteArgumentsPastSignature"
    | "connectFunctionStorage"
    | "requireNumericSlot"
    | "requireArrayBindingElements"
>;

/** Every data kind declares expression and already-evaluated value conversion. */
export type DataSinkOperations<K extends DataKind = DataKind> = {
    [P in K]: {
        expression(
            type: DataType<P>,
            lowerer: DataSinkHost,
            expression: ts.Expression,
            unwrapped: ts.Expression,
        ): string;
        value(
            type: DataType<P>,
            lowerer: DataSinkHost,
            value: Value,
            node: ts.Node,
        ): string | undefined;
    };
};

/** A sink's expression conversion: the value `unwrapped` lowers to, stored at it. */
export function unwrappedKnownValue(
    type: DataType,
    lowerer: DataSinkHost,
    _expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    return lowerer.compileKnownValueForSink(
        lowerer.context.compileValue(unwrapped),
        type,
        unwrapped,
    );
}

/** A sink's expression conversion: the value `expression` lowers to, stored at it. */
export function expressionKnownValue(
    type: DataType,
    lowerer: DataSinkHost,
    expression: ts.Expression,
): string {
    return lowerer.compileKnownValueForSink(
        lowerer.context.compileValue(expression),
        type,
        expression,
    );
}
