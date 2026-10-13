import ts from "typescript";
import {
    declarationApi,
    declaredInDomLibrary,
    resolvedDomApi,
    resolvedSymbol,
} from "./symbols.js";
import { nativeWindowMember } from "./window-properties.js";

/**
 * The DOM-declared APIs native lowers, keyed by {@link resolvedDomApi}. The
 * compile dispatch recognizes its calls by these keys, and browser erasure
 * keeps every one for it: a lowered API never erases.
 */

/** A Window function, called or read globally or as a Window member. */
const windowFunction = (names: readonly string[]): string[] =>
    names.flatMap((name) => [name, `Window.${name}`]);

/** `message-boxes.ts`. */
export const MESSAGE_BOX_FUNCTIONS = ["alert", "confirm"] as const;

/** `idle-callbacks.ts`: calls, and reads of the function values. */
export const IDLE_FUNCTIONS = [
    "requestIdleCallback",
    "cancelIdleCallback",
] as const;

/** `fullscreen.ts`: each API and the method it lowers. */
export const FULLSCREEN_METHODS: ReadonlyMap<
    string,
    "requestFullscreen" | "exitFullscreen"
> = new Map([
    ["Element.requestFullscreen", "requestFullscreen"],
    ["Document.exitFullscreen", "exitFullscreen"],
]);

/** `pointer-capture.ts`: each API and the `pal_dom_events.hpp` operation it lowers to. */
export const POINTER_CAPTURE_OPERATIONS: ReadonlyMap<string, string> = new Map([
    ["Element.setPointerCapture", "bbl::dom_set_pointer_capture"],
    ["Element.releasePointerCapture", "bbl::dom_release_pointer_capture"],
    ["Element.hasPointerCapture", "bbl::dom_has_pointer_capture"],
]);

/** `media-streams.ts`. */
export const MEDIA_RECORDER_TYPE_SUPPORTED = "MediaRecorder.isTypeSupported";
export const CANVAS_CAPTURE_STREAM = "HTMLCanvasElement.captureStream";

/** The engine's gamepad snapshot (`expressions.ts`). */
export const NAVIGATOR_GET_GAMEPADS = "Navigator.getGamepads";

const LOWERED_CALLS: ReadonlySet<string> = new Set([
    ...windowFunction(MESSAGE_BOX_FUNCTIONS),
    ...windowFunction(IDLE_FUNCTIONS),
    ...FULLSCREEN_METHODS.keys(),
    ...POINTER_CAPTURE_OPERATIONS.keys(),
    MEDIA_RECORDER_TYPE_SUPPORTED,
    CANVAS_CAPTURE_STREAM,
    NAVIGATOR_GET_GAMEPADS,
]);

const LOWERED_READS: ReadonlySet<string> = new Set(
    windowFunction(IDLE_FUNCTIONS),
);

/**
 * Whether native lowers this DOM call, or this read of a DOM member (a
 * Window member through an authored view of Window too).
 */
export function hasDomLowering(
    checker: ts.TypeChecker,
    node: ts.Expression,
): boolean {
    if (ts.isCallExpression(node)) {
        const api = resolvedDomApi(checker, node);
        return api !== undefined && LOWERED_CALLS.has(api);
    }
    const symbol = ts.isPropertyAccessExpression(node)
        ? nativeWindowMember(checker, node)
        : resolvedSymbol(checker, node);
    if (!symbol || !declaredInDomLibrary(symbol)) return false;
    return (symbol.declarations ?? []).some((declaration) => {
        const api = declarationApi(declaration);
        return api !== undefined && LOWERED_READS.has(api);
    });
}
