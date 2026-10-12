import ts from "typescript";
import {
    abortProperty,
    compileAbortListenerCall,
    compileAbortMethod,
    compileAbortNew,
    type WebPlatformCallContext,
} from "./abort-signals.js";
import { bodyStreamProperty, compileBodyStreamMethod } from "./body-streams.js";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import type { Value } from "./types.js";
import {
    compileUrlAssignment,
    compileUrlMethod,
    compileUrlNew,
    urlProperty,
} from "./urls.js";

/**
 * One entry point per lowering hook for the runtime web platform objects:
 * constructors, property reads and method calls on their native values.
 */

type MethodLowerer = (
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
) => Value;

const METHOD_OWNERS: ReadonlyMap<DataType["kind"], MethodLowerer> = new Map([
    ["abort-controller", compileAbortMethod],
    ["abort-signal", compileAbortMethod],
    ["http-headers", compileBodyStreamMethod],
    ["byte-stream", compileBodyStreamMethod],
    ["byte-stream-reader", compileBodyStreamMethod],
    ["url", compileUrlMethod],
]);

export function compileWebPlatformNew(
    lowerer: DataLowerer,
    node: ts.NewExpression,
): Value | undefined {
    return compileAbortNew(lowerer, node) ?? compileUrlNew(lowerer, node);
}

/** `object.component = value` (or `+=`) on a web platform value; undefined for other targets. */
export function compileWebPlatformAssignment(
    lowerer: DataLowerer,
    expression: ts.BinaryExpression,
): Value | undefined {
    return compileUrlAssignment(lowerer, expression);
}

/** A property of a web platform value; `access` is the read's site, when known. */
export function webPlatformProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
    access?: ts.Node,
): Value | undefined {
    return (
        abortProperty(lowerer, owner, property) ??
        urlProperty(lowerer, owner, property) ??
        bodyStreamProperty(lowerer, owner, property, access)
    );
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
    const type = owner.dataType;
    const optional = type?.kind === "optional";
    const lower = METHOD_OWNERS.get(
        (optional ? type.inner : type)?.kind ?? "undefined",
    );
    if (!lower) return undefined;
    // `owner?.method()` runs only on a present owner; a plain call on an absent one throws.
    return optional
        ? lowerer.optionalAccess(owner, call, (present) =>
              lower(lowerer, call, present, method),
          )
        : lower(lowerer, call, owner, method);
}
