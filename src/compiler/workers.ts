import type { LoweringServices } from "./lowering-services.js";
import ts from "typescript";
import { rootIdentifier, argumentAt } from "./syntax.js";
import { validateObjectProperties } from "./option-helpers.js";
import type { DataType } from "./data-types/model.js";
import type { Value } from "./types.js";

export interface WorkerLoweringContext extends Pick<
    LoweringServices,
    | "options"
    | "checker"
    | "dataLowerer"
    | "dataTypes"
    | "unwrap"
    | "libraryGlobal"
    | "bindings"
    | "compileValue"
    | "compileFrameCallback"
    | "reachFeature"
    | "reachJsData"
    | "compileWorkerCallback"
    | "compileNumber"
    | "pinValueToTemporary"
    | "emit"
    | "allocateTemporaryCppName"
    | "cppString"
    | "propertyName"
    | "fail"
> {}

const realm = "bbl::pal::WorkerRealm::current()";
const loop = "bbl::pal::EventLoop::current()";

/**
 * The first position in a message shape without a native structured-clone
 * codec (js_structured_clone.hpp), described for a refusal. An OffscreenCanvas
 * crosses by transfer; every other handle, like a browser's platform objects,
 * has no serialization. A class instance has no faithful native copy: the
 * browser delivers a plain object of its own data fields, without its
 * prototype, methods or private fields.
 */
