import ts from "typescript";
import { browserGlobalNamed } from "./browser-erasure.js";
import { rootIdentifier, argumentAt } from "./syntax.js";
import { validateObjectProperties } from "./option-helpers.js";
import type { DataLowerer } from "./data-lowering.js";
import type { DataTypeRegistry } from "./data-types.js";
import type { Value, WorkerCompilation, NativeHostUi } from "./types.js";

export interface WorkerLoweringContext {
    readonly options: { workers?: WorkerCompilation; nativeHostUi?: NativeHostUi };
    readonly dataLowerer: DataLowerer;
    readonly dataTypes: DataTypeRegistry;
    unwrap(expression: ts.Expression): ts.Expression;
    isDefaultLibraryIdentifier(identifier: ts.Identifier): boolean;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    compileValue(expression: ts.Expression): Value;
    compileFrameCallback(expression: ts.Expression, signature: "void" | "interval"): string;
    compileWorkerCallback(expression: ts.Expression, event: "message" | "error"): string;
    compileNumber(expression: ts.Expression, precision?: "float" | "double"): string;
    emit(line: string): void;
    allocateTemporaryCppName(label: string): string;
    cppString(value: string): string;
    propertyName(name: ts.PropertyName): string | undefined;
    fail(node: ts.Node, message: string): never;
}

const realm = "bbl::pal::WorkerRealm::current()";
const loop = "bbl::pal::EventLoop::current()";

export function isNativeWorkerExpression(context: WorkerLoweringContext, expression: ts.Expression): boolean {
    if (!context.options.workers) return false;
    let node = context.unwrap(expression);
    if (ts.isCallExpression(node)) node = context.unwrap(node.expression);
    if (ts.isNewExpression(node)) node = context.unwrap(node.expression);
    const globalMember = browserGlobalNamed(context, node);
    if (globalMember && globalMember !== node) {
        return ["Worker", "OffscreenCanvas", "ResizeObserver", "matchMedia", "devicePixelRatio", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "postMessage", "close"].includes(globalMember.text);
    }
    const root = rootIdentifier(node, inner => context.unwrap(inner));
    if (!root) return false;
    const bound = context.lookupOptional(root);
    if (bound?.kind.startsWith("worker") || bound?.kind === "offscreen-canvas") return true;
    return browserGlobalNamed(context, root) !== undefined &&
        ["Worker", "OffscreenCanvas", "ResizeObserver", "matchMedia", "self", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "postMessage", "close"].includes(root.text);
}

