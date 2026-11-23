import type { LoweringServices } from "./lowering-services.js";
import ts from "typescript";
import { jsToUint32Call } from "../lowering/pinned-operators.js";
import { rootIdentifier, argumentAt } from "./syntax.js";
import {
    isGlobalUndefined,
    isSymbolPropertyKey,
    libraryName,
    namedMember,
    resolvedSymbol,
    type NamedMember,
} from "./symbols.js";
import {
    validateObjectProperties,
    type ObjectValidationContext,
} from "./option-helpers.js";
import type { DataType } from "./data-types/model.js";
import type { Value } from "./types.js";
import { resolvedBuiltinConstructor } from "./builtin-constructors.js";
import { isNullable } from "./type-facts.js";
import { isHostAccessor } from "./host-globals.js";
import { ApplicationRealmRequired } from "./worker-modules.js";

export interface WorkerLoweringContext
    extends
        ObjectValidationContext,
        Pick<
            LoweringServices,
            | "options"
            | "checker"
            | "dataLowerer"
            | "dataTypes"
            | "unwrap"
            | "libraryGlobal"
            | "bindings"
            | "compileValue"
            | "callbacks"
            | "reachFeature"
            | "reachJsData"
            | "asyncActivations"
            | "compileNumber"
            | "emit"
            | "allocateTemporaryCppName"
            | "cppString"
            | "propertyName"
            | "fail"
        > {}

const realm = "bbl::pal::WorkerRealm::current()";
const loop = "bbl::pal::EventLoop::current()";

const nativeRealmFunctions = new Set([
    "matchMedia",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "queueMicrotask",
    "postMessage",
    "close",
]);

/**
 * The first position in a message shape without a native structured-clone
 * codec (js_structured_clone.hpp), described for a refusal. An OffscreenCanvas
 * or a MessagePort crosses by transfer; every other handle, like a browser's
 * platform objects, has no serialization. A class instance has no faithful native copy: the
 * browser delivers a plain object of its own data fields, without its
 * prototype, methods or private fields.
 */
