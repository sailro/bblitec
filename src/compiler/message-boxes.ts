import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { MESSAGE_BOX_FUNCTIONS } from "./dom-lowerings.js";
import { stringConcatPart } from "./expressions.js";
import { isUndefinedDataType } from "./data-types.js";
import { isJsonValue } from "./json-bridge.js";
import { pinCpp } from "./evaluation-order.js";
import { optionalPresentCpp, type Value } from "./types.js";
import { requireWindowHost } from "./window-events.js";
import { compileWindowMemberCall } from "./window-members.js";

/**
 * `alert(message)` and `confirm(message)`: a modal message box the Window
 * thread shows while the realm waits (`bbl::pal::window_message_box`).
 */

/**
 * Web IDL DOMString text of `confirm`'s optional message (`""` when undefined)
 * or of `alert`'s message (its ToString, `"undefined"` included).
 */
function messageText(
    lowerer: DataLowerer,
    argument: ts.Expression | undefined,
    defaulted: boolean,
): string {
    const context = lowerer.context;
    if (!argument) return "std::string()";
    if (ts.isSpreadElement(argument))
        return context.fail(
            argument,
            "Message box arguments require an explicit message.",
        );
    const value = context.compileValue(argument);
    const text = (present: Value): string =>
        `bbl::js::concat(${stringConcatPart(context, present, argument)})`;
    if (!defaulted) return text(value);
    const declared = context.checker.getTypeAtLocation(argument);
    if (
        isUndefinedDataType(value.dataType) ||
        (declared.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0
    ) {
        context.emitDiscardedValue(value);
        return "std::string()";
    }
    const optional = value.dataType?.kind === "optional";
    if (!optional && !isJsonValue(value)) return text(value);
    const held = pinCpp(context, value.cpp, "message");
    if (optional && value.dataType?.kind === "optional")
        return `(${optionalPresentCpp(held)} ? ${text(lowerer.leafValue(`(*${held})`, value.dataType.inner))} : std::string())`;
    return `(${held}.is_undefined() ? std::string() : ${held}.to_string())`;
}

export function compileMessageBoxCall(
    lowerer: DataLowerer,
    call: ts.CallExpression,
): Value | undefined {
    const context = lowerer.context;
    return compileWindowMemberCall(
        lowerer,
        call,
        MESSAGE_BOX_FUNCTIONS,
        (name) => {
            requireWindowHost(context, call);
            context.expectArgumentCount(call, 0, 1);
            const confirm = name === "confirm";
            const message = messageText(lowerer, call.arguments[0], confirm);
            context.reachJsData();
            const cpp = `bbl::pal::window_message_box(${confirm}, ${message})`;
            return confirm
                ? { kind: "boolean", cpp, impure: true }
                : { kind: "void", cpp };
        },
    );
}
