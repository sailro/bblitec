import type { LoweringServices } from "./lowering-services.js";
// Web Storage references and the supported durable key/value methods.
import ts from "typescript";

import { browserGlobalNamed } from "./browser-erasure.js";
import { declaredInDomLibrary, type DataType } from "./data-types.js";
import type { Value } from "./types.js";

/** The narrow slice of the expression context this lowering needs. */
interface WebStorageContext
    extends Pick<LoweringServices,
        | "unwrap"
        | "fail"
        | "isDefaultLibraryIdentifier"
        | "lookupOptional"
        | "reachFeature"
        | "reachJsData"
        | "reachLocalStorage"
        | "dataLowerer"
        | "compileValue"
        | "allocateTemporaryCppName"
        | "emit"
        | "probeEmission"
        | "checker"
    > {}

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

/** A storage dependency can be passed through ordinary method-bearing records. */
export function compileWebStorageValue(context: WebStorageContext, expression: ts.Expression): Value | undefined {
    if (!isLocalStorage(context, expression)) return undefined;
    context.reachLocalStorage();
    context.reachFeature("storage:local", expression);
    context.reachJsData();
    return storageValue("bbl::js::local_storage_object()");
}

/** Stored references expose the same native object and method surface. */
export function storageValue(cpp: string): Value {
    const method = (name: string, parameters: DataType[], result?: DataType): Value => ({
        kind: "data", cpp: `bbl::js::local_storage_${name}`,
        dataType: {kind:"function", parameters, ...(result ? {result} : {})},
    });
    return { kind: "record", cpp, dataType:{kind:"storage"}, truthinessCpp:`static_cast<bool>(${cpp})`, objectIdentityCpp:`(${cpp}).get()`, recordProperties: {
        getItem: method("get_item", [stringType], {kind:"optional", inner:stringType}),
        setItem: method("set_item", [stringType, stringType]),
        removeItem: method("remove_item", [stringType]),
    } };
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
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    if (!isLocalStorage(context, callee.expression) && !["getItem", "setItem", "removeItem"].includes(callee.name.text)) {
        const type = context.checker.getNonNullableType(context.checker.getTypeAtLocation(callee.expression));
        if (type.symbol?.name !== "Storage" || !declaredInDomLibrary(type.symbol)) return undefined;
    }
    const owner = context.probeEmission(() => {
        const value = context.compileValue(callee.expression);
        const type = value.dataType?.kind === "optional" ? value.dataType.inner : value.dataType;
        return type?.kind === "storage" ? value : undefined;
    });
    if (!owner) return undefined;
    const storage = storageValue(owner.cpp);
    const callback = storage.recordProperties?.[callee.name.text];
    if (callback?.dataType?.kind !== "function") context.fail(callee.name,
        `localStorage.${callee.name.text} is not lowered; the reached Web Storage surface is getItem, setItem and removeItem.`);
    const receiver = context.allocateTemporaryCppName("storage_receiver");
    context.emit({kind:"declaration", type:"const auto", name:receiver, initializer:owner.cpp, attributes:"[[maybe_unused]] "});
    return context.dataLowerer.compileStoredCall(call, callback.cpp, callback.dataType,
        owner.dataType?.kind === "optional" ? `${receiver}.has_value()` : receiver);
}
