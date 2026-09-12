import ts from "typescript";
import { browserGlobalNamed } from "./browser-erasure.js";
import { declaredInDefaultLibrary } from "./symbols.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { documentEngine } from "./window-events.js";

type Context = Pick<LoweringServices,
    "options" | "defaultEngine" | "checker" | "unwrap" | "lookupOptional" | "isDefaultLibraryIdentifier" |
    "isCanvasElement" | "reachFeature" | "fail" | "requireDefaultEngine" | "requireEngine" |
    "allocateTemporaryCppName" | "compileValue" | "compileCondition" | "compileStringLiteral" |
    "dataLowerer" | "dataTypes" | "hoistForwardCallbackBindings" |
    "compilePlatformCallback" | "pinValueToTemporary" | "cppString" | "emit">;

const pointerNames = new Set([
    "click", "dblclick", "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave",
    "pointerdown", "pointerup", "pointermove", "pointerover", "pointerout", "pointerenter", "pointerleave", "pointercancel",
    "wheel", "focus", "blur", "contextmenu", "resize",
]);

function listenerOptions(context: Context, expression: ts.Expression | undefined, removing: boolean): {capture:string; once:string; passive:string} {
    const result = {capture: "false", once: "false", passive: "false"};
    if (!expression) return result;
    const source = context.unwrap(expression);
    const type = context.checker.getTypeAtLocation(expression);
    if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) {
        result.capture = context.compileCondition(expression);
        return result;
    }
    if ((type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) return result;
    if (!ts.isObjectLiteralExpression(source)) {
        const owner = context.compileValue(expression);
        const properties: Record<string, Value> = {};
        if (owner.kind === "record") Object.assign(properties, owner.recordProperties);
        else if (owner.kind === "data" && owner.dataType?.kind === "struct") {
            const cpp = context.allocateTemporaryCppName("event_options");
            context.emit(`const auto ${cpp} = ${owner.cpp};`);
            const member = context.dataTypes.isReferenceStruct(owner.dataType.name) ? "->" : ".";
            for (const field of context.dataTypes.structFields(owner.dataType.name, expression))
                properties[field.name] = context.dataLowerer.leafValue(`${cpp}${member}${field.name}`, field.type);
        } else context.fail(expression, "Event listener options require a boolean or a represented options record.");
        if (!removing && properties.signal) context.fail(expression, "AbortSignal listener lifetime is not represented yet.");
        for (const name of ["capture", ...(!removing ? ["once", "passive"] as const : [])] as const) {
            const property = properties[name];
            if (!property) continue;
            const value = context.dataLowerer.conditionFromValue(property);
            if (value === undefined) context.fail(expression, `The event option '${name}' has no native boolean conversion.`);
            const cpp = context.allocateTemporaryCppName("event_option");
            context.emit(`const bool ${cpp} = ${value};`);
            result[name] = cpp;
        }
        return result;
    }
    for (const property of source.properties) {
        if ((!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
            (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)))
            context.fail(property, "Event listener options require named data properties.");
        const name = property.name.text;
        const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
        if (name === "capture" || (!removing && (name === "once" || name === "passive"))) {
            const cpp = context.compileCondition(initializer);
            const value = context.allocateTemporaryCppName("event_option");
            context.emit(`const bool ${value} = ${cpp};`);
            result[name] = value;
        } else if (!removing && name === "signal") {
            context.fail(property, "AbortSignal listener lifetime is not represented yet.");
        } else {
            // Object construction still evaluates unused properties.
            const value = context.compileValue(initializer);
            if (value.cpp) context.emit(`static_cast<void>(${value.cpp});`);
        }
    }
    return result;
}

/** One listener path for native DOM identities; error/visibility/file services
 * retain their own payloads until they join this dispatch contract. */
export function emitDomEventListener(context: Context, call: ts.CallExpression, element: Value | undefined,
    callbackIdentity: (value:Value, node:ts.Node) => string): boolean {
    const callee = context.unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || call.arguments.length < 2 || call.arguments.length > 3) return false;
    let target: string | undefined;
    let engine: string | undefined;
    if (element) {
        engine = context.requireEngine(element, call);
        const selected = {...element};
        delete selected.nativeBinding;
        const owner = context.pinValueToTemporary(selected, "event_target", callee.expression);
        target = `bbl::DomEventTarget::node(${owner.cpp}.value)`;
    } else {
        let global = browserGlobalNamed(context, callee.expression)?.text;
        if (!global) {
            const type = context.checker.getNonNullableType(context.checker.getTypeAtLocation(callee.expression));
            const symbol = type.getSymbol();
            if (symbol && declaredInDefaultLibrary(symbol) && symbol.name === "Document") global = "document";
        }
        if (global === "window" || global === "document") {
            target = `bbl::DomEventTarget::${global}()`;
            engine = documentEngine(context, call) ?? context.requireDefaultEngine(call);
        } else if (context.isCanvasElement(callee.expression)) {
            target = "bbl::DomEventTarget::canvas()";
            engine = context.requireDefaultEngine(call);
        } else {
            const type = context.dataLowerer.dataTypeAt(callee.expression);
            if (type?.kind === "event-target") {
                const value = context.dataLowerer.narrowOptional(context.compileValue(callee.expression), callee.expression);
                if (value.dataType?.kind !== "event-target") context.fail(callee.expression, "Nullable event targets require a presence guard.");
                const selected = {...value};
                delete selected.nativeBinding;
                const snapshot = context.pinValueToTemporary(selected, "event_target", callee.expression);
                target = `${snapshot.cpp}.target`;
                engine = `bbl::dom_target_owner(${snapshot.cpp})`;
            }
        }
    }
    if (!target || !engine) return false;
    const type = context.compileStringLiteral(call.arguments[0]!);
    if ((type === "focus" || type === "blur" || type === "resize") && target !== "bbl::DomEventTarget::window()") return false;
    const keyboard = type === "keydown" || type === "keyup";
    if (!keyboard && !pointerNames.has(type)) return false;
    context.reachFeature("input:dom", call);
    const callback = call.arguments[1]!;
    context.hoistForwardCallbackBindings(callback, call.pos);
    const removing = callee.name.text === "removeEventListener";
    const family = keyboard ? "keyboard" : "pointer";
    let identity: string;
    let listener: string | undefined;
    if (removing) {
        const value = context.compileValue(callback);
        const snapshot = {...value};
        delete snapshot.nativeBinding;
        const pinned = value.kind === "data" ? context.pinValueToTemporary(snapshot, "event_callback", callback) : value;
        identity = callbackIdentity(pinned, callback);
    } else {
        const name = context.allocateTemporaryCppName("dom_event");
        const compiled = context.compilePlatformCallback(callback, {
            cppType: keyboard ? "const bbl::PlatformKeyboardEvent&" : "const bbl::PlatformMouseEvent&", name,
        }, [{kind: keyboard ? "platform-keyboard-event" : "platform-mouse-event", cpp: name, readOnly: true, engineCpp: engine}]);
        identity = compiled.identity;
        listener = compiled.cpp;
    }
    const options = listenerOptions(context, call.arguments[2], removing);
    context.emit(`bbl::${removing ? "off" : "on"}_dom_${family}(${engine}, ${target}, ${context.cppString(type)}, ${identity}, ` +
        `${removing ? options.capture : `${listener}, ${options.capture}, ${options.once}, ${options.passive}`});`);
    return true;
}