function uncloneablePosition(
    context: WorkerLoweringContext,
    type: DataType,
    path: string,
    node: ts.Node,
    seen: Set<string>,
    functions: "refuse" | "throw" = "refuse",
): string | undefined {
    const refuse = (name: string): string =>
        `'${path}' is ${name}, which has no native structured-clone codec`;
    switch (type.kind) {
        case "undefined":
        case "number":
        case "boolean":
        case "string":
        case "enum":
        case "date":
        case "tuple":
        case "arraybuffer":
        case "dataview":
        case "u8array":
        case "i8array":
        case "u16array":
        case "i16array":
        case "u32array":
        case "i32array":
        case "u8clampedarray":
        case "f32array":
        case "f64array":
            return undefined;
        case "optional":
            return uncloneablePosition(
                context,
                type.inner,
                path,
                node,
                seen,
                functions,
            );
        case "vector":
            return uncloneablePosition(
                context,
                type.element,
                `${path}[]`,
                node,
                seen,
                functions,
            );
        case "set":
            return uncloneablePosition(
                context,
                type.element,
                `${path}.values()`,
                node,
                seen,
                functions,
            );
        case "map":
            return type.dictionary
                ? uncloneablePosition(
                      context,
                      type.value,
                      `${path}[key]`,
                      node,
                      seen,
                      functions,
                  )
                : (uncloneablePosition(
                      context,
                      type.key,
                      `${path}.keys()`,
                      node,
                      seen,
                      functions,
                  ) ??
                      uncloneablePosition(
                          context,
                          type.value,
                          `${path}.values()`,
                          node,
                          seen,
                          functions,
                      ));
        case "struct": {
            const instance = context.dataTypes.classStruct(type.name);
            if (instance)
                return (
                    `'${path}' is an instance of class ${instance.declaration.name?.text ?? type.name}, ` +
                    "which a browser delivers as a plain object without its prototype, methods or " +
                    "private fields; use a plain object instead"
                );
            if (seen.has(type.name)) return undefined;
            seen.add(type.name);
            for (const field of context.dataTypes.structFields(
                type.name,
                node,
                "accessors",
            )) {
                // An own accessor clones as the data its getter reads; a
                // class's prototype accessor is no own property and refuses.
                if (
                    field.accessor &&
                    !field.accessorReceiver &&
                    context.dataTypes.holdsPrototypeAccessors(type.name)
                )
                    context.dataTypes.structField(
                        type.name,
                        field.sourceName,
                        node,
                    );
                // Cloning drops a symbol-keyed property the struct keeps.
                if (isSymbolPropertyKey(field.sourceName))
                    return refuse("an object with a symbol-keyed property");
                const found = uncloneablePosition(
                    context,
                    field.type,
                    `${path}.${field.sourceName}`,
                    node,
                    seen,
                    functions,
                );
                if (found) return found;
            }
            return undefined;
        }
        case "handle":
            return type.handle === "offscreen-canvas" ||
                type.handle === "message-port"
                ? undefined
                : refuse(`a native ${type.handle} handle`);
        case "error":
            return refuse("an Error");
        case "event-target":
            return refuse("an EventTarget");
        case "http-response":
            return refuse("a Response");
        case "gpu-adapter":
            return refuse("a GPUAdapter");
        case "gpu-adapter-info":
            return refuse("a GPUAdapterInfo");
        case "idle-deadline":
            return refuse("an IdleDeadline");
        case "dom-matrix":
            return refuse("a DOMMatrix");
        case "dom-point":
            return refuse("a DOMPoint");
        case "search-params":
            return refuse("a URLSearchParams");
        case "promise":
            return refuse("a Promise");
        case "storage":
            return refuse("a Storage");
        case "date-time-format":
            return refuse("an Intl.DateTimeFormat");
        case "text-decoder":
            return refuse("a TextDecoder");
        case "text-encoder":
            return refuse("a TextEncoder");
        case "collator":
            return refuse("an Intl.Collator");
        case "number-format":
            return refuse("an Intl.NumberFormat");
        case "plural-rules":
            return refuse("an Intl.PluralRules");
        case "list-format":
            return refuse("an Intl.ListFormat");
        case "weak-ref":
            return refuse("a WeakRef");
        case "symbol":
            return refuse("a Symbol");
        case "bigint":
            return refuse("a BigInt");
        case "i64array":
        case "u64array":
            return refuse("a BigInt typed array");
        case "bufferview":
            return refuse("an ArrayBufferView without its element class");
        case "numberindex":
            return refuse("a numeric index view");
        case "borrowed-platform-event":
            return refuse("a platform event");
        case "function":
            // structuredClone throws DataCloneError where it meets one.
            return functions === "throw" ? undefined : refuse("a function");
        case "json":
            return refuse("a dynamic JSON value");
        case "union":
            return refuse("a mixed union");
        case "iterator":
            return refuse("an iterator");
        case "span":
            return refuse("a borrowed array view");
        case "product":
            return refuse("a heterogeneous fixed tuple");
        case "enummap":
            return refuse("an enum-keyed record");
        case "table":
            return refuse("a constant table");
    }
}

/** Both message ends refuse a shape the native clone cannot carry. */
function requireCloneable(
    context: WorkerLoweringContext,
    type: DataType,
    root: string,
    node: ts.Node,
): void {
    const position = uncloneablePosition(
        context,
        type,
        root,
        node,
        new Set<string>(),
    );
    if (position) context.fail(node, `Worker message value ${position}.`);
}

/**
 * `structuredClone(value, options?)`: a deep copy through the message codecs,
 * which keep aliases and cycles; a function met on the way throws a
 * DataCloneError DOMException, as it does in JavaScript. Shapes a message
 * refuses refuse here too. Options move nothing: absent, `undefined`, `{}`
 * or an empty `transfer` literal.
 */
function compileStructuredClone(
    context: WorkerLoweringContext,
    call: ts.CallExpression,
): Value {
    if (call.arguments.length < 1 || call.arguments.length > 2)
        return context.fail(
            call,
            "structuredClone takes a value and optional options.",
        );
    const options = call.arguments[1];
    if (options) requireNoTransfer(context, options);
    const argument = argumentAt(call, 0);
    const type = messageDataType(context, argument);
    if (!type)
        return context.fail(
            argument,
            "structuredClone requires a supported structured-clone data shape.",
        );
    const position = uncloneablePosition(
        context,
        type,
        "value",
        argument,
        new Set<string>(),
        "throw",
    );
    if (position) return context.fail(argument, `structuredClone ${position}.`);
    return {
        ...context.dataLowerer.leafValue(
            `bbl::js::structured_clone(${context.dataLowerer.compileForSink(argument, type)})`,
            type,
        ),
        freshData: true,
    };
}

