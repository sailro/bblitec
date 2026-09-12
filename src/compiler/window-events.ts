import ts from "typescript";
import { browserGlobalNamed } from "./browser-erasure.js";
import { errorValue } from "./error-values.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import type { DataLowerer } from "./data-lowering.js";

type WindowContext = Pick<LoweringServices, "options" | "unwrap" | "lookupOptional" | "isDefaultLibraryIdentifier" | "reachFeature" | "cppString" | "fail">;

/** Retained host method aliases use the same operation as a direct call. */
export function compileWindowServiceCall(lowerer: DataLowerer, call: ts.CallExpression, hostFunction?: Value["hostFunction"]): Value | undefined {
    const context = lowerer.context;
    const callee = context.unwrap(call.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "reload" &&
        browserGlobalNamed(context, callee.expression)?.text === "location") {
        if (!context.options.workers) context.fail(call, "Location reload requires an asynchronous application realm.");
        requireWindowHost(context, call);
        context.expectArgumentCount(call, 0, 0);
        return {kind:"void", cpp:"bbl::pal::window_location_reload()"};
    }
    if (hostFunction !== "clipboard-write") return undefined;
    if (!context.options.workers) context.fail(call, "Clipboard promises require an asynchronous application realm.");
    requireWindowHost(context, call);
    context.expectArgumentCount(call, 1, 1);
    return lowerer.leafValue(`bbl::pal::window_clipboard_write(${lowerer.compileForSink(call.arguments[0]!, {kind:"string"})})`, {kind:"promise"});
}

export function requireWindowHost(context: Pick<LoweringServices, "options" | "reachFeature" | "fail">, node: ts.Node): void {
    if (context.options.workers?.namespace) context.fail(node, "This Window API requires an application realm.");
    context.reachFeature("platform:window", node);
    context.reachFeature("ui:rml", node);
}

/** DOM handles belong to the Window document in application realms, even when
 * that realm also owns a rendering engine. Synchronous scenes use their engine. */
export function documentEngine(context: Pick<LoweringServices, "options" | "defaultEngine" | "reachFeature" | "fail">, node: ts.Node): string | undefined {
    if (!context.options.workers) return context.defaultEngine();
    requireWindowHost(context, node);
    return "bbl::pal::window_document_engine()";
}

function windowIdentity(): Value {
    const cpp = "std::addressof(bbl::pal::window_document_engine())";
    return { kind: "record", cpp, objectIdentityCpp: cpp, truthinessCpp: "true", recordProperties: {} };
}

export function compileWindowIdentity(context: WindowContext, expression: ts.Expression): Value | undefined {
    if (!context.options.workers || context.options.workers.namespace) return undefined;
    const global = browserGlobalNamed(context, expression)?.text;
    if (global === "document") {
        requireWindowHost(context, expression);
        const cpp = "bbl::pal::window_document_identity()";
        return {kind:"record", cpp, objectIdentityCpp:cpp, truthinessCpp:"true", recordProperties:{}};
    }
    if (global === "screen") {
        requireWindowHost(context, expression);
        const recordProperties: Record<string, Value> = {};
        for (const [name, field] of Object.entries({width:"width", height:"height", availWidth:"available_width", availHeight:"available_height", colorDepth:"color_depth", pixelDepth:"color_depth"})) {
            recordProperties[name] = {kind:"number", cpp:`bbl::pal::window_screen_metrics().${field}`, readOnly:true};
        }
        return {kind:"record", cpp:"", objectIdentityCpp:"bbl::pal::window_screen_identity()", truthinessCpp:"true", recordProperties};
    }
    if (!["window", "globalThis"].includes(global ?? "")) return undefined;
    requireWindowHost(context, expression);
    return windowIdentity();
}

/** Error events borrow their native payload for the synchronous dispatch. */
export function windowErrorEventValue(context: Pick<LoweringServices, "cppString">, cpp: string, rejection: boolean): Value {
    const message: Value = { kind: "string", cpp: `${cpp}.message` };
    const error = errorValue(message, "Error", text => context.cppString(text));
    return { kind: "record", cpp, nativeErrorEvent: true, truthinessCpp: "true", recordProperties: {
        type: { kind: "string", cpp: context.cppString(rejection ? "unhandledrejection" : "error"), staticString: rejection ? "unhandledrejection" : "error" },
        target: windowIdentity(), currentTarget: windowIdentity(),
        cancelable: { kind: "boolean", cpp: "true", staticBoolean: true },
        defaultPrevented: { kind: "boolean", cpp: `${cpp}.default_prevented` },
        ...(rejection ? { reason: error } : {
            error, message,
            filename: { kind: "string" as const, cpp: context.cppString(""), staticString: "" },
            lineno: { kind: "number" as const, cpp: "0.0", staticNumber: 0 },
            colno: { kind: "number" as const, cpp: "0.0", staticNumber: 0 },
        }),
    } };
}