function uncloneablePosition(
    context: WorkerLoweringContext,
    type: DataType,
    path: string,
    node: ts.Node,
    seen: Set<string>,
): string | undefined {
    const refuse = (name: string): string =>
        `'${path}' is ${name}, which has no native structured-clone codec`;
    switch (type.kind) {
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
        case "f32array":
        case "f64array":
            return undefined;
        case "optional":
            return uncloneablePosition(context, type.inner, path, node, seen);
        case "vector":
            return uncloneablePosition(
                context,
                type.element,
                `${path}[]`,
                node,
                seen,
            );
        case "set":
            return uncloneablePosition(
                context,
                type.element,
                `${path}.values()`,
                node,
                seen,
            );
        case "map":
            return type.dictionary
                ? uncloneablePosition(
                      context,
                      type.value,
                      `${path}[key]`,
                      node,
                      seen,
                  )
                : (uncloneablePosition(
                      context,
                      type.key,
                      `${path}.keys()`,
                      node,
                      seen,
                  ) ??
                      uncloneablePosition(
                          context,
                          type.value,
                          `${path}.values()`,
                          node,
                          seen,
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
            )) {
                const found = uncloneablePosition(
                    context,
                    field.type,
                    `${path}.${field.sourceName}`,
                    node,
                    seen,
                );
                if (found) return found;
            }
            return undefined;
        }
        case "handle":
            return type.handle === "offscreen-canvas"
                ? undefined
                : refuse(`a native ${type.handle} handle`);
        case "error":
            return refuse("an Error");
        case "event-target":
            return refuse("an EventTarget");
        case "http-response":
            return refuse("a Response");
        case "search-params":
            return refuse("a URLSearchParams");
        case "promise":
            return refuse("a Promise");
        case "storage":
            return refuse("a Storage");
        case "date-time-format":
            return refuse("an Intl.DateTimeFormat");
        case "bufferview":
            return refuse("an ArrayBufferView without its element class");
        case "numberindex":
            return refuse("a numeric index view");
        case "borrowed-platform-event":
            return refuse("a platform event");
        case "function":
            return refuse("a function");
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

export function isNativeWorkerExpression(
    context: WorkerLoweringContext,
    expression: ts.Expression,
): boolean {
    if (!context.options.workers) return false;
    let node = context.unwrap(expression);
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
    if (ts.isPropertyAccessExpression(node)) {
        const type = context.dataLowerer.dataTypeAt(node.expression);
        const inner = type?.kind === "optional" ? type.inner : type;
        if (inner?.kind === "handle" && inner.handle === "worker-media-query")
            return true;
    }
    if (
        ts.isPropertyAccessExpression(node) &&
        (node.name.text === "reload" ||
            (context.options.runtimeLocationSearch &&
                node.name.text === "search")) &&
        context.libraryGlobal(node.expression) === "location"
    )
        return true;
    const globalMember = context.libraryGlobal(node);
    if (
        globalMember !== undefined &&
        ts.isPropertyAccessExpression(node) &&
        [
            "Worker",
            "OffscreenCanvas",
            "ResizeObserver",
            "matchMedia",
            "devicePixelRatio",
            "isSecureContext",
            "requestAnimationFrame",
            "cancelAnimationFrame",
            "setTimeout",
            "setInterval",
            "clearTimeout",
            "clearInterval",
            "queueMicrotask",
            "postMessage",
            "close",
        ].includes(globalMember)
    )
        return true;
    const root = rootIdentifier(node, (inner) => context.unwrap(inner));
    if (!root) return false;
    const bound = context.bindings.lookupOptional(root);
    if (bound?.hostFunction) return true;
    if (bound?.kind.startsWith("worker") || bound?.kind === "offscreen-canvas")
        return true;
    return (
        context.libraryGlobal(root) !== undefined &&
        [
            "Worker",
            "OffscreenCanvas",
            "ResizeObserver",
            "matchMedia",
            "self",
            "requestAnimationFrame",
            "cancelAnimationFrame",
            "setTimeout",
            "setInterval",
            "clearTimeout",
            "clearInterval",
            "queueMicrotask",
            "postMessage",
            "close",
        ].includes(root.text)
    );
}

/** Browser Worker operations lower to realm services, independently of an engine. */
export function compileWorkerValue(
    context: WorkerLoweringContext,
    expression: ts.Expression,
): Value | undefined {
    if (!context.options.workers) return undefined;
    const node = context.unwrap(expression);
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
        if (
            owner?.kind === "worker-message-event" &&
            node.name.text === "data"
        ) {
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
            };
        }
        if (
            owner?.kind === "worker-error-event" &&
            ["message", "filename"].includes(node.name.text)
        ) {
            return { kind: "string", cpp: `${owner.cpp}.${node.name.text}` };
        }
        if (owner?.kind === "worker-scope" && node.name.text === "name")
            return { kind: "string", cpp: `${realm}.name()` };
        return undefined;
    }
    if (!ts.isCallExpression(node)) return undefined;
    const callee = context.unwrap(node.expression);
    const member = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
    const owner = ts.isPropertyAccessExpression(callee)
        ? scope(callee.expression)
        : undefined;
    const global = context.libraryGlobal(callee) !== undefined;
    if (
        global &&
        context.options.workers.namespace &&
        ts.isPropertyAccessExpression(callee) &&
        context.libraryGlobal(callee.expression) === "window"
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
        let transferCpp = "";
        if (transfer) {
            const list = context.unwrap(transfer);
            if (!ts.isArrayLiteralExpression(list))
                return context.fail(
                    list,
                    "Worker transfer lists currently require an explicit array of supported transferable values.",
                );
            const entries = list.elements.map((element) => {
                if (
                    ts.isSpreadElement(element) ||
                    ts.isOmittedExpression(element)
                )
                    return context.fail(
                        element,
                        "Worker transfer list entries must be explicit values.",
                    );
                const value = context.compileValue(element);
                if (value.kind !== "offscreen-canvas")
                    return context.fail(
                        element,
                        `Transfer of '${value.kind}' is not implemented.`,
                    );
                const temporary =
                    context.allocateTemporaryCppName("transfer_value");
                context.emit({
                    kind: "declaration",
                    type: "auto",
                    name: temporary,
                    initializer: value.cpp,
                });
                return `${temporary}.get()`;
            });
            const listName = context.allocateTemporaryCppName("transfer_list");
            context.emit(
                `const std::array<bbl::pal::Transferable*, ${entries.length}> ${listName}{${entries.join(", ")}};`,
            );
            transferCpp = `, ${listName}`;
        }
        return {
            kind: "void",
            cpp: `${receiver}post_message(bbl::js::serialize_message(${snapshot}${transferCpp}))`,
        };
    }
    if (
        (worker || workerScope) &&
        (member === "addEventListener" || member === "removeEventListener")
    ) {
        const event = node.arguments[0];
        const callback = node.arguments[1];
        if (
            !event ||
            !ts.isStringLiteralLike(event) ||
            !["message", "error"].includes(event.text) ||
            !callback ||
            node.arguments.length > 3
        ) {
            return context.fail(
                node,
                "Worker listeners require an admitted event name and callback.",
            );
        }
        if (workerScope && event.text === "error")
            return context.fail(
                node,
                "WorkerGlobalScope error listeners are not yet admitted.",
            );
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
        const compiled = context.compileWorkerCallback(
            callback,
            event.text as "message" | "error",
        );
        return {
            kind: "void",
            cpp: `${receiver}${member === "addEventListener" ? "add" : "remove"}_${event.text}_listener(${compiled}${member === "addEventListener" ? `, ${once}` : ""})`,
        };
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
            cpp: `${loop}.cancel_animation_frame(bbl::js::to_uint32(${context.compileNumber(argumentAt(node, 0), "double")}))`,
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
        const callback = context.compileFrameCallback(
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
            cpp: `${loop}.clear_timer(static_cast<bbl::pal::EventLoop::TimerId>(${context.compileNumber(argumentAt(node, 0), "double")}))`,
        };
    }
    if ((global || workerScope) && member === "queueMicrotask") {
        if (node.arguments.length !== 1)
            return context.fail(node, "queueMicrotask requires one callback.");
        return {
            kind: "void",
            cpp: `${loop}.queue_microtask(${context.compileFrameCallback(argumentAt(node, 0), "void")})`,
        };
    }
    return undefined;
}