/** Clone options that transfer nothing; moving a value (detaching it) is not lowered. */
function requireNoTransfer(
    context: WorkerLoweringContext,
    node: ts.Expression,
): void {
    const options = context.unwrap(node);
    if (isGlobalUndefined(context.checker, options)) return;
    const refuse = (): never =>
        context.fail(
            node,
            "structuredClone options admit only an empty literal transfer list; transferring a value is not lowered.",
        );
    if (!ts.isObjectLiteralExpression(options)) return refuse();
    for (const property of options.properties) {
        if (
            !ts.isPropertyAssignment(property) ||
            context.propertyName(property.name) !== "transfer"
        )
            return refuse();
        const list = context.unwrap(property.initializer);
        if (!ts.isArrayLiteralExpression(list) || list.elements.length !== 0)
            return refuse();
    }
}

/**
 * A message position's data type. A class demands its representation here,
 * as a stored field does, so `requireCloneable` names it rather than the
 * position reading as an unmapped shape.
 */
function messageDataType(
    context: WorkerLoweringContext,
    node: ts.Expression,
): DataType | undefined {
    return context.dataTypes.fromStoredTsType(
        context.checker.getTypeAtLocation(node),
        node,
    );
}

const errorPositions = new Map([
    ["lineno", "line"],
    ["colno", "column"],
]);

/**
 * A message or error event's property: `event.data` deserializes the message
 * as the type of `expression`, the read as the source spells it (a type
 * assertion included).
 */
export function readWorkerEventProperty(
    context: WorkerLoweringContext,
    owner: Value,
    access: ts.PropertyAccessExpression,
    expression: ts.Expression = access,
): Value | undefined {
    if (owner.kind === "worker-message-event" && access.name.text === "data") {
        const type = messageDataType(context, expression);
        if (!type)
            return context.fail(
                expression,
                "MessageEvent.data requires a supported data type at its read boundary.",
            );
        requireCloneable(context, type, "event.data", expression);
        const cppType = context.dataTypes.cppType(type);
        return {
            kind:
                type.kind === "number" ||
                type.kind === "boolean" ||
                type.kind === "string"
                    ? type.kind
                    : "data",
            cpp: `${owner.cpp}->data<${cppType}>()`,
            dataType: type,
            // Deserialization returns an owning value, including when the
            // source spells the read as a property access.
            freshData: true,
        };
    }
    if (
        owner.kind === "worker-error-event" &&
        ["message", "filename"].includes(access.name.text)
    )
        return { kind: "string", cpp: `${owner.cpp}.${access.name.text}` };
    // A native failure has no source position: both read 0, as an
    // ErrorEvent without one does.
    const position = errorPositions.get(access.name.text);
    if (owner.kind === "worker-error-event" && position)
        return {
            kind: "number",
            cpp: `static_cast<double>(${owner.cpp}.${position})`,
            dataType: { kind: "number" },
        };
    return undefined;
}

/**
 * `postMessage(message, transfer?)` of a Worker, a worker global or a
 * MessagePort: the message's snapshot, then its transfer list, in source
 * order. A transfer list is an array literal of OffscreenCanvas, MessagePort
 * and ArrayBuffer values (`bbl::js::BufferTransfer` detaches a buffer).
 */
