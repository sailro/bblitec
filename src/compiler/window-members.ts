import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { isDomReceiver } from "./dom-targets.js";
import { pinDetached } from "./dom-listeners.js";
import type { LoweringServices } from "./lowering-services.js";
import { declarationOrigin } from "./symbols.js";
import type { Value } from "./types.js";
import { requireWindowHost } from "./window-events.js";
import { ApplicationRealmRequired } from "./worker-modules.js";

/**
 * A call of the Window method `names` names: the global function, a member of
 * `window`/`globalThis`, or a member of another receiver the checker types as
 * Window (optional chains included). The receiver is evaluated once, before
 * `lower` compiles the arguments; an absent optional receiver skips them.
 * Undefined for any other call, an authored same-name function included.
 */
export function compileWindowMemberCall(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    names: readonly string[],
    lower: (name: string) => Value,
): Value | undefined {
    const context = lowerer.context;
    const callee = context.unwrap(call.expression);
    const global = context.libraryGlobal(callee);
    if (ts.isIdentifier(callee))
        return global !== undefined && names.includes(global)
            ? lower(global)
            : undefined;
    if (
        !ts.isPropertyAccessExpression(callee) ||
        !names.includes(callee.name.text)
    )
        return undefined;
    const name = callee.name.text;
    if (global === name) return lower(name);
    if (!isDomReceiver(context, callee.expression, "Window")) return undefined;
    const owner = context.compileValue(callee.expression);
    const run = (present: Value): Value => {
        context.emitDiscardedValue(
            pinDetached(context, present, "window_receiver", callee.expression),
        );
        return lower(name);
    };
    return callee.questionDotToken
        ? lowerer.optionalAccess(owner, call, run)
        : run(lowerer.narrowOptional(owner, callee.expression));
}

/** A Window service of the application realm: its Window host, and the realm itself. */
export function requireApplicationWindow(
    context: Pick<LoweringServices, "options" | "reachFeature" | "fail">,
    node: ts.Node,
): void {
    if (!context.options.workers) throw new ApplicationRealmRequired();
    requireWindowHost(context, node);
}

const WINDOW_SERVICE_CALLS = new Set([
    "alert",
    "confirm",
    "requestIdleCallback",
    "cancelIdleCallback",
    "requestFullscreen",
    "exitFullscreen",
    "isTypeSupported",
    "captureStream",
]);

/**
 * A call of a DOM-declared Window service lowered natively (message boxes,
 * idle callbacks, fullscreen, media capture): never a browser-only effect to
 * erase.
 */
export function isWindowServiceCall(
    context: Pick<LoweringServices, "checker" | "unwrap">,
    node: ts.Expression,
): boolean {
    if (!ts.isCallExpression(node)) return false;
    const callee = context.unwrap(node.expression);
    const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
    if (!name || !WINDOW_SERVICE_CALLS.has(name)) return false;
    const declaration = context.checker.getResolvedSignature(node)?.declaration;
    return (
        declaration !== undefined &&
        !ts.isJSDocSignature(declaration) &&
        declarationOrigin(declaration) === "dom"
    );
}
