/**
 * The event classes a program constructs and dispatches, with the init
 * dictionary members each represents beside its base classes'. A leaf
 * module: the analyses that only name the classes read it without the
 * lowering (`synthetic-events.ts`).
 */
export const SYNTHETIC_EVENT_OPTIONS = {
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
    KeyboardEvent: [
        "key",
        "code",
        "location",
        "repeat",
        "isComposing",
        "ctrlKey",
        "shiftKey",
        "altKey",
        "metaKey",
    ],
} as const;

/** Whether a library global is an event class a program constructs and dispatches. */
export function isSyntheticEventClass(
    name: string | undefined,
): name is keyof typeof SYNTHETIC_EVENT_OPTIONS {
    return name !== undefined && Object.hasOwn(SYNTHETIC_EVENT_OPTIONS, name);
}