function compileMessagePost(
    context: WorkerLoweringContext,
    node: ts.CallExpression,
): { snapshot: string; transfer: string } {
    if (node.arguments.length < 1 || node.arguments.length > 2)
        return context.fail(
            node,
            "Worker postMessage requires a message and optional transfer list.",
        );
    const argument = argumentAt(node, 0);
    const type = messageDataType(context, argument);
    if (!type)
        return context.fail(
            argument,
            "Worker messages require a supported structured-clone data shape.",
        );
    requireCloneable(context, type, "message", argument);
    const data = context.dataLowerer.compileForSink(argument, type);
    const snapshot = context.allocateTemporaryCppName("message_value");
    context.emit({
        kind: "declaration",
        type: "auto",
        name: snapshot,
        initializer: data,
    });
    const transfer = node.arguments[1];
    if (!transfer) return { snapshot, transfer: "" };
    const list = context.unwrap(transfer);
    if (!ts.isArrayLiteralExpression(list))
        return context.fail(
            list,
            "Worker transfer lists currently require an explicit array of supported transferable values.",
        );
    const entries = list.elements.map((element) => {
        if (ts.isSpreadElement(element) || ts.isOmittedExpression(element))
            return context.fail(
                element,
                "Worker transfer list entries must be explicit values.",
            );
        const temporary = context.allocateTemporaryCppName("transfer_value");
        // An `ArrayBufferLike` is a SharedArrayBuffer at run time only where
        // the transfer then throws its DataCloneError.
        if (context.dataLowerer.dataTypeAt(element)?.kind === "arraybuffer") {
            context.emit({
                kind: "declaration",
                type: "bbl::js::BufferTransfer",
                name: temporary,
                initializer: context.dataLowerer.compileForSink(element, {
                    kind: "arraybuffer",
                }),
                initialization: "direct",
            });
            return `&${temporary}`;
        }
        const value = context.compileValue(element);
        if (value.kind !== "offscreen-canvas" && value.kind !== "message-port")
            return context.fail(
                element,
                `Transfer of '${value.kind}' is not implemented.`,
            );
        context.emit({
            kind: "declaration",
            type: "auto",
            name: temporary,
            initializer: value.cpp,
        });
        return `${temporary}.get()`;
    });
    const listName = context.allocateTemporaryCppName("transfer_list");
    context.emit({
        kind: "declaration",
        type: `const std::array<bbl::pal::Transferable*, ${entries.length}>`,
        name: listName,
        initializer: entries.join(", "),
        initialization: "direct",
    });
    return { snapshot, transfer: `, ${listName}` };
}

/**
 * `addEventListener` / `removeEventListener` of a message target: one of
 * `events`, its callback and a static `once`. `refusedError` refuses an
 * `error` listener the target does not admit yet.
 */
function compileMessageListener(
    context: WorkerLoweringContext,
    node: ts.CallExpression,
    member: "addEventListener" | "removeEventListener",
    receiver: string,
    events: readonly ("message" | "error" | "messageerror")[],
    refusedError?: string,
): Value {
    const event = node.arguments[0];
    const callback = node.arguments[1];
    const name =
        event && ts.isStringLiteralLike(event)
            ? events.find((admitted) => admitted === event.text)
            : undefined;
    if (!name || !callback || node.arguments.length > 3) {
        return context.fail(
            node,
            "Worker listeners require an admitted event name and callback.",
        );
    }
    if (name === "error" && refusedError)
        return context.fail(node, refusedError);
    let once = false;
    const options = node.arguments[2];
    if (options) {
        if (!ts.isObjectLiteralExpression(options))
            return context.fail(
                options,
                "Worker listener options must be a static record.",
            );
        for (const property of options.properties) {
            if (
                !ts.isPropertyAssignment(property) ||
                context.propertyName(property.name) !== "once" ||
                ![
                    ts.SyntaxKind.TrueKeyword,
                    ts.SyntaxKind.FalseKeyword,
                ].includes(property.initializer.kind)
            ) {
                return context.fail(
                    property,
                    "Only static once is admitted in Worker listener options.",
                );
            }
            once = property.initializer.kind === ts.SyntaxKind.TrueKeyword;
        }
    }
    // A messageerror event is a MessageEvent, as a message event is.
    const compiled = context.asyncActivations.compileWorkerCallback(
        callback,
        name === "error" ? "error" : "message",
    );
    return {
        kind: "void",
        cpp: `${receiver}${member === "addEventListener" ? "add" : "remove"}_${name}_listener(${compiled}${member === "addEventListener" ? `, ${once}` : ""})`,
    };
}

/** Whether an expression's declared type, present, is the DOM's `MessagePort` or `MessageChannel`. */
function messagingType(
    context: WorkerLoweringContext,
    expression: ts.Expression,
): "MessagePort" | "MessageChannel" | undefined {
    const name = libraryName(
        context.checker.getNonNullableType(
            context.checker.getTypeAtLocation(expression),
        ),
    );
    return name === "MessagePort" || name === "MessageChannel"
        ? name
        : undefined;
}

const messagePortHandlers = new Set(["onmessage", "onmessageerror"]);
const messageHandlers = new Set([...messagePortHandlers, "onerror"]);

/**
 * `new MessageChannel()`, its `port1` / `port2`, and a MessagePort's
 * `postMessage`, listeners, `start()` and `close()`
 * (`bbl::pal::MessagePort`). Messages are tasks of the receiving port's
 * realm; a port crosses realms in a message's transfer list.
 */
