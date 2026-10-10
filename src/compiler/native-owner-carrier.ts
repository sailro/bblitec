import {
    isNativeStructuralView,
    isOpaqueReference,
} from "./data-types/operations.js";
import { isHandleKind } from "./data-types/handles.js";
import type { DataType } from "./data-types/model.js";
import type { Value } from "./types.js";

/** Resource producers may carry their owner on Value before acquiring data storage. */
export function nativeStructuralViewType(value: Value): DataType | undefined {
    if (isNativeStructuralView(value.dataType)) return value.dataType;
    if (isHandleKind(value.kind)) return { kind: "handle", handle: value.kind };
    if (
        value.kind === "platform-keyboard-event" ||
        value.kind === "platform-mouse-event"
    )
        return {
            kind: "borrowed-platform-event",
            event: value.platformEventBase
                ? "event"
                : value.kind === "platform-keyboard-event"
                  ? "keyboard"
                  : "mouse",
        };
    return undefined;
}

/** Method-bearing records can expose an already represented owning handle. */
export function isNativeOwnerRecord(
    value: Value,
): value is Value & { kind: "record"; dataType: DataType } {
    return (
        value.kind === "record" &&
        value.cpp !== "" &&
        isOpaqueReference(value.dataType)
    );
}
