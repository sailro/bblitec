import type ts from "typescript";
import type { DataLowerer } from "../data-lowering.js";
import type { DataKind, DataType } from "../data-types/model.js";
import type { Value } from "../types.js";

export type DataSinkHost = Pick<DataLowerer,
    | "context" | "compileStringSink" | "compileKnownValueForSink"
    | "compileForSink" | "compileDataPath" | "narrowOptional"
    | "compileOptionalSink" | "compileNullishCoalesce" | "emitSpreadStructDeclaration"
    | "registerLocal" | "structLiteral" | "markEscaped" | "requireDataValue"
    | "enumMapLiteral" | "compileVectorSink" | "openRecordLiteral"
    | "compileMapOrSetNew" | "compileTypedArrayNew" | "spanLikeForSink"
    | "dataTypeAt" | "leafValue" | "spanCompatible" | "invalidateEscapingCollection" | "knownValueFitsSink"
>;

/** Every data kind declares expression and already-evaluated value conversion. */
export type DataSinkOperations<K extends DataKind = DataKind> = {
    [P in K]: {
        expression(type: DataType<P>, lowerer: DataSinkHost, expression: ts.Expression, unwrapped: ts.Expression): string;
        value(type: DataType<P>, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined;
    };
};