function compileMessagingValue(
    context: WorkerLoweringContext,
    node: ts.Expression,
): Value | undefined {
    if (ts.isNewExpression(node)) {
        if (context.libraryGlobal(node.expression) !== "MessageChannel")
            return undefined;
        if (node.arguments?.length)
            return context.fail(node, "MessageChannel takes no arguments.");
        return {
            kind: "message-channel",
            dataType: { kind: "handle", handle: "message-channel" },
            cpp: "bbl::pal::create_message_channel()",
            impure: true,
        };
    }
    if (ts.isPropertyAccessExpression(node)) {
        const owner = messagingType(context, node.expression);
        if (owner === "MessagePort" && messagePortHandlers.has(node.name.text))
            return context.fail(
                node,
                `MessagePort.${node.name.text} is written natively, not read.`,
            );
        if (owner !== "MessageChannel") return undefined;
        const name = node.name.text;
        if (name !== "port1" && name !== "port2")
            return context.fail(
                node,
                `MessageChannel member '${name}' is not lowered.`,
            );
        const read = (present: Value): Value | undefined =>
            present.kind === "message-channel"
                ? {
                      kind: "message-port",
                      dataType: { kind: "handle", handle: "message-port" },
                      cpp: `${present.cpp}->${name}()`,
                  }
                : undefined;
        const channel = context.compileValue(node.expression);
        return (
            (node.questionDotToken
                ? context.dataLowerer.optionalAccess(channel, node, read)
                : read(
                      context.dataLowerer.narrowOptional(
                          channel,
                          node.expression,
                      ),
                  )) ??
            context.fail(node, "MessageChannel ports require a native channel.")
        );
    }
    if (!ts.isCallExpression(node)) return undefined;
    const member = namedMember(
        context.checker,
        context.unwrap(node.expression),
    );
    if (!member || messagingType(context, member.expression) !== "MessagePort")
        return undefined;
    const call = (present: Value): Value | undefined =>
        present.kind === "message-port"
            ? compileMessagePortCall(context, node, member, present)
            : undefined;
    return (
        context.dataLowerer.chainReceiverCall(
            context.compileValue(member.expression),
            member.access,
            node,
            call,
        ) ?? context.fail(node, "MessagePort calls require a native port.")
    );
}

function compileMessagePortCall(
    context: WorkerLoweringContext,
    node: ts.CallExpression,
    member: NamedMember,
    port: Value,
): Value {
    // The receiver is evaluated before the arguments.
    const receiver = context.bindings.pinValueToTemporary(
        port,
        "message_port",
    ).cpp;
    switch (member.name) {
        case "postMessage": {
            const { snapshot, transfer } = compileMessagePost(context, node);
            return {
                kind: "void",
                cpp: `${receiver}->post_message(${snapshot}${transfer})`,
            };
        }
        case "addEventListener":
        case "removeEventListener":
            return compileMessageListener(
                context,
                node,
                member.name,
                `${receiver}->`,
                ["message", "messageerror"],
            );
        case "start":
        case "close":
            if (node.arguments.length)
                return context.fail(
                    node,
                    `MessagePort.${member.name} takes no arguments.`,
                );
            return { kind: "void", cpp: `${receiver}->${member.name}()` };
    }
    return context.fail(
        node,
        `MessagePort member '${member.name}' is not lowered.`,
    );
}

/**
 * The message target an `on…` handler assignment writes: a Worker or a
 * MessagePort, by its declared type or, through an interface the program
 * declares (`{ onerror?: … }`), by the value its name holds.
 */
function messageHandlerTarget(
    context: WorkerLoweringContext,
    owner: ts.Expression,
): boolean {
    const unwrapped = context.unwrap(owner);
    const bound = ts.isIdentifier(unwrapped)
        ? context.bindings.lookupOptional(unwrapped)
        : undefined;
    return (
        bound?.kind === "worker" ||
        bound?.kind === "message-port" ||
        messagingType(context, owner) === "MessagePort" ||
        libraryName(
            context.checker.getNonNullableType(
                context.checker.getTypeAtLocation(owner),
            ),
        ) === "Worker"
    );
}

/**
 * `target.onmessage`, `target.onmessageerror` and a Worker's `onerror`
 * written with a handler: the target's event handler, replaced in place;
 * `null` or `undefined` removes it. Setting a port's `onmessage` enables its
 * message queue, as `start()` does.
 */
