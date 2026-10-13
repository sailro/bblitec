import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { isDomReceiver } from "./dom-targets.js";
import { pinDetached } from "./dom-listeners.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";

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

/**
 * Whether a receiver is the Window: the Window identity value, the
 * `window`/`globalThis` globals, or a receiver the checker types as Window.
 */
export function isWindowReceiver(
    context: Pick<LoweringServices, "checker" | "libraryGlobal" | "unwrap">,
    value: Value,
    node: ts.Expression,
): boolean {
    const receiver = context.unwrap(node);
    const global = context.libraryGlobal(receiver);
    return (
        value.domEventTargetCpp === "bbl::DomEventTarget::window()" ||
        global === "window" ||
        global === "globalThis" ||
        isDomReceiver(context, receiver, "Window")
    );
}
