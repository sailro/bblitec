import ts from "typescript";
import { pinDetached } from "./dom-listeners.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { domTargetIdentity } from "./dom-targets.js";

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
    | "bindings"
    | "requireDefaultEngine"
    | "defaultEngine"
    | "options"
>;

const options = {
    Event: ["bubbles", "cancelable", "composed"],
    MouseEvent: [
        "button",
        "buttons",
        "clientX",
        "clientY",
        "screenX",
        "screenY",
        "movementX",
        "movementY",
        "ctrlKey",
        "shiftKey",
        "altKey",
        "metaKey",
    ],
    PointerEvent: ["pointerId", "pointerType", "isPrimary", "pressure"],
    InputEvent: ["data", "inputType", "isComposing"],
} as const;

export function compileSyntheticEventConstructor(
    context: Omit<Context, "defaultEngine">,
    node: ts.NewExpression,
): Value | undefined {
    const name = context.libraryGlobal(node.expression);
    if (
        name !== "Event" &&
        name !== "MouseEvent" &&
        name !== "PointerEvent" &&
        name !== "InputEvent"
    )
        return undefined;
    const args = node.arguments ?? [];
    if (args.length < 1 || args.length > 2)
        context.fail(
            node,
            `${name} requires a type and optional initialization record.`,
        );
    const allowed = new Set<string>(options.Event);
    if (name !== "Event") for (const key of options[name]) allowed.add(key);
    if (name === "PointerEvent")
        for (const key of options.MouseEvent) allowed.add(key);
    if (args[1]) {
        const type = context.checker.getNonNullableType(
            context.checker.getTypeAtLocation(args[1]),
        );
        if (type.getStringIndexType())
            context.fail(
                args[1],
                "Synthetic event options require represented named fields.",
            );
        for (const property of type.getProperties()) {
            if (!allowed.has(property.name))
                context.fail(
                    args[1],
                    `${name} option '${property.name}' is not represented.`,
                );
            if (
                property.declarations?.some(
                    (declaration) =>
                        ts.isGetAccessorDeclaration(declaration) ||
                        ts.isSetAccessorDeclaration(declaration),
                )
            )
                context.fail(
                    args[1],
                    "Synthetic event option accessors are not represented.",
                );
        }
    }
    context.reachFeature("input:dom", node);
    context.reachFeature("data:json", node);
    const type = context.allocateTemporaryCppName("event_type");
    context.emit({
        kind: "declaration",
        type: "const std::string",
        name: type,
        initializer: context.dataLowerer.compileForSink(args[0]!, {
            kind: "string",
        }),
    });
    const init = args[1]
        ? context.dataLowerer.compileForSink(args[1], { kind: "json" })
        : "bbl::js::JsonValue::null_value()";
    const kind = name === "Event" ? "Event" : name.slice(0, -5);
    return {
        kind: "dom-event",
        dataType: { kind: "handle", handle: "dom-event" },
        cpp: `bbl::synthetic_event_from_options(${type}, bbl::OwnedDomEvent::Kind::${kind}, ${init})`,
        impure: true,
    };
}

/** Synthetic dispatch uses the same identity as listener registration, including stored targets. */
export function compileSyntheticEventDispatch(
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
    const expression = context.unwrap(call.arguments[0]!);
    const constructed =
        ts.isNewExpression(expression) &&
        ["Event", "MouseEvent", "PointerEvent", "InputEvent"].includes(
            context.libraryGlobal(expression.expression) ?? "",
        );
    const bound = ts.isIdentifier(expression)
        ? context.bindings.lookupOptional(expression)
        : undefined;
    if (
        !constructed &&
        bound?.kind !== "dom-event" &&
        !(type?.kind === "handle" && type.handle === "dom-event")
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
    const event = context.compileValue(call.arguments[0]!);
    if (event.kind !== "dom-event")
        context.fail(
            call.arguments[0]!,
            "Synthetic dispatch requires an owned event payload.",
        );
    context.reachFeature("input:dom", call);
    context.reachFeature("data:json", call);
    return {
        kind: "boolean",
        dataType: { kind: "boolean" },
        impure: true,
        cpp: `bbl::dispatch_synthetic_event(${engine}, ${target}, ${event.cpp})`,
    };
}