export function emitMessageHandler(
    context: WorkerLoweringContext,
    expression: ts.BinaryExpression,
): boolean {
    const target = context.unwrap(expression.left);
    if (
        !ts.isPropertyAccessExpression(target) ||
        !messageHandlers.has(target.name.text) ||
        !messageHandlerTarget(context, target.expression)
    )
        return false;
    const name = target.name.text;
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        return context.fail(
            expression,
            `The ${name} handler supports direct assignment.`,
        );
    const owner = context.dataLowerer.narrowOptional(
        context.compileValue(target.expression),
        target.expression,
    );
    if (owner.kind !== "worker" && owner.kind !== "message-port")
        return context.fail(
            target.expression,
            "Message handlers require a native Worker or MessagePort.",
        );
    if (owner.kind === "message-port" && name === "onerror")
        return context.fail(
            target,
            "A MessagePort has no error event; only a Worker reports errors.",
        );
    const receiver = context.bindings.pinValueToTemporary(
        owner,
        "message_target",
    ).cpp;
    const handler = context.unwrap(expression.right);
    const callback =
        handler.kind === ts.SyntaxKind.NullKeyword ||
        isGlobalUndefined(context.checker, handler)
            ? "{}"
            : context.asyncActivations.compileWorkerCallback(
                  expression.right,
                  name === "onerror" ? "error" : "message",
              );
    context.emit({
        kind: "expression",
        code: `${receiver}->set_${name.slice(2)}_handler(${callback});`,
    });
    return true;
}

/**
 * A `location` member the Window realm answers at run time: navigation, and
 * the query a runtime Window application reads (`runtimeLocationSearch`).
 */
export function isRuntimeLocationMember(
    context: Pick<WorkerLoweringContext, "options" | "libraryGlobal">,
    member: { name: string; expression: ts.Expression },
): boolean {
    return (
        (member.name === "reload" ||
            member.name === "assign" ||
            (context.options.runtimeLocationSearch === true &&
                (member.name === "search" || member.name === "href"))) &&
        context.libraryGlobal(member.expression) === "location"
    );
}

export function isNativeWorkerExpression(
    context: WorkerLoweringContext,
    expression: ts.Expression,
): boolean {
    let node = context.unwrap(expression);
    if (resolvedBuiltinConstructor(context, node)) return true;
    if (!context.options.workers) return false;
    if (context.libraryGlobal(node) === "fetch") return true;
    if (
        !context.options.workers.namespace &&
        (context.libraryGlobal(node) === "screen" ||
            (ts.isPropertyAccessExpression(node) &&
                context.libraryGlobal(node.expression) === "screen"))
    )
        return true;
    if (
        !context.options.workers.namespace &&
        ["window", "globalThis", "document"].includes(
            context.libraryGlobal(node) ?? "",
        )
    )
        return true;
    if (ts.isCallExpression(node)) node = context.unwrap(node.expression);
    if (ts.isNewExpression(node)) node = context.unwrap(node.expression);
    const member = namedMember(context.checker, node);
    if (member) {
        const type = context.dataLowerer.dataTypeAt(member.expression);
        const inner = type?.kind === "optional" ? type.inner : type;
        if (inner?.kind === "handle" && inner.handle === "worker-media-query")
            return true;
    }
    if (member && isRuntimeLocationMember(context, member)) return true;
    if (member && messagingType(context, member.expression)) return true;
    const globalMember = context.libraryGlobal(node);
    if (
        globalMember !== undefined &&
        member !== undefined &&
        (nativeRealmFunctions.has(globalMember) ||
            isHostAccessor(globalMember) ||
            [
                "Worker",
                "OffscreenCanvas",
                "MessageChannel",
                "ResizeObserver",
                "isSecureContext",
            ].includes(globalMember))
    )
        return true;
    const root = rootIdentifier(node, (inner) => context.unwrap(inner));
    if (!root) return false;
    const bound = context.bindings.lookupOptional(root);
    if (bound?.hostFunction || bound?.builtinConstructor) return true;
    if (
        bound?.kind.startsWith("worker") ||
        bound?.kind.startsWith("message-") ||
        bound?.kind === "offscreen-canvas"
    )
        return true;
    return (
        context.libraryGlobal(root) !== undefined &&
        (nativeRealmFunctions.has(root.text) ||
            [
                "Worker",
                "OffscreenCanvas",
                "MessageChannel",
                "ResizeObserver",
                "self",
            ].includes(root.text))
    );
}

