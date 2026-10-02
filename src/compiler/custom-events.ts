import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { declaredInDefaultLibrary } from "./symbols.js";
import { domTargetIdentity } from "./dom-targets.js";
import { isCustomDomEventName, pinDetached } from "./dom-listeners.js";

type Context = Pick<
    LoweringServices,
    | "unwrap"
    | "libraryGlobal"
    | "checker"
    | "compileValue"
    | "dataLowerer"
    | "allocateTemporaryCppName"
    | "emit"
    | "reachFeature"
    | "fail"
    | "requireDefaultEngine"
    | "defaultEngine"
    | "options"
    | "compileStringLiteral"
    | "bindings"
>;

export function compileCustomEventConstructor(
    context: Omit<Context, "defaultEngine">,
    node: ts.NewExpression,
): Value | undefined {
    if (context.libraryGlobal(node.expression) !== "CustomEvent")
        return undefined;
    const args = node.arguments ?? [];
    if (args.length < 1 || args.length > 2)
        context.fail(
            node,
            "CustomEvent requires a type and optional initialization record.",
        );
    if (!isCustomDomEventName(context.compileStringLiteral(args[0]!)))
        context.fail(
            args[0]!,
            "CustomEvent names cannot reuse a native event payload or service channel.",
        );
    context.reachFeature("input:dom", node);
    context.reachFeature("data:json", node);
    const type = context.allocateTemporaryCppName("custom_event_type");
    context.emit({
        kind: "declaration",
        type: "const std::string",
        name: type,
        initializer: context.dataLowerer.compileForSink(args[0]!, {
            kind: "string",
        }),
    });
    const options = args[1]
        ? context.dataLowerer.compileForSink(args[1], { kind: "json" })
        : "bbl::js::JsonValue::null_value()";
    return {
        kind: "custom-event",
        dataType: { kind: "handle", handle: "custom-event" },
        cpp: `bbl::custom_event_from_options(${type}, ${options})`,
        impure: true,
    };
}

export function customEventDispatchTarget(
    context: Pick<Context, "unwrap" | "libraryGlobal" | "checker">,
    call: ts.CallExpression,
): "document" | "window" | undefined {
    const callee = context.unwrap(call.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        callee.name.text !== "dispatchEvent"
    )
        return undefined;
    let target = context.libraryGlobal(callee.expression);
    if (!target) {
        const symbol = context.checker
            .getNonNullableType(
                context.checker.getTypeAtLocation(callee.expression),
            )
            .getSymbol();
        if (
            symbol &&
            declaredInDefaultLibrary(symbol) &&
            (symbol.name === "Document" || symbol.name === "Window")
        )
            target = symbol.name === "Document" ? "document" : "window";
    }
    if (target !== "document" && target !== "window") return undefined;
    return target;
}

export function compileCustomEventDispatch(
    context: Context,
    call: ts.CallExpression,
): Value | undefined {
    const callee = context.unwrap(call.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        callee.name.text !== "dispatchEvent"
    )
        return undefined;
    if (call.arguments.length !== 1)
        context.fail(call, "dispatchEvent requires one event.");
    const type = context.dataLowerer.dataTypeAt(call.arguments[0]!);
    if (
        !customEventDispatchTarget(context, call) &&
        !(type?.kind === "handle" && type.handle === "custom-event")
    )
        return undefined;
    const owner = pinDetached(
        context,
        context.compileValue(callee.expression),
        "dispatch_target",
        callee.expression,
    );
    const { target, engine } =
        owner.dataType?.kind === "event-target"
            ? {
                  target: `${owner.cpp}.target`,
                  engine: `bbl::dom_target_owner(${owner.cpp})`,
              }
            : domTargetIdentity(context, owner, callee.expression);
    const value = context.compileValue(call.arguments[0]!);
    if (value.kind !== "custom-event" && !value.platformEventBase)
        context.fail(
            call.arguments[0]!,
            "dispatchEvent requires an owned CustomEvent payload.",
        );
    context.reachFeature("input:dom", call);
    context.reachFeature("data:json", call);
    const event = value.platformEventBase
        ? `${value.cpp}.as<bbl::PlatformCustomEvent>()`
        : value.cpp;
    return {
        kind: "boolean",
        dataType: { kind: "boolean" },
        impure: true,
        cpp: `bbl::dispatch_custom_event(${engine}, ${target}, ${event})`,
    };
}
