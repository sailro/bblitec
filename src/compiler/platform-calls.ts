import ts from "typescript";
import { registerUiImageAsset } from "./assets.js";
import { bakeCanvasReadback } from "./canvas-readback.js";
import { compileCharacterMethod, type CharacterIntrinsicContext } from "./intrinsics/character-controller.js";
import type { LoweringServices } from "./lowering-services.js";
import { argumentAt } from "./syntax.js";
import type { Value } from "./types.js";
import { UiProjection } from "./ui-projection.js";
import { requireWindowHost, windowErrorEventValue } from "./window-events.js";
import { browserGlobalNamed } from "./browser-erasure.js";



type PlatformEventTarget = "window" | "document" | "canvas";

interface PlatformEventDescriptor {
    channel: string;
    parameter: "none" | "keyboard" | "mouse" | "visibility";
}

const PLATFORM_EVENT_DESCRIPTORS: Readonly<
    Record<
        PlatformEventTarget,
        Readonly<Record<string, PlatformEventDescriptor>>
    >
> = {
    window: {
        resize: { channel: "window_resize", parameter: "none" },
        keydown: { channel: "key_down", parameter: "keyboard" },
        keyup: { channel: "key_up", parameter: "keyboard" },
        pointerdown: { channel: "pointer_down", parameter: "none" },
        mousedown: { channel: "mouse_down", parameter: "mouse" },
        mouseup: { channel: "mouse_up", parameter: "mouse" },
        pointerup: { channel: "mouse_up", parameter: "mouse" },
        pointermove: { channel: "mouse_move", parameter: "mouse" },
        mousemove: { channel: "mouse_move", parameter: "mouse" },
        wheel: { channel: "mouse_wheel", parameter: "mouse" },
        pointercancel: { channel: "mouse_cancel", parameter: "mouse" },
    },
    document: {
        pointermove: { channel: "mouse_move", parameter: "mouse" },
        mousemove: { channel: "mouse_move", parameter: "mouse" },
        pointerlockchange: {
            channel: "pointer_lock_change",
            parameter: "none",
        },
        visibilitychange: {
            channel: "visibility_change",
            parameter: "visibility",
        },
    },
    canvas: {
        keydown: { channel: "key_down", parameter: "keyboard" },
        keyup: { channel: "key_up", parameter: "keyboard" },
        click: { channel: "canvas_click", parameter: "none" },
        mousedown: { channel: "mouse_down", parameter: "mouse" },
        mouseup: { channel: "mouse_up", parameter: "mouse" },
        pointerdown: { channel: "mouse_down", parameter: "mouse" },
        pointerup: { channel: "mouse_up", parameter: "mouse" },
        pointermove: { channel: "mouse_move", parameter: "mouse" },
        mousemove: { channel: "mouse_move", parameter: "mouse" },
        wheel: { channel: "mouse_wheel", parameter: "mouse" },
        pointercancel: { channel: "mouse_cancel", parameter: "mouse" },
    },
};

interface PlatformCallContext extends CharacterIntrinsicContext, Pick<LoweringServices,
    "assets" | "assetPayloads" |
    "allocateTemporaryCppName" |
    "callbackIdentity" |
    "canvasReadbackFunctions" |
    "checker" |
    "compileBoolean" |
    "compileCondition" |
    "compileFrameCallback" |
    "compileNumber" |
    "compilePlatformCallback" |
    "compileStringLiteral" |
    "compileValue" |
    "cppString" |
    "defaultEngine" |
    "emit" |
    "engineHasStarted" |
    "evaluateBrowserValue" |
    "evaluator" |
    "expectArgumentCount" |
    "expectKind" |
    "expectSameEngine" |
    "fail" |
    "hasPresentationHost" |
    "hoistForwardCallbackBindings" |
    "isBrowserOnlyExpression" |
    "isCanvasElement" |
    "isDefaultLibraryIdentifier" |
    "isInFrameCallback" |
    "isNativeHostUiLookup" |
    "isPrimaryCanvas2DContextCall" |
    "lookupOptional" |
    "objectProperty" |
    "options" |
    "pinValueToTemporary" |
    "reachFeature" |
    "reachJsData" |
    "registerAsset" |
    "requireDefaultEngine" |
    "requireEngine" |
    "requirePresentationHost" |
    "symbols" |
    "userFunctions" |
    "unwrap"
> {}

export class PlatformCalls {
    public constructor(private readonly context: PlatformCallContext, private readonly ui: UiProjection) {}