/**
 * `clearTimeout(id)` and `clearInterval(id)`: an identifier that may be
 * absent (`let timer: number | undefined`) cancels nothing while absent,
 * as the browser does.
 */
export function timerCancellation(
    context: Pick<
        LoweringServices,
        | "bindings"
        | "checker"
        | "compileNumber"
        | "compileValue"
        | "fail"
        | "unwrap"
    >,
    argument: ts.Expression,
    cancel: (identifier: string) => string,
): string {
    // A binding its declared type calls present may still hold no id: a
    // `var` read before its assignment cancels nothing.
    const { checker } = context;
    const name = context.unwrap(argument);
    const declaration = ts.isIdentifier(name)
        ? resolvedSymbol(checker, name)?.valueDeclaration
        : undefined;
    const unassigned =
        ts.isIdentifier(name) &&
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        !isNullable(checker.getTypeAtLocation(declaration.name))
            ? context.bindings.lookupOptional(name)
            : undefined;
    if (
        unassigned?.dataType?.kind !== "optional" &&
        !isNullable(checker.getTypeAtLocation(argument))
    )
        return cancel(context.compileNumber(argument, "double"));
    const value =
        unassigned?.dataType?.kind === "optional"
            ? unassigned
            : context.compileValue(argument);
    if (
        value.kind !== "data" ||
        value.dataType?.kind !== "optional" ||
        value.dataType.inner.kind !== "number"
    )
        return context.fail(
            argument,
            "Timer cancellation requires a numeric identifier or an absent one.",
        );
    return `([&]() { const auto timer = ${value.cpp}; if (timer.has_value()) ${cancel("*timer")}; }())`;
}

