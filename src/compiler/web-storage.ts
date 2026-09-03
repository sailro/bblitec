// Web Storage: `localStorage.getItem`, `setItem` and `removeItem`.
//
// `localStorage` is a browser object with no Babylon declaration behind
// it, so there is no pinned module to lower from -- it is a platform
// service, like the frame conductor's timers, and the PAL owns it. This
// module is only the recognition and the shapes: it decides that the
// identifier really is the DOM global (and not something a scene bound
// itself), lowers the key as an ordinary string, and hands the call to
// `bbl::js::local_storage_*`.
//
// The shapes are the browser's, because the source's own control flow
// reads them. `getItem` answers a nullable string, so an absent key stays
// distinguishable from an empty value and `if (!raw)` decides over both.
// `setItem` and `removeItem` return nothing and let a platform failure
// throw, which is where the browser throws its quota error -- so a scene's
// `try`/`catch` around a save observes the same arm rather than a silent
// success.

import ts from "typescript";

import { browserGlobalNamed } from "./browser-erasure.js";
import type { DataType } from "./data-types.js";
import type { Feature, Value } from "./types.js";

/** The narrow slice of the expression context this lowering needs. */
export interface WebStorageContext {
    unwrap(expression: ts.Expression): ts.Expression;
    fail(node: ts.Node, message: string): never;
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    isDefaultLibraryIdentifier(identifier: ts.Identifier): boolean;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    reachFeature(feature: Feature, site?: ts.Node): void;
    reachJsData(): void;
    reachLocalStorage(): void;
    readonly dataLowerer: {
        compileForSink(expression: ts.Expression, dataType: DataType): string;
    };
}

const stringType: DataType = { kind: "string" };

/**
 * `localStorage`, read from the DOM rather than from a scene's own
 * binding. `window.localStorage` is the same object under its owner.
 */
function isLocalStorage(
    context: WebStorageContext,
    expression: ts.Expression,
): boolean {
    return browserGlobalNamed(context, expression)?.text === "localStorage";
}

/**
 * The three reached Web Storage methods. A key is an ordinary runtime
 * string: the PAL encodes it injectively into a file name, so nothing here
 * has to decide whether a particular key is safe.
 */
export function compileWebStorageCall(
    context: WebStorageContext,
    call: ts.CallExpression,
): Value | undefined {
    const callee = context.unwrap(call.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        !isLocalStorage(context, callee.expression)
    ) {
        return undefined;
    }
    const method = callee.name.text;
    if (
        method !== "getItem" &&
        method !== "setItem" &&
        method !== "removeItem"
    ) {
        context.fail(
            callee.name,
            `localStorage.${method} is not lowered; the reached Web Storage ` +
                "surface is getItem, setItem and removeItem.",
        );
    }
    context.reachLocalStorage();
    context.reachFeature("storage:local", call);
    context.reachJsData();
    const key = (): string =>
        context.dataLowerer.compileForSink(call.arguments[0]!, stringType);
    if (method === "getItem") {
        context.expectArgumentCount(call, 1, 1);
        return {
            kind: "data",
            cpp: `bbl::js::local_storage_get_item(${key()})`,
            dataType: { kind: "optional", inner: stringType },
            nullableStringFalsy: true,
        };
    }
    if (method === "removeItem") {
        context.expectArgumentCount(call, 1, 1);
        return {
            kind: "void",
            cpp: `bbl::js::local_storage_remove_item(${key()})`,
        };
    }
    context.expectArgumentCount(call, 2, 2);
    const storedKey = key();
    const value = context.dataLowerer.compileForSink(
        call.arguments[1]!,
        stringType,
    );
    return {
        kind: "void",
        cpp: `bbl::js::local_storage_set_item(${storedKey}, ${value})`,
    };
}
