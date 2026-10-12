import ts from "typescript";
import {
    abortProperty,
    compileAbortListenerCall,
    compileAbortMethod,
    compileAbortNew,
    type WebPlatformCallContext,
} from "./abort-signals.js";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import type { Value } from "./types.js";

/**
 * One entry point per lowering hook for the runtime web platform objects:
 * constructors, property reads and method calls on their native values.
 */

const METHOD_OWNERS: ReadonlySet<DataType["kind"]> = new Set([
    "abort-controller",
    "abort-signal",
]);

export function compileWebPlatformNew(
    lowerer: DataLowerer,
    node: ts.NewExpression,
): Value | undefined {
    return compileAbortNew(lowerer, node);
}

export function webPlatformProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
): Value | undefined {
    return abortProperty(lowerer, owner, property);
}

/** Calls that need the full lowering services: listeners and global functions. */
export function compileWebPlatformCall(
    context: WebPlatformCallContext,
    call: ts.CallExpression,
): Value | undefined {
    return compileAbortListenerCall(context, call);
}

/** A method of a web platform value, or undefined for another receiver. */
export function compileWebPlatformMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value | undefined {
    const kind = owner.dataType?.kind;
    if (!kind || !METHOD_OWNERS.has(kind)) return undefined;
    return compileAbortMethod(lowerer, call, owner, method);
}