    /** Platform-backed browser APIs that remain ordinary expression values. */
    public compilePlatformCall(call: ts.CallExpression): Value | undefined {
        const callee = this.context.unwrap(call.expression);
        if (ts.isPropertyAccessExpression(callee)) {
            const typeName = this.context.checker.getTypeAtLocation(callee.expression).getSymbol()?.getName();
            if (typeName === "PhysicsCharacterController" || typeName === "CharacterCollisionObservable") {
                const owner = this.context.compileValue(callee.expression);
                const result = compileCharacterMethod(this.context, call, owner, callee.name.text);
                if (result) return result;
            }
        }
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "addEventListener" &&
            !this.context.isBrowserOnlyExpression(callee.expression)) {
            const owner = this.context.compileValue(callee.expression);
            if (owner.kind === "gpu-device") {
                this.context.expectArgumentCount(call, 2, 2);
                if (this.context.compileStringLiteral(argumentAt(call, 0)) !== "uncapturederror") this.context.fail(call, "Only GPU uncapturederror listeners are represented.");
                this.context.reachFeature("engine:device-recovery", call);
                const message = this.context.allocateTemporaryCppName("gpu_error");
                const value: Value = { kind: "record", cpp: "", recordProperties: { error: { kind: "record", cpp: "", recordProperties: { message: { kind: "string", cpp: message, dataType: { kind: "string" } } } } } };
                const callback = this.context.compilePlatformCallback(argumentAt(call, 1), { cppType: "const std::string&", name: message }, [value], undefined, false, false);
                return { kind: "void", cpp: `bbl::add_gpu_error_listener(${owner.cpp}, ${callback.cpp})` };
            }
        }
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "disable") {
            const owner = this.context.compileValue(callee.expression);
            if (owner.kind === "device-recovery") {
                this.context.expectArgumentCount(call, 0, 0);
                return { kind: "void", cpp: `bbl::disable_device_recovery(${owner.cpp})` };
            }
        }
        if (ts.isPropertyAccessExpression(callee)) {
            const value = this.compileUiCall(call, callee);
            if (value) return value;
        }
        if (
            ts.isIdentifier(callee) &&
            this.context.isDefaultLibraryIdentifier(callee)
        ) {
            if (callee.text === "isFinite") {
                this.context.expectArgumentCount(call, 1, 1);
                return {
                    kind: "boolean",
                    cpp:
                        `std::isfinite(` +
                        `${this.context.compileNumber(argumentAt(call, 0), "double")})`,
                };
            }
            if (callee.text === "setInterval") {
                this.context.expectArgumentCount(call, 2, 2);
                const engine = this.context.requireDefaultEngine(call);
                const callback = this.context.compileFrameCallback(
                    argumentAt(call, 0),
                    "interval",
                );
                const delay = this.context.compileNumber(argumentAt(call, 1), "double");
                return {
                    kind: "number",
                    cpp: `bbl::set_interval(${engine}, ${callback}, ${delay})`,
                    impure: true,
                };
            }
            if (callee.text === "clearInterval") {
                this.context.expectArgumentCount(call, 1, 1);
                const engine = this.context.requireDefaultEngine(call);
                return {
                    kind: "void",
                    cpp:
                        `bbl::clear_interval(${engine}, ` +
                        `${this.context.compileNumber(argumentAt(call, 0), "double")})`,
                };
            }
            if (callee.text === "clearTimeout") {
                this.context.expectArgumentCount(call, 1, 1);
                const engine = this.context.requireDefaultEngine(call);
                return {
                    kind: "void",
                    cpp:
                        `bbl::clear_timeout(${engine}, ` +
                        `${this.context.compileNumber(argumentAt(call, 0), "double")})`,
                };
            }
        }
        if (!ts.isPropertyAccessExpression(callee)) {
            return undefined;
        }
        const receiver = this.context.unwrap(callee.expression);
        if (
            callee.name.text === "destroy" &&
            call.arguments.length === 0 &&
            ts.isPropertyAccessExpression(receiver) &&
            receiver.name.text === "texture"
        ) {
            const texture = this.context.compileValue(receiver.expression);
            if (texture.kind === "texture") {
                if (texture.textureStorage !== "render") {
                    // File and pixel textures are immutable engine assets;
                    // only createRenderTexture2D exposes a live GPU target
                    // whose WebGPU destroy call has observable lifetime.
                    return { kind: "void", cpp: "" };
                }
                return {
                    kind: "void",
                    cpp:
                        `bbl::dispose_sprite_render_texture(` +
                        `${texture.engineCpp ?? this.context.requireDefaultEngine(call)}, ` +
                        `${texture.cpp})`,
                };
            }
        }
        if (
            callee.name.text === "now" &&
            call.arguments.length === 0 &&
            ts.isIdentifier(receiver) &&
            receiver.text === "performance" &&
            this.context.isDefaultLibraryIdentifier(receiver)
        ) {
            return {
                kind: "number",
                cpp: "bbl::pal::performance_milliseconds()",
                impure: true,
            };
        }
        if (
            callee.name.text === "now" &&
            call.arguments.length === 0 &&
            ts.isIdentifier(receiver) &&
            receiver.text === "Date" &&
            this.context.isDefaultLibraryIdentifier(receiver)
        ) {
            return {
                kind: "number",
                cpp: "bbl::js::epoch_milliseconds()",
                impure: true,
            };
        }
        if (
            callee.name.text === "preventDefault"
        ) {
            const platformEvent = ts.isIdentifier(receiver)
                ? this.context.lookupOptional(receiver)
                : ts.isPropertyAccessExpression(receiver) ||
                    ts.isElementAccessExpression(receiver)
                  ? this.context.compileValue(receiver)
                  : undefined;
            if (
                platformEvent?.kind === "platform-keyboard-event" ||
                platformEvent?.kind === "platform-mouse-event" || platformEvent?.nativeErrorEvent
            ) {
                if (call.arguments.length) this.context.fail(call, "Event.preventDefault accepts no arguments.");
                return {
                    kind: "void",
                    cpp: `${platformEvent.cpp}.prevent_default()`,
                };
            }
        }
        if (
            callee.name.text === "focus" &&
            call.arguments.length === 0 &&
            ts.isIdentifier(receiver) &&
            this.context.isCanvasElement(receiver)
        ) {
            return {
                kind: "void",
                cpp: `bbl::focus_canvas(${this.context.requireDefaultEngine(call)})`,
            };
        }
        if (
            callee.name.text === "requestPointerLock" &&
            call.arguments.length === 0 &&
            ts.isIdentifier(receiver) &&
            this.context.isCanvasElement(receiver)
        ) {
            return {
                kind: "void",
                cpp: `bbl::request_pointer_lock(${this.context.requireDefaultEngine(call)})`,
            };
        }
        if (
            callee.name.text === "exitPointerLock" &&
            call.arguments.length === 0 &&
            ts.isIdentifier(receiver) &&
            receiver.text === "document" &&
            this.context.isDefaultLibraryIdentifier(receiver)
        ) {
            return {
                kind: "void",
                cpp: `bbl::exit_pointer_lock(${this.context.requireDefaultEngine(call)})`,
            };
        }
        return undefined;
    }


    /** Whether a named RAF callback explicitly schedules itself again. */
    private animationFrameCallbackRearmsItself(
        expression: ts.Expression,
    ): boolean {
        const callback = this.context.unwrap(expression);
        if (!ts.isIdentifier(callback)) return false;
        const symbol = this.context.symbols.valueSymbol(callback);
        if (!symbol) return false;
        const declaration = symbol.valueDeclaration;
        let functionNode: ts.FunctionLikeDeclaration | undefined;
        if (
            declaration &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer
        ) {
            const initializer = this.context.unwrap(declaration.initializer);
            if (
                ts.isArrowFunction(initializer) ||
                ts.isFunctionExpression(initializer)
            ) {
                functionNode = initializer;
            }
        } else if (declaration && ts.isFunctionDeclaration(declaration)) {
            functionNode = declaration;
        }
        if (!functionNode?.body) return false;

        let rearmed = false;
        const visit = (node: ts.Node): void => {
            if (rearmed) return;
            if (node !== functionNode && ts.isFunctionLike(node)) return;
            if (ts.isCallExpression(node)) {
                const callee = this.context.unwrap(node.expression);
                const argument = node.arguments[0]
                    ? this.context.unwrap(node.arguments[0])
                    : undefined;
                if (
                    ts.isIdentifier(callee) &&
                    callee.text === "requestAnimationFrame" &&
                    argument &&
                    ts.isIdentifier(argument) &&
                    this.context.symbols.valueSymbol(argument) === symbol
                ) {
                    rearmed = true;
                    return;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(functionNode.body);
        return rearmed;
    }


    /**
     * Registers an application-owned browser animation loop on the native
     * frame conductor. Browser RAF callbacks run in registration order. A
     * callback registered before `startEngine` therefore updates before the
     * engine-owned render callback, while one registered after the awaited
     * start (the platformer conductor) runs after rendering and affects the
     * following frame. Native startup itself remains deferred because its
     * platform loop blocks.
     *
     * A recursive request inside the callback only re-arms the browser
     * callback; the conductor is already recurring, so that call emits
     * nothing. The callback belongs to the engine frame conductor, so
     * scene-less applications do not fabricate a SceneContext that would
     * select the wrong native renderer.
     */
    public compileAnimationFrameCall(
        call: ts.CallExpression,
    ): Value | undefined {
        this.context.expectArgumentCount(call, 1, 1);
        const argument = this.context.unwrap(argumentAt(call, 0));
        const stored = ts.isIdentifier(argument) ? this.context.lookupOptional(argument) : undefined;
        // A materialized callback retains its own requeue operation, including
        // conditional schedules and synchronous priming calls.
        const recurring = !(stored?.kind === "callback" && stored.cpp.length > 0) && this.animationFrameCallbackRearmsItself(
            argumentAt(call, 0),
        );
        const nested = this.context.isInFrameCallback();
        if (nested && recurring) {
            return { kind: "void", cpp: "" };
        }
        const engine = this.context.requireDefaultEngine(call);
        const callback = this.context.compileFrameCallback(
            argumentAt(call, 0),
            "timestamp",
        );
        if (!recurring) {
            return { kind: "void", cpp: `bbl::request_animation_frame(${engine}, ${callback})` };
        }
        this.requireCompatibleFrameConductor("persistent", call);
        const callbacks = this.context.engineHasStarted()
            ? "post_render_animation_frame_callbacks"
            : "animation_frame_callbacks";
        return {
            kind: "void",
            cpp: `${engine}.${callbacks}.push_back(${callback})`,
        };
    }


    private frameConductorOwner: "manager" | "persistent" | undefined;


    public requireCompatibleFrameConductor(owner: "manager" | "persistent", site: ts.Node): void {
        if (this.frameConductorOwner && this.frameConductorOwner !== owner) {
            this.context.fail(site, "Autonomous animation managers cannot share a program with a persistent application RAF loop; that loop must retain its source requeue before the two callback orders can compose.");
        }
        this.frameConductorOwner = owner;
    }


    public emitPlatformEventListener(call: ts.CallExpression): boolean {
        const callee = this.context.unwrap(call.expression);
        if (
            !ts.isPropertyAccessExpression(callee) ||
            (callee.name.text !== "addEventListener" &&
                callee.name.text !== "removeEventListener")
        ) {
            return false;
        }
        const removing = callee.name.text === "removeEventListener";
        const uiElement = this.ui.uiElementValue(callee.expression);
        if (uiElement) {
            if (removing) return false;
            this.context.expectArgumentCount(call, 2, 2);
            const event = this.context.compileStringLiteral(argumentAt(call, 0));
            if (event === "change") {
                if (uiElement.uiTag !== "input" || !uiElement.uiFileInput) {
                    this.context.fail(
                        argumentAt(call, 0),
                        "The native 'change' event is supported only on a retained <input type=\"file\">.",
                    );
                }
                this.context.reachFeature("browser:file", call);
            }
            const mappedEvent =
                event === "pointerdown"
                    ? "mousedown"
                    : event === "pointerup"
                      ? "mouseup"
                      : event === "pointermove"
                        ? "mousemove"
                        : event === "pointercancel" ||
                            event === "lostpointercapture"
                          ? "mouseout"
                          : event;
            if (
                event !== "click" &&
                event !== "focus" &&
                event !== "mousedown" &&
                event !== "pointerdown" &&
                event !== "pointerup" &&
                event !== "pointermove" &&
                event !== "pointercancel" &&
                event !== "lostpointercapture" &&
                event !== "change" &&
                event !== "input" &&
                event !== "contextmenu"
            ) {
                this.context.fail(
                    argumentAt(call, 0),
                    `Native UI elements do not support the '${event}' event.`,
                );
            }
            const callback = argumentAt(call, 1);
            this.context.hoistForwardCallbackBindings(callback, call.pos);
            const engine = this.context.requireEngine(uiElement, call);
            if (event === "contextmenu") {
                // Native has no browser context menu to suppress.
                return true;
            }
            const parameter = this.context.allocateTemporaryCppName("ui_pointer_event");
            const pointerValue: Value = {
                kind: "platform-mouse-event",
                cpp: parameter,
                readOnly: true,
            };
            const lambda = this.context.compilePlatformCallback(
                callback,
                event === "click" || event === "change"
                    ? undefined
                    : {
                          cppType: "const bbl::PlatformMouseEvent&",
                          name: parameter,
                      },
                event === "click" || event === "change" ? [] : [pointerValue],
                undefined,
                true,
                false,
            );
            const registration =
                event === "click"
                    ? "ui_on_click"
                    : event === "change"
                      ? "ui_on_file_change"
                      : "ui_on_event";
            this.context.emit(
                `bbl::${registration}(` +
                    `${engine}, ${uiElement.cpp}, ` +
                    `${
                        event === "click" || event === "change"
                            ? ""
                            : `${this.context.cppString(mappedEvent)}, `
                    }` +
                    `${lambda.cpp});`,
            );
            return true;
        }
        if (!ts.isIdentifier(callee.expression)) return false;
        const target = this.context.isDefaultLibraryIdentifier(callee.expression)
            ? callee.expression.text
            : this.context.isCanvasElement(callee.expression)
              ? "canvas"
              : undefined;
        if (
            target !== "window" &&
            target !== "document" &&
            target !== "canvas"
        ) {
            return false;
        }
        if (call.arguments.length < 2 || call.arguments.length > 3) {
            this.context.fail(
                call,
                "Platform event listeners require an event name, callback, and optional options record.",
            );
        }
        const event = this.context.evaluator.staticTextValue(argumentAt(call, 0));
        const callback = argumentAt(call, 1);
        this.context.hoistForwardCallbackBindings(callback, call.pos);
        let once = false;
        if (!removing && call.arguments[2]) {
            const options = this.context.unwrap(call.arguments[2]);
            if (!ts.isObjectLiteralExpression(options)) {
                this.context.fail(
                    options,
                    "Native event listener options require a static object literal.",
                );
            }
            const onceExpression = this.context.objectProperty(options, "once");
            if (onceExpression) {
                const compiled = this.context.compileCondition(onceExpression);
                if (compiled !== "true" && compiled !== "false") {
                    this.context.fail(
                        onceExpression,
                        "The event listener 'once' option must be static.",
                    );
                }
                once = compiled === "true";
            }
        }
        if (target === "window" && this.context.options.workers && (event === "error" || event === "unhandledrejection")) {
            requireWindowHost(this.context, call);
            const rejection = event === "unhandledrejection";
            if (removing) {
                const identity = this.platformEventCallbackIdentity(this.context.compileValue(callback), callback);
                this.context.emit(`bbl::pal::window_off_application_error(${rejection}, ${identity});`);
            } else {
                const name = this.context.allocateTemporaryCppName("application_error");
                const listener = this.context.compilePlatformCallback(callback,
                    {cppType:"bbl::pal::ApplicationErrorEvent&", name}, [windowErrorEventValue(this.context, name, rejection)]);
                this.context.emit(`bbl::pal::window_on_application_error(${rejection}, ${listener.identity}, ${listener.cpp}, ${once});`);
            }
            return true;
        }
        const engine = this.context.requireDefaultEngine(call);
        const descriptor = this.platformEventDescriptor(target, event);
        if (!descriptor) return false;
        if (removing) {
            const callbackValue = this.context.compileValue(callback);
            const identity = this.platformEventCallbackIdentity(
                callbackValue,
                callback,
            );
            this.context.emit(
                `bbl::off_${descriptor.channel}(${engine}, ${identity});`,
            );
            return true;
        }
        let parameter: { cppType: string; name: string } | undefined;
        let values: Value[] = [];
        let documentHiddenCpp: string | undefined;
        if (descriptor.parameter === "keyboard") {
            const name = this.context.allocateTemporaryCppName("key_event");
            parameter = {
                cppType: "const bbl::PlatformKeyboardEvent&",
                name,
            };
            values = [
                {
                    kind: "platform-keyboard-event",
                    cpp: name,
                    readOnly: true,
                },
            ];
        } else if (descriptor.parameter === "mouse") {
            const name = this.context.allocateTemporaryCppName("mouse_event");
            parameter = {
                cppType: "const bbl::PlatformMouseEvent&",
                name,
            };
            values = [
                {
                    kind: "platform-mouse-event",
                    cpp: name,
                    readOnly: true,
                },
            ];
        } else if (descriptor.parameter === "visibility") {
            const name = this.context.allocateTemporaryCppName("document_hidden");
            parameter = { cppType: "bool", name };
            documentHiddenCpp = name;
        }
        const listener = this.context.compilePlatformCallback(
            callback,
            parameter,
            values,
            documentHiddenCpp,
        );
        this.context.emit(
            `bbl::on_${descriptor.channel}(` +
                `${engine}, ${listener.identity}, ${listener.cpp}` +
                `${once ? ", true" : ""});`,
        );
        return true;
    }


    private platformEventDescriptor(
        target: PlatformEventTarget,
        event: string | undefined,
    ): PlatformEventDescriptor | undefined {
        return event === undefined
            ? undefined
            : PLATFORM_EVENT_DESCRIPTORS[target][event];
    }


    public platformEventCallbackIdentity(
        callback: Value,
        node: ts.Node,
    ): string {
        if (callback.kind === "data" && callback.dataType?.kind === "function") return `(${callback.cpp}).identity()`;
        if (callback.kind !== "callback") {
            this.context.fail(node, "Platform event listener is not a callback.");
        }
        if (callback.platformCallbackIdentity !== undefined) {
            return `${callback.platformCallbackIdentity}u`;
        }
        if (!callback.callbackDeclaration) {
            this.context.fail(
                node,
                "Platform event listener has no stable callback identity.",
            );
        }
        return `${this.context.callbackIdentity(
            callback.callbackDeclaration,
            callback.callbackRecordOwner,
        )}u`;
    }

    private compileUiCall(call: ts.CallExpression, callee: ts.PropertyAccessExpression): Value | undefined {
        if (this.context.isPrimaryCanvas2DContextCall(call)) {
            if (this.context.defaultEngine() && !this.context.hasPresentationHost()) {
                this.context.fail(call, "The primary canvas already belongs to a Babylon engine; it cannot also acquire a Canvas2D context.");
            }
            this.context.requirePresentationHost(call);
        }
        if (this.context.isNativeHostUiLookup(call)) {
            const id = this.context.evaluator.staticTextValue(argumentAt(call, 0));
            const engine = this.ui.documentEngine(call);
            this.context.reachFeature("ui:rml", call);
            const tag = id !== undefined ? this.ui.nativeHostUiTags().get(id) : undefined;
            if (!tag) return {
                kind:"data", cpp:`bbl::ui_find_element_by_id(${engine}, ${this.ui.uiStringCpp(argumentAt(call, 0), "element id")})`,
                dataType:{kind:"optional", inner:{kind:"handle", handle:"ui-element"}}, engineCpp:engine,
            };
            return {
                kind: "ui-element",
                cpp: `bbl::ui_get_element_by_id(${engine}, ` +
                    `${this.context.cppString(id!)})`,
                engineCpp: engine,
                uiHostId: id!,
                uiTag: tag,
                truthinessCpp: "true",
            };
        }
        if (callee.name.text === "createElement" &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "document" &&
            this.context.isDefaultLibraryIdentifier(callee.expression)) {
            this.context.expectArgumentCount(call, 1, 1);
            const tag = this.context.compileStringLiteral(argumentAt(call, 0));
            const normalizedTag = tag.toLowerCase();
            if (!/^[a-z][a-z0-9-]*$/i.test(tag)) {
                this.context.fail(argumentAt(call, 0), `Native UI element tag '${tag}' is not valid.`);
            }
            if (UiProjection.UI_IMPLEMENTATION_TAGS.has(normalizedTag)) {
                this.context.fail(argumentAt(call, 0), `Native UI element tag '${tag}' is reserved for the retained projection.`);
            }
            const engine = this.ui.documentEngine(call);
            this.context.reachFeature("ui:rml", call);
            const uiStaticId = this.ui.createUiStaticElement(normalizedTag);
            this.ui.uiStaticIdsByCreation.set(call, uiStaticId);
            return {
                kind: "ui-element",
                cpp: `bbl::ui_create_element(${engine}, ${this.context.cppString(normalizedTag)})`,
                engineCpp: engine,
                uiTag: normalizedTag,
                uiStaticId,
                ...(normalizedTag === "canvas"
                    ? {
                        uiCanvas: true as const,
                        uiCanvasId: this.ui.uiCanvasIds++,
                    }
                    : {}),
            };
        }
        const classListMutation = ts.isPropertyAccessExpression(callee.expression) &&
            callee.expression.name.text === "classList" &&
            (callee.name.text === "add" ||
                callee.name.text === "remove" ||
                callee.name.text === "toggle");
        const rootAppend = (callee.name.text === "append" || callee.name.text === "appendChild") &&
            ts.isPropertyAccessExpression(callee.expression) &&
            (callee.expression.name.text === "body" || callee.expression.name.text === "head") &&
            browserGlobalNamed(this.context, callee.expression.expression)?.text === "document";
        if (rootAppend && callee.name.text === "append" && call.arguments.length === 0) return {kind:"void", cpp:""};
        const element: Value | undefined = rootAppend
            ? {kind:"ui-element", cpp:"{}", uiRoot:true, engineCpp:this.ui.documentEngine(call)}
            : classListMutation
            ? undefined
            : this.ui.uiElementValue(callee.expression);
        if (element?.uiTag === "image-bitmap" &&
            callee.name.text === "close") {
            this.context.expectArgumentCount(call, 0, 0);
            return { kind: "void", cpp: "" };
        }
        if (element?.uiCanvas &&
            !element.uiCanvasContext &&
            callee.name.text === "getContext") {
            this.context.expectArgumentCount(call, 1, 1);
            const context = this.context.compileStringLiteral(argumentAt(call, 0));
            if (context !== "2d") {
                this.context.fail(argumentAt(call, 0), "Retained native canvas only supports the '2d' context.");
            }
            return {
                ...element,
                uiCanvasContext: true,
            };
        }
        if (element?.uiCanvasContext) {
            const engine = this.context.requireEngine(element, call);
            const number = (index: number): string => this.context.compileNumber(argumentAt(call, index), "double");
            const invocation = (name: string, minimum: number, maximum = minimum): Value => {
                this.context.expectArgumentCount(call, minimum, maximum);
                return {
                    kind: "void",
                    cpp: `bbl::ui_canvas_${name}(${engine}, ${element.cpp}` +
                        `${call.arguments.length > 0 ? ", " : ""}` +
                        `${call.arguments.map((_argument, index) => number(index)).join(", ")})`,
                };
            };
            switch (callee.name.text) {
                case "scale":
                    this.ui.recordUiCanvasLogicalScale(call);
                    return invocation("scale", 2);
                case "clearRect":
                    this.ui.expectUiCanvasFullSurfaceClear(call, element.uiCanvasId);
                    return invocation("clear_rect", 4);
                case "fillRect":
                    return invocation("fill_rect", 4);
                case "beginPath":
                    return invocation("begin_path", 0);
                case "moveTo":
                    return invocation("move_to", 2);
                case "lineTo":
                    return invocation("line_to", 2);
                case "closePath":
                    return invocation("close_path", 0);
                case "arcTo":
                    return invocation("arc_to", 5);
                case "arc":
                    this.context.expectArgumentCount(call, 5, 6);
                    return {
                        kind: "void",
                        cpp: `bbl::ui_canvas_arc(${engine}, ${element.cpp}, ` +
                            `${call.arguments
                                .slice(0, 5)
                                .map((_argument, index) => number(index))
                                .join(", ")}, ` +
                            `${call.arguments[5] ? this.context.compileBoolean(call.arguments[5]) : "false"})`,
                    };
                case "fill":
                    return invocation("fill", 0);
                case "stroke":
                    return invocation("stroke", 0);
                case "getImageData": {
                    this.context.expectArgumentCount(call, 4, 4);
                    const atlas = bakeCanvasReadback(this.context, call);
                    for (const image of atlas.images) {
                        registerUiImageAsset(this.context, image.source, image.logicalPath);
                    }
                    const asset = this.context.registerAsset(`data:application/octet-stream;base64,${Buffer.from(atlas.pixels).toString("base64")}`, "pixels");
                    this.context.reachJsData();
                    return {
                        kind: "record",
                        cpp: "",
                        recordProperties: {
                            data: {
                                kind: "data",
                                cpp: `bbl::js::U8Array(bbl::js::ArrayBuffer(` +
                                    `bbl::pal::read_binary_file(bbl::asset_path(` +
                                    `${this.context.cppString(asset.output)}))))`,
                                dataType: { kind: "u8array" },
                            },
                        },
                    };
                }
                case "putImageData": {
                    this.context.expectArgumentCount(call, 3, 3);
                    const imageData = this.context.unwrap(argumentAt(call, 0));
                    if (!ts.isNewExpression(imageData) ||
                        !ts.isIdentifier(imageData.expression) ||
                        imageData.expression.text !== "ImageData" ||
                        !this.context.isDefaultLibraryIdentifier(imageData.expression) ||
                        (imageData.arguments?.length ?? 0) !== 3) {
                        this.context.fail(argumentAt(call, 0), "Retained Canvas2D putImageData requires new ImageData(rgba, width, height).");
                    }
                    let pixelsExpression = imageData.arguments![0]!;
                    const pixelsConstructor = this.context.unwrap(pixelsExpression);
                    if (ts.isNewExpression(pixelsConstructor) &&
                        ts.isIdentifier(pixelsConstructor.expression) &&
                        (pixelsConstructor.expression.text ===
                            "Uint8ClampedArray" ||
                            pixelsConstructor.expression.text ===
                                "Uint8Array") &&
                        pixelsConstructor.arguments?.length === 1) {
                        pixelsExpression = argumentAt(pixelsConstructor, 0);
                    }
                    const pixels = this.context.compileValue(pixelsExpression);
                    if (pixels.kind !== "data" ||
                        pixels.dataType?.kind !== "u8array") {
                        this.context.fail(pixelsExpression, "Retained Canvas2D ImageData pixels must lower to a Uint8Array.");
                    }
                    return {
                        kind: "void",
                        cpp: `bbl::ui_canvas_put_image_data(${engine}, ${element.cpp}, ` +
                            `${pixels.cpp}, ` +
                            `${this.context.compileNumber(imageData.arguments![1]!, "double")}, ` +
                            `${this.context.compileNumber(imageData.arguments![2]!, "double")}, ` +
                            `${number(1)}, ${number(2)})`,
                    };
                }
                case "drawImage": {
                    this.context.expectArgumentCount(call, 5, 5);
                    const source = this.context.compileValue(argumentAt(call, 0));
                    if (source.kind !== "ui-element") {
                        this.context.fail(argumentAt(call, 0), "Retained Canvas2D drawImage source must be a retained UI element; " +
                            `received ${source.kind}.`);
                    }
                    if (source.uiTag === "image-bitmap") {
                        return { kind: "void", cpp: "" };
                    }
                    this.context.expectSameEngine(element, source, call);
                    const sourceText = this.context.unwrap(argumentAt(call, 0)).getText();
                    const extent = (argumentIndex: number, axis: "width" | "height"): string => {
                        const argument = this.context.unwrap(argumentAt(call, argumentIndex));
                        let dimension: ts.Expression = argument;
                        let multiplier = "1.0";
                        if (ts.isBinaryExpression(argument) &&
                            argument.operatorToken.kind ===
                                ts.SyntaxKind.AsteriskToken) {
                            const left = this.context.unwrap(argument.left);
                            const right = this.context.unwrap(argument.right);
                            const leftIsDimension = ts.isPropertyAccessExpression(left) &&
                                left.name.text === axis;
                            const rightIsDimension = ts.isPropertyAccessExpression(right) &&
                                right.name.text === axis;
                            if (leftIsDimension) {
                                dimension = left;
                                multiplier = this.context.compileNumber(argument.right, "double");
                            }
                            else if (rightIsDimension) {
                                dimension = right;
                                multiplier = this.context.compileNumber(argument.left, "double");
                            }
                        }
                        if (!ts.isPropertyAccessExpression(dimension) ||
                            dimension.name.text !== axis ||
                            this.context.unwrap(dimension.expression).getText() !==
                                sourceText) {
                            this.context.fail(argumentAt(call, argumentIndex), `Retained Canvas2D drawImage ${axis} must be source.${axis}, optionally multiplied by a scale.`);
                        }
                        return (`(bbl::ui_canvas_${axis}(${engine}, ${source.cpp}) * ` +
                            `(${multiplier}))`);
                    };
                    return {
                        kind: "void",
                        cpp: `bbl::ui_canvas_draw_image(${engine}, ${element.cpp}, ${source.cpp}, ` +
                            `${number(1)}, ${number(2)}, ${extent(3, "width")}, ${extent(4, "height")})`,
                    };
                }
                case "fillText":
                    this.context.expectArgumentCount(call, 3, 3);
                    return {
                        kind: "void",
                        cpp: `bbl::ui_canvas_fill_text(${engine}, ${element.cpp}, ` +
                            `${this.ui.uiStringCpp(argumentAt(call, 0), "Canvas2D fillText")}, ` +
                            `${number(1)}, ${number(2)})`,
                    };
            }
        }
        if (element && callee.name.text === "focus") {
            this.context.expectArgumentCount(call, 0, 0);
            const engine = this.context.requireEngine(element, call);
            const focus = `bbl::ui_focus(${engine}, ${element.cpp})`;
            return {
                kind: "void",
                cpp: element.optionalFoundCpp
                    ? `(${element.optionalFoundCpp} ? ${focus} : static_cast<void>(0))`
                    : focus,
            };
        }
        if (element && callee.name.text === "click") {
            this.context.expectArgumentCount(call, 0, 0);
            if (element.uiTag === "input") {
                if (!element.uiFileInput) {
                    this.context.fail(call, "Programmatic <input>.click() requires the static type 'file'.");
                }
                this.context.reachFeature("browser:file", call);
            }
            else if (element.uiTag === "a") {
                this.context.reachFeature("browser:file", call);
            }
            const engine = this.context.requireEngine(element, call);
            return {
                kind: "void",
                cpp: `bbl::ui_click(${engine}, ${element.cpp})`,
            };
        }
        if (element && callee.name.text === "querySelector") {
            this.context.expectArgumentCount(call, 1, 1);
            const selector = this.context.compileStringLiteral(argumentAt(call, 0));
            if (element.uiStaticId === undefined) {
                this.context.fail(call, "Retained UI querySelector requires a statically-known retained root.");
            }
            const query = selector.match(/^\.([A-Za-z_][A-Za-z0-9_-]*)$/)
                ? {
                    kind: "class" as const,
                    name: selector.slice(1),
                    value: "",
                }
                : selector.match(/^#([A-Za-z_][A-Za-z0-9_-]*)$/)
                    ? {
                        kind: "attribute" as const,
                        name: "id",
                        value: selector.slice(1),
                    }
                    : (() => {
                        const matched = selector.match(/^\[([A-Za-z_:][A-Za-z0-9_:.-]*)=["']([^"']*)["']\]$/);
                        return matched
                            ? {
                                kind: "attribute" as const,
                                name: matched[1]!.toLowerCase(),
                                value: matched[2]!,
                            }
                            : selector.match(/^[A-Za-z][A-Za-z0-9-]*$/)
                                ? {
                                    kind: "tag" as const,
                                    name: selector.toLowerCase(),
                                    value: "",
                                }
                                : undefined;
                    })();
            if (!query) {
                this.context.fail(argumentAt(call, 0), `Retained UI querySelector selector '${selector}' is not lowered.`);
            }
            const descendants = this.ui.uiStaticDescendants(element.uiStaticId);
            const match = descendants.markup.find((node) => query.kind === "class"
                ? node.classes.has(query.name)
                : query.kind === "tag"
                    ? node.tag === query.name
                    : node.attributes.get(query.name) === query.value);
            if (!descendants.complete || !match) {
                this.context.fail(call, `Retained UI querySelector('${selector}') requires a matching node in a complete static innerHTML subtree.`);
            }
            const engine = this.context.requireEngine(element, call);
            return {
                kind: "ui-element",
                cpp: `bbl::ui_query_markup(${engine}, ${element.cpp}, ` +
                    `${match.id}u, ${this.context.cppString(match.tag)})`,
                engineCpp: engine,
                uiTag: match.tag,
                truthinessCpp: "true",
            };
        }
        if (element && callee.name.text === "querySelectorAll") {
            this.context.expectArgumentCount(call, 1, 1);
            const selector = this.context.compileStringLiteral(argumentAt(call, 0));
            const matched = selector.match(/^\.([A-Za-z_][A-Za-z0-9_-]*)$/);
            if (!matched) {
                this.context.fail(argumentAt(call, 0), `Retained UI querySelectorAll selector '${selector}' is not lowered; only a static '.class' scoped query is supported.`);
            }
            if (element.uiStaticId !== undefined) {
                const descendants = this.ui.uiStaticDescendants(element.uiStaticId);
                const markupMatches = descendants.markup.filter((node) => node.classes.has(matched[1]!));
                if (markupMatches.length > 0) {
                    if (!descendants.complete) {
                        this.context.fail(call, "Retained UI markup query requires a complete static innerHTML subtree.");
                    }
                    const engine = this.context.requireEngine(element, call);
                    this.context.reachJsData();
                    return {
                        kind: "data",
                        cpp: "bbl::js::Array<bbl::UiElementHandle>{" +
                            markupMatches
                                .map((node) => `bbl::ui_query_markup(${engine}, ${element.cpp}, ` +
                                `${node.id}u, ${this.context.cppString(node.tag)})`)
                                .join(", ") +
                            "}",
                        dataType: {
                            kind: "vector",
                            element: {
                                kind: "handle",
                                handle: "ui-element",
                            },
                        },
                    };
                }
            }
            this.ui.uiPendingClassQueries.push({
                root: element,
                className: matched[1]!,
                site: call,
            });
            const engine = this.context.requireEngine(element, call);
            this.context.reachJsData();
            return {
                kind: "data",
                cpp: element.optionalFoundCpp
                    ? `(${element.optionalFoundCpp} ? ` +
                        `bbl::ui_query_class(${engine}, ${element.cpp}, ` +
                        `${this.context.cppString(matched[1]!)}) : ` +
                        "bbl::js::Array<bbl::UiElementHandle>{})"
                    : `bbl::ui_query_class(${engine}, ${element.cpp}, ` +
                        `${this.context.cppString(matched[1]!)})`,
                dataType: {
                    kind: "vector",
                    element: {
                        kind: "handle",
                        handle: "ui-element",
                    },
                },
            };
        }
        if (element && callee.name.text === "setAttribute") {
            this.context.expectArgumentCount(call, 2, 2);
            const name = this.context.compileStringLiteral(argumentAt(call, 0));
            const engine = this.context.requireEngine(element, call);
            const browserFile = this.ui.compileUiBrowserFileAttribute(element, engine, name, argumentAt(call, 1), call, "attribute");
            if (browserFile) {
                return {
                    kind: "void",
                    cpp: browserFile,
                };
            }
            const staticValue = this.ui.tryUiStaticString(argumentAt(call, 1));
            const sourceValue = staticValue === undefined
                ? this.context.compileValue(argumentAt(call, 1))
                : undefined;
            if (sourceValue !== undefined &&
                sourceValue.kind !== "string" &&
                !(sourceValue.kind === "data" &&
                    sourceValue.dataType?.kind === "string")) {
                this.context.fail(argumentAt(call, 1), `UI setAttribute value requires a string, received ${sourceValue?.kind}.`);
            }
            const value = staticValue !== undefined
                ? this.context.cppString(this.ui.lowerUiAttributeLiteral(name, staticValue, argumentAt(call, 1)))
                : sourceValue!.cpp;
            if (name === "class" || name === "id") {
                this.ui.recordUiStaticAttribute(element, name, argumentAt(call, 1));
            }
            else if (name === "style" && staticValue !== undefined) {
                this.ui.recordUiStaticStyle(element, this.ui.lowerUiAttributeLiteral("style", staticValue, argumentAt(call, 1)));
            }
            else if (name === "style") {
                this.ui.recordUiUnknownStaticStyle(element);
            }
            return {
                kind: "void",
                cpp: `bbl::ui_set_attribute(${engine}, ${element.cpp}, ` +
                    `${this.context.cppString(name)}, ` +
                    `${value})`,
            };
        }
        if (element && callee.name.text === "appendChild") {
            this.context.expectArgumentCount(call, 1, 1);
            const child = this.context.compileValue(argumentAt(call, 0));
            this.context.expectKind(child, "ui-element", argumentAt(call, 0));
            if (!element.uiRoot) {
                this.context.expectSameEngine(element, child, call);
            }
            const engine = this.context.requireEngine(element.uiRoot ? child : element, call);
            if (element.uiRoot) {
                this.ui.recordUiStaticRootAppend(child);
            }
            else {
                this.ui.recordUiStaticAppend(element, child);
            }
            return {
                ...child,
                cpp: element.uiRoot
                    ? `bbl::ui_append_to_root(${engine}, ${child.cpp})`
                    : `bbl::ui_append_child(${engine}, ${element.cpp}, ${child.cpp})`,
                engineCpp: engine,
            };
        }
        if (element && callee.name.text === "append") {
            // Even named handles need a snapshot: later arguments may rebind
            // the receiver or an earlier argument before insertion begins.
            const snapshot = (value: Value, label: string, node: ts.Expression): Value => {
                const {nativeBinding, ...expression} = value;
                return this.context.pinValueToTemporary(expression, label, node);
            };
            const receiver = element.uiRoot ? element : snapshot(element, "append_receiver", callee.expression);
            const children = call.arguments.map((argument) => {
                const child = this.context.compileValue(argument);
                if (child.kind !== "string") this.context.expectKind(child, "ui-element", argument);
                return snapshot(child, "append_argument", argument);
            });
            if (children.length === 0) {
                return { kind: "void", cpp: "" };
            }
            const engine = receiver.uiRoot ? this.ui.documentEngine(call) : this.context.requireEngine(receiver, call);
            const appends = children.map((value) => {
                const child: Value = value.kind === "string" ? {
                    kind:"ui-element", cpp:"", engineCpp:engine,
                    uiTag:"#text", uiStaticId:this.ui.createUiStaticElement("#text"),
                } : value;
                if (receiver.uiRoot) {
                    this.context.expectSameEngine({kind:"engine", cpp:engine, engineCpp:engine}, child, call);
                    this.ui.recordUiStaticRootAppend(child);
                    if (value.kind === "string") return `bbl::ui_append_text(${engine}, {}, ${value.cpp})`;
                    return `bbl::ui_append_to_root(${engine}, ${child.cpp})`;
                }
                this.context.expectSameEngine(receiver, child, call);
                this.ui.recordUiStaticAppend(receiver, child);
                if (value.kind === "string") return `bbl::ui_append_text(${engine}, ${receiver.cpp}, ${value.cpp})`;
                return `bbl::ui_append_child(${engine}, ${receiver.cpp}, ${child.cpp})`;
            });
            return { kind: "void", cpp: appends.join(", ") };
        }
        if (element && callee.name.text === "replaceChildren") {
            this.context.expectArgumentCount(call, 0, 0);
            const engine = this.context.requireEngine(element, call);
            this.ui.recordUiStaticReplaceChildren(element);
            return {
                kind: "void",
                cpp: `bbl::ui_replace_children(${engine}, ${element.cpp})`,
            };
        }
        if (element && callee.name.text === "remove") {
            this.context.expectArgumentCount(call, 0, 0);
            const engine = this.context.requireEngine(element, call);
            this.ui.recordUiStaticRemoval(element);
            return {
                kind: "void",
                cpp: element.optionalFoundCpp
                    ? `(${element.optionalFoundCpp} ? ` +
                        `bbl::ui_remove(${engine}, ${element.cpp}) : ` +
                        "static_cast<void>(0))"
                    : `bbl::ui_remove(${engine}, ${element.cpp})`,
            };
        }
        if (element && callee.name.text === "getBoundingClientRect") {
            this.context.expectArgumentCount(call, 0, 0);
            const engine = this.context.requireEngine(element, call);
            const rect = `bbl::ui_get_client_rect(${engine}, ${element.cpp})`;
            const component = (name: string): Value => ({
                kind: "number",
                cpp: `${rect}.${name}`,
                dataType: { kind: "number" },
                engineCpp: engine,
            });
            return {
                kind: "record",
                cpp: "",
                recordProperties: {
                    left: component("left"),
                    top: component("top"),
                    width: component("width"),
                    height: component("height"),
                },
            };
        }
        if (element &&
            (callee.name.text === "setPointerCapture" ||
                callee.name.text === "releasePointerCapture")) {
            this.context.expectArgumentCount(call, 1, 1);
            // RmlUi owns pointer capture while dispatching a pressed
            // control. The DOM call has no additional native action.
            return { kind: "void", cpp: "" };
        }
        if (element && callee.name.text === "hasPointerCapture") {
            this.context.expectArgumentCount(call, 1, 1);
            // RmlUi dispatches captured pointer motion back to the pressed
            // element. Reaching this callback is therefore the native
            // equivalent of the DOM capture predicate used by the demos.
            return { kind: "boolean", cpp: "true" };
        }
        if (element && callee.name.text === "animate") {
            this.context.expectArgumentCount(call, 2, 2);
            // Web Animations remains outside this retained UI slice. The
            // state mutation around it (text/style/removal) is preserved.
            return { kind: "void", cpp: "" };
        }
        if (element && callee.name.text === "removeEventListener") {
            this.context.expectArgumentCount(call, 2, 2);
            // Retained UI records share the engine lifetime.
            // Listener identity/removal is deferred with DOM lifecycle.
            return { kind: "void", cpp: "" };
        }
        if (classListMutation) {
            const classOwner = callee.expression.expression;
            let classElement = this.ui.uiElementValue(classOwner);
            if (!classElement &&
                ts.isCallExpression(this.context.unwrap(classOwner))) {
                const compiled = this.context.compileValue(classOwner);
                if (compiled.kind === "ui-element") {
                    classElement = compiled;
                }
            }
            if (classElement) {
                const method = callee.name.text;
                this.context.expectArgumentCount(call, method === "toggle" ? 2 : 1, method === "toggle" ? 2 : 1);
                const name = this.context.compileStringLiteral(argumentAt(call, 0));
                if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
                    this.context.fail(argumentAt(call, 0), `Native UI class name '${name}' is not valid.`);
                }
                const enabled = method === "toggle"
                    ? this.ui.uiBooleanCpp(argumentAt(call, 1), "UI classList.toggle")
                    : method === "add"
                        ? "true"
                        : "false";
                this.ui.recordUiStaticClass(classElement, name, method as "add" | "remove" | "toggle", enabled);
                if (classElement.uiStaticId === undefined) {
                    this.ui.uiUnknownClassMutations.push({
                        className: name,
                        site: call,
                    });
                }
                const engine = this.context.requireEngine(classElement, call);
                const mutation = `bbl::ui_toggle_class(${engine}, ${classElement.cpp}, ` +
                    `${this.context.cppString(name)}, ${enabled})`;
                return {
                    kind: "void",
                    cpp: classElement.optionalFoundCpp
                        ? `(${classElement.optionalFoundCpp} ? ${mutation} : static_cast<void>(0))`
                        : mutation,
                };
            }
        }
        return undefined;
    }
}