/** Browser Worker operations lower to realm services, independently of an engine. */
export function compileWorkerValue(context: WorkerLoweringContext, expression: ts.Expression): Value | undefined {
    if (!context.options.workers) return undefined;
    const node = context.unwrap(expression);
    const isGlobal = (value: ts.Expression, name: string): boolean =>
        ts.isIdentifier(value) && browserGlobalNamed(context, value)?.text === name;
    const scope = (value: ts.Expression): Value | undefined => {
        const unwrapped = context.unwrap(value);
        if (isGlobal(unwrapped, "self") || isGlobal(unwrapped, "globalThis")) {
            return { kind: "worker-scope", cpp: realm };
        }
        return ts.isIdentifier(unwrapped) ? context.lookupOptional(unwrapped) : undefined;
    };
    if (ts.isIdentifier(node) && isGlobal(node, "self")) {
        if (!context.options.workers.namespace) return context.fail(node, "The application Window self is not a worker global scope.");
        return { kind: "worker-scope", cpp: realm };
    }
    if (ts.isNewExpression(node)) {
        const entry = context.options.workers.register(node);
        if (!entry) return undefined;
        const options = node.arguments![1] as ts.ObjectLiteralExpression;
        validateObjectProperties(context, options, ["name", "type", "credentials"], "Unsupported Worker option.");
        let name = '""';
        for (const property of options.properties) {
            if (!ts.isPropertyAssignment(property)) return context.fail(property, "Worker options must have explicit property assignments.");
            const key = context.propertyName(property.name);
            if (key === "name") name = context.dataLowerer.compileForSink(property.initializer, { kind: "string" });
            else if (key === "credentials" && (!ts.isStringLiteralLike(property.initializer) || property.initializer.text !== "same-origin")) {
                return context.fail(property, "Packaged local workers support same-origin credentials only.");
            }
        }
        return { kind: "worker", cpp: `${realm}.create_worker(${entry}, ${name})`, impure: true };
    }
    if (ts.isPropertyAccessExpression(node)) {
        const owner = scope(node.expression);
        if (owner?.kind === "worker-message-event" && node.name.text === "data") {
            const type = context.dataLowerer.dataTypeAt(expression);
            if (!type) return context.fail(expression, "MessageEvent.data requires a supported data type at its read boundary.");
            const cppType = context.dataTypes.cppType(type);
            return { kind: type.kind === "number" || type.kind === "boolean" || type.kind === "string" ? type.kind : "data",
                cpp: `${owner.cpp}->data<${cppType}>()`, dataType: type };
        }
        if (owner?.kind === "worker-error-event" && ["message", "filename"].includes(node.name.text)) {
            return { kind: "string", cpp: `${owner.cpp}.${node.name.text}` };
        }
        if (owner?.kind === "worker-scope" && node.name.text === "name") return { kind: "string", cpp: `${realm}.name()` };
        return undefined;
    }
    if (!ts.isCallExpression(node)) return undefined;
    const callee = context.unwrap(node.expression);
    const member = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
    const owner = ts.isPropertyAccessExpression(callee) ? scope(callee.expression) : undefined;
    const global = ts.isIdentifier(callee) && context.isDefaultLibraryIdentifier(callee);
    const worker = owner?.kind === "worker";
    const workerScope = owner?.kind === "worker-scope" || (global && context.options.workers.namespace !== undefined);
    const receiver = worker ? `${owner.cpp}->` : `${realm}.`;
    if ((worker || workerScope) && member === "postMessage") {
        if (node.arguments.length < 1 || node.arguments.length > 2) return context.fail(node, "Worker postMessage requires a message and optional transfer list.");
        const argument = argumentAt(node, 0);
        const type = context.dataLowerer.dataTypeAt(argument);
        if (!type) return context.fail(argument, "Worker messages require a supported structured-clone data shape.");
        const data = context.dataLowerer.compileForSink(argument, type);
        const snapshot = context.allocateTemporaryCppName("message_value");
        context.emit(`auto ${snapshot} = ${data};`);
        const transfer = node.arguments[1];
        let transferCpp = "";
        if (transfer) {
            const list = context.unwrap(transfer);
            if (!ts.isArrayLiteralExpression(list)) return context.fail(list, "Worker transfer lists currently require an explicit array of supported transferable values.");
            const entries = list.elements.map(element => {
                if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return context.fail(element, "Worker transfer list entries must be explicit values.");
                const value = context.compileValue(element);
                if (value.kind !== "offscreen-canvas") return context.fail(element, `Transfer of '${value.kind}' is not implemented.`);
                const temporary = context.allocateTemporaryCppName("transfer_value");
                context.emit(`auto ${temporary} = ${value.cpp};`);
                return `${temporary}.get()`;
            });
            const listName = context.allocateTemporaryCppName("transfer_list");
            context.emit(`const std::array<bbl::pal::Transferable*, ${entries.length}> ${listName}{${entries.join(", ")}};`);
            transferCpp = `, ${listName}`;
        }
        return { kind: "void", cpp: `${receiver}post_message(bbl::js::serialize_message(${snapshot}${transferCpp}))` };
    }
    if ((worker || workerScope) && (member === "addEventListener" || member === "removeEventListener")) {
        const event = node.arguments[0];
        const callback = node.arguments[1];
        if (!event || !ts.isStringLiteralLike(event) || !["message", "error"].includes(event.text) || !callback || node.arguments.length > 3) {
            return context.fail(node, "Worker listeners require an admitted event name and callback.");
        }
        if (workerScope && event.text === "error") return context.fail(node, "WorkerGlobalScope error listeners are not yet admitted.");
        let once = false;
        const options = node.arguments[2];
        if (options) {
            if (!ts.isObjectLiteralExpression(options)) return context.fail(options, "Worker listener options must be a static record.");
            for (const property of options.properties) {
                if (!ts.isPropertyAssignment(property) || context.propertyName(property.name) !== "once" ||
                    ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(property.initializer.kind)) {
                    return context.fail(property, "Only static once is admitted in Worker listener options.");
                }
                once = property.initializer.kind === ts.SyntaxKind.TrueKeyword;
            }
        }
        const compiled = context.compileWorkerCallback(callback, event.text as "message" | "error");
        return { kind: "void", cpp: `${receiver}${member === "addEventListener" ? "add" : "remove"}_${event.text}_listener(${compiled}${member === "addEventListener" ? `, ${once}` : ""})` };
    }
    if (worker && member === "terminate" && node.arguments.length === 0) return { kind: "void", cpp: `${receiver}terminate()` };
    if (workerScope && member === "close" && node.arguments.length === 0) return { kind: "void", cpp: `${realm}.close()` };
    if (owner?.kind === "worker-error-event" && member === "preventDefault" && node.arguments.length === 0) {
        return { kind: "void", cpp: `${owner.cpp}.prevent_default()` };
    }
    if ((global || workerScope) && (member === "setTimeout" || member === "setInterval")) {
        if (node.arguments.length < 1 || node.arguments.length > 2) return context.fail(node, "Native timers require a callback and optional delay.");
        const callback = context.compileFrameCallback(argumentAt(node, 0), member === "setInterval" ? "interval" : "void");
        const delay = node.arguments[1] ? context.compileNumber(node.arguments[1], "double") : "0.0";
        return { kind: "number", cpp: `static_cast<double>(${loop}.set_timeout(${callback}, ${delay}, ${member === "setInterval"}))`, impure: true };
    }
    if ((global || workerScope) && (member === "clearTimeout" || member === "clearInterval")) {
        if (node.arguments.length !== 1) return context.fail(node, "Timer cancellation requires its numeric identifier.");
        return { kind: "void", cpp: `${loop}.clear_timer(static_cast<bbl::pal::EventLoop::TimerId>(${context.compileNumber(argumentAt(node, 0), "double")}))` };
    }
    if ((global || workerScope) && member === "queueMicrotask") {
        if (node.arguments.length !== 1) return context.fail(node, "queueMicrotask requires one callback.");
        return { kind: "void", cpp: `${loop}.queue_microtask(${context.compileFrameCallback(argumentAt(node, 0), "void")})` };
    }
    return undefined;
}
