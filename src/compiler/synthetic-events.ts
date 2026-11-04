import ts from "typescript";
import { pinDetached } from "./dom-listeners.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { domTargetIdentity } from "./dom-targets.js";
import { jsonAbsenceCpp } from "./values/model.js";
import { namedMember } from "./symbols.js";
import { recordDocumentSnapshot } from "./data-sinks/scalars.js";

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
    | "cppString"
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
        "relatedTarget",
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
    // The constructor converts its init as its own dictionary
    // (`MouseEventInit`): a member that dictionary does not declare is
    // ignored; one it declares but the native event does not represent
    // refuses, at run time when present if it may be absent.
    const unrepresented: string[] = [];
    if (args[1]) {
        const type = context.checker.getNonNullableType(
            context.checker.getTypeAtLocation(args[1]),
        );
        if (type.getStringIndexType())
            context.fail(
                args[1],
                "Synthetic event options require represented named fields.",
            );
        const contextual = context.checker.getContextualType(args[1]);
        const dictionary =
            contextual && context.checker.getNonNullableType(contextual);
        for (const property of type.getProperties()) {
            if (
                !allowed.has(property.name) &&
                dictionary &&
                !dictionary.getProperty(property.name)
            )
                continue;
            if (
                !allowed.has(property.name) &&
                (property.flags & ts.SymbolFlags.Optional) !== 0
            ) {
                unrepresented.push(property.name);
                continue;
            }
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
    // The init dictionary is read once, as the constructor converts it: a
    // record's own properties as they are now, no alias kept.
    const dictionary = args[1] && context.compileValue(args[1]);
    const compiled = dictionary
        ? ((dictionary.kind === "record" && !dictionary.cpp
              ? recordDocumentSnapshot(
                    context.dataLowerer,
                    dictionary,
                    args[1]!,
                )
              : undefined) ??
          context.dataLowerer.compileKnownValueForSink(
              dictionary,
              { kind: "json" },
              args[1]!,
          ))
        : jsonAbsenceCpp("undefined");
    let init = compiled;
    if (unrepresented.length > 0) {
        init = context.allocateTemporaryCppName("event_init");
        context.emit({
            kind: "declaration",
            type: "const auto",
            name: init,
            initializer: `bbl::require_event_options(${compiled}, ${context.cppString(name)}, {${unrepresented.map((key) => context.cppString(key)).join(", ")}})`,
        });
    }
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
    const callee = namedMember(
        context.checker,
        context.unwrap(call.expression),
    );
    if (!callee || callee.name !== "dispatchEvent") return undefined;
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