/** Browser Worker operations lower to realm services, independently of an engine. */
export function compileWorkerValue(
    context: WorkerLoweringContext,
    expression: ts.Expression,
): Value | undefined {
    const node = context.unwrap(expression);
    if (!context.options.workers) {
        // A port's messages are tasks of a realm's event loop.
        if (
            ts.isNewExpression(node) &&
            context.libraryGlobal(node.expression) === "MessageChannel"
        )
            throw new ApplicationRealmRequired();
        return undefined;
    }
    const messaging = compileMessagingValue(context, node);
    if (messaging) return messaging;
    const scope = (value: ts.Expression): Value | undefined => {
        const unwrapped = context.unwrap(value);
        if (!ts.isIdentifier(unwrapped)) return undefined;
        const global = context.libraryGlobal(unwrapped);
        return global === "self" || global === "globalThis"
            ? { kind: "worker-scope", cpp: realm }
            : context.bindings.lookupOptional(unwrapped);
    };
    if (ts.isIdentifier(node) && context.libraryGlobal(node) === "self") {
        if (!context.options.workers.namespace)
            return context.fail(
                node,
                "The application Window self is not a worker global scope.",
            );
        return { kind: "worker-scope", cpp: realm };
    }
    if (ts.isNewExpression(node)) {
        const entry = context.options.workers.register(node);
        if (!entry) return undefined;
        const options = node.arguments![1] as ts.ObjectLiteralExpression;
        validateObjectProperties(
            context,
            options,
            ["name", "type", "credentials"],
            "Unsupported Worker option.",
        );
        let name = '""';
        for (const property of options.properties) {
            if (!ts.isPropertyAssignment(property))
                return context.fail(
                    property,
                    "Worker options must have explicit property assignments.",
                );
            const key = context.propertyName(property.name);
            if (key === "name")
                name = context.dataLowerer.compileForSink(
                    property.initializer,
                    { kind: "string" },
                );
            else if (
                key === "credentials" &&
                (!ts.isStringLiteralLike(property.initializer) ||
                    property.initializer.text !== "same-origin")
            ) {
                return context.fail(
                    property,
                    "Packaged local workers support same-origin credentials only.",
                );
            }
        }
        return {
            kind: "worker",
            cpp: `${realm}.create_worker(${entry}, ${name})`,
            impure: true,
        };
    }
    if (ts.isPropertyAccessExpression(node)) {
        const owner = scope(node.expression);
        const event =
            owner && readWorkerEventProperty(context, owner, node, expression);
        if (event) return event;
        if (owner?.kind === "worker-scope" && node.name.text === "name")
            return { kind: "string", cpp: `${realm}.name()` };
        return undefined;
    }
    if (!ts.isCallExpression(node)) return undefined;
    const callee = context.unwrap(node.expression);
    const named = namedMember(context.checker, callee);
    const member = named
        ? named.name
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
    const owner = named ? scope(named.expression) : undefined;
    const global = context.libraryGlobal(callee) !== undefined;
    if (
        global &&
        context.options.workers.namespace &&
        named &&
        context.libraryGlobal(named.expression) === "window"
    ) {
        return context.fail(
            callee,
            "The Window global is not available in a worker realm.",
        );
    }
    const worker = owner?.kind === "worker";
    const workerScope =
        owner?.kind === "worker-scope" ||
        (global && context.options.workers.namespace !== undefined);
    const receiver = worker ? `${owner.cpp}->` : `${realm}.`;
    if ((worker || workerScope) && member === "postMessage") {
        const { snapshot, transfer } = compileMessagePost(context, node);
        return {
            kind: "void",
            cpp: `${receiver}post_message(bbl::js::serialize_message(${snapshot}${transfer}))`,
        };
    }
    if (
        (worker || workerScope) &&
        (member === "addEventListener" || member === "removeEventListener")
    ) {
        return compileMessageListener(
            context,
            node,
            member,
            receiver,
            ["message", "error"],
            workerScope
                ? "WorkerGlobalScope error listeners are not yet admitted."
                : undefined,
        );
    }
    if (worker && member === "terminate" && node.arguments.length === 0)
        return { kind: "void", cpp: `${receiver}terminate()` };
    if (workerScope && member === "close" && node.arguments.length === 0)
        return { kind: "void", cpp: `${realm}.close()` };
    if (
        owner?.kind === "worker-error-event" &&
        member === "preventDefault" &&
        node.arguments.length === 0
    ) {
        return { kind: "void", cpp: `${owner.cpp}.prevent_default()` };
    }
    if ((global || workerScope) && member === "requestAnimationFrame") {
        if (node.arguments.length !== 1)
            return context.fail(
                node,
                "requestAnimationFrame requires one callback.",
            );
        context.reachFeature("platform:window", node);
        context.reachFeature("ui:rml", node);
        const callback = context.dataLowerer.compileForSink(
            argumentAt(node, 0),
            { kind: "function", parameters: [{ kind: "number" }] },
        );
        return {
            kind: "number",
            cpp: `static_cast<double>(${realm}.request_animation_frame(${callback}))`,
            impure: true,
        };
    }
    if ((global || workerScope) && member === "cancelAnimationFrame") {
        if (node.arguments.length !== 1)
            return context.fail(
                node,
                "cancelAnimationFrame requires one numeric identifier.",
            );
        context.reachJsData();
        return {
            kind: "void",
            cpp: `${loop}.cancel_animation_frame(${jsToUint32Call(context.compileNumber(argumentAt(node, 0), "double"))})`,
        };
    }
    if (
        (global || workerScope) &&
        (member === "setTimeout" || member === "setInterval")
    ) {
        if (node.arguments.length < 1 || node.arguments.length > 2)
            return context.fail(
                node,
                "Native timers require a callback and optional delay.",
            );
        const callback = context.callbacks.compileFrameCallback(
            argumentAt(node, 0),
            member === "setInterval" ? "interval" : "void",
        );
        const delay = node.arguments[1]
            ? context.compileNumber(node.arguments[1], "double")
            : "0.0";
        return {
            kind: "number",
            cpp: `static_cast<double>(${loop}.set_timeout(${callback}, ${delay}, ${member === "setInterval"}))`,
            impure: true,
        };
    }
    if (
        (global || workerScope) &&
        (member === "clearTimeout" || member === "clearInterval")
    ) {
        if (node.arguments.length !== 1)
            return context.fail(
                node,
                "Timer cancellation requires its numeric identifier.",
            );
        return {
            kind: "void",
            cpp: timerCancellation(
                context,
                argumentAt(node, 0),
                (identifier) =>
                    `${loop}.clear_timer(static_cast<bbl::pal::EventLoop::TimerId>(${identifier}))`,
            ),
        };
    }
    if (global && member === "structuredClone")
        return compileStructuredClone(context, node);
    if ((global || workerScope) && member === "queueMicrotask") {
        if (node.arguments.length !== 1)
            return context.fail(node, "queueMicrotask requires one callback.");
        return {
            kind: "void",
            cpp: `${loop}.queue_microtask(${context.callbacks.compileFrameCallback(argumentAt(node, 0), "void")})`,
        };
    }
    return undefined;
}
