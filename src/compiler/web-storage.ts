import type { LoweringServices } from "./lowering-services.js";
// Web Storage references and the supported key/value methods.
import ts from "typescript";

import type { DataType } from "./data-types.js";
import { libraryName, namedMember } from "./symbols.js";
import { optionalPresentCpp, optionalValueCpp, type Value } from "./types.js";

/** The narrow slice of the expression context this lowering needs. */
interface WebStorageContext extends Pick<
    LoweringServices,
    | "unwrap"
    | "fail"
    | "libraryGlobal"
    | "reachFeature"
    | "reachJsData"
    | "dataLowerer"
    | "compileValue"
    | "allocateTemporaryCppName"
    | "emit"
    | "probeEmission"
    | "checker"
    | "options"
> {}

const stringType: DataType = { kind: "string" };

/** The reached Web Storage surface. */
export const STORAGE_METHODS: ReadonlySet<string> = new Set([
    "getItem",
    "setItem",
    "removeItem",
]);

/** The Web Storage area global an expression reads, through `window` too. */
function storageGlobal(
    context: WebStorageContext,
    expression: ts.Expression,
): "localStorage" | "sessionStorage" | undefined {
    const global = context.libraryGlobal(expression);
    return global === "localStorage" || global === "sessionStorage"
        ? global
        : undefined;
}

/**
 * `localStorage` or `sessionStorage`, read from the DOM rather than from a
 * scene's own binding. Worker realms expose neither in a browser; native
 * keeps `localStorage` there and refuses `sessionStorage`.
 */
export function compileWebStorageValue(
    context: WebStorageContext,
    expression: ts.Expression,
): Value | undefined {
    const global = storageGlobal(context, expression);
    if (!global) return undefined;
    context.reachJsData();
    if (global === "localStorage") {
        context.reachFeature("storage:local", expression);
        return storageValue("bbl::js::local_storage_object()");
    }
    if (context.options.workers?.namespace !== undefined)
        return context.fail(
            expression,
            "sessionStorage is not exposed to worker realms.",
        );
    context.reachFeature("storage:session", expression);
    return storageValue("bbl::js::session_storage_object()");
}

/**
 * A storage object and its methods. Each method reads the area's own
 * operation from the object, so `cpp` must name an already evaluated area.
 */
export function storageValue(cpp: string): Value {
    const method = (
        name: string,
        parameters: DataType[],
        result?: DataType,
    ): Value => ({
        kind: "data",
        cpp: `(${cpp})->${name}`,
        dataType: {
            kind: "function",
            parameters,
            ...(result ? { result } : {}),
        },
    });
    return {
        kind: "record",
        cpp,
        dataType: { kind: "storage" },
        truthinessCpp: `static_cast<bool>(${cpp})`,
        objectIdentityCpp: `(${cpp}).get()`,
        recordProperties: {
            getItem: method("get_item", [stringType], {
                kind: "optional",
                inner: stringType,
            }),
            setItem: method("set_item", [stringType, stringType]),
            removeItem: method("remove_item", [stringType]),
        },
    };
}

/**
 * The three reached Web Storage methods. A key is an ordinary runtime
 * string: the area owns its encoding, so nothing here has to decide
 * whether a particular key is safe.
 */
export function compileWebStorageCall(
    context: WebStorageContext,
    call: ts.CallExpression,
): Value | undefined {
    const callee = namedMember(
        context.checker,
        context.unwrap(call.expression),
    );
    if (!callee) return undefined;
    const global = storageGlobal(context, callee.expression);
    if (!global && !STORAGE_METHODS.has(callee.name)) {
        const type = context.checker.getNonNullableType(
            context.checker.getTypeAtLocation(callee.expression),
        );
        if (libraryName(type) !== "Storage") return undefined;
    }
    const owner = context.probeEmission(() => {
        const value = context.compileValue(callee.expression);
        const type =
            value.dataType?.kind === "optional"
                ? value.dataType.inner
                : value.dataType;
        return type?.kind === "storage" ? value : undefined;
    });
    if (!owner) return undefined;
    const receiver = context.allocateTemporaryCppName("storage_receiver");
    context.emit({
        kind: "declaration",
        type: "const auto",
        name: receiver,
        initializer: owner.cpp,
        attributes: "[[maybe_unused]] ",
    });
    const optional = owner.dataType?.kind === "optional";
    const callback = storageValue(
        optional ? optionalValueCpp(receiver) : receiver,
    ).recordProperties?.[callee.name];
    if (callback?.dataType?.kind !== "function")
        return context.fail(
            callee.key,
            `${global ?? "Storage"}.${callee.name} is not lowered; the reached Web Storage surface is getItem, setItem and removeItem.`,
        );
    return context.dataLowerer.compileStoredCall(
        call,
        callback.cpp,
        callback.dataType,
        optional ? optionalPresentCpp(receiver) : receiver,
    );
}
