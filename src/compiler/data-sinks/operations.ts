import type ts from "typescript";
import type { DataKind, DataType } from "../data-types/model.js";
import type { Value } from "../types.js";
import type { DataSinkHost, DataSinkOperations } from "./contracts.js";
import { scalarsSinks } from "./scalars.js";
import { functionsSinks } from "./functions.js";
import { structuresSinks } from "./structures.js";
import { containersSinks } from "./containers.js";
import { resourcesSinks } from "./resources.js";
import { unionsSinks } from "./unions.js";

const sinks: DataSinkOperations = { ...scalarsSinks, ...functionsSinks, ...structuresSinks, ...containersSinks, ...resourcesSinks, ...unionsSinks };

export function compileDataExpressionSink<K extends DataKind>(type: DataType<K>, lowerer: DataSinkHost, expression: ts.Expression, unwrapped: ts.Expression): string {
    return sinks[type.kind].expression(type, lowerer, expression, unwrapped);
}

export function compileDataValueSink<K extends DataKind>(type: DataType<K>, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    return sinks[type.kind].value(type, lowerer, value, node);
}
