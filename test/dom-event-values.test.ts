import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("owned DOM events retain payload, routing, identity and listener cleanup", (t) => {
    const directory = resolve("artifacts/dom-event-values");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(`
        const parent = document.createElement("div");
        const target = document.createElement("input");
        target.id = "target";
        parent.appendChild(target);
        document.body.appendChild(parent);
        type PickerWindow = Window & {
            showOpenFilePicker?: () => Promise<unknown>;
            showSaveFilePicker?: () => Promise<unknown>;
            showDirectoryPicker?: () => Promise<unknown>;
        };
        const pickerWindow = window as PickerWindow;
        const openPicker = pickerWindow.showOpenFilePicker;
        const savePicker = (window as PickerWindow).showSaveFilePicker;
        const directoryPicker = pickerWindow.showDirectoryPicker;
        if (openPicker || savePicker || directoryPicker || typeof savePicker !== "undefined")
            throw new Error("native file picker capability");
        function localPicker(): number {
            const window = {showSaveFilePicker: () => 3};
            return window.showSaveFilePicker();
        }
        if (localPicker() !== 3) throw new Error("shadowed window capability");
        interface OptionalOwner { events?: EventTarget | null; }
        const optionalOwner: OptionalOwner = { events: target };
        let selectedCalls = 0;
        let argumentCalls = 0;
        let optionalCalls = 0;
        const optionalListener = () => { optionalCalls++; };
        const optionalListeners: Array<() => void> = [optionalListener];
        function select(): EventTarget | null | undefined {
            selectedCalls++;
            return optionalOwner.events;
        }
        function listenerArgument(): () => void {
            argumentCalls++;
            optionalOwner.events = null;
            return optionalListeners[0]!;
        }
        select()?.addEventListener("click", listenerArgument());
        target.dispatchEvent(new MouseEvent("click"));
        optionalOwner.events?.addEventListener("click", listenerArgument());
        optionalOwner.events?.removeEventListener("click", listenerArgument());
        if (selectedCalls !== 1 || argumentCalls !== 1 || optionalCalls !== 1)
            throw new Error("optional target evaluation and arguments");
        optionalOwner.events = target;
        select()?.removeEventListener("click", listenerArgument());
        target.dispatchEvent(new MouseEvent("click"));
        if (selectedCalls !== 2 || argumentCalls !== 2 || optionalCalls !== 1)
            throw new Error("optional target removal snapshot");
        const optionalOwners: OptionalOwner[] = [{events:window}, {}, {events:document}, {events:target}, {events:null}];
        for (const owner of optionalOwners) owner.events?.addEventListener("pointerup", optionalListener);
        target.dispatchEvent(new PointerEvent("pointerup", {bubbles:true}));
        if (optionalCalls !== 4) throw new Error("optional stored target routing");
        for (const owner of optionalOwners) owner.events?.removeEventListener("pointerup", optionalListener);
        target.dispatchEvent(new PointerEvent("pointerup", {bubbles:true}));
        if (optionalCalls !== 4) throw new Error("optional stored target cleanup");
        interface ListenerView {
            addEventListener(type: "click", callback: () => void): void;
            removeEventListener(type: "click", callback: () => void): void;
        }
        function listenThroughView(options: {events?: ListenerView | null}): () => void {
            options.events?.addEventListener("click", optionalListener);
            return () => options.events?.removeEventListener("click", optionalListener);
        }
        const removeView = listenThroughView({events:window});
        const removeAbsent = listenThroughView({});
        target.dispatchEvent(new MouseEvent("click", {bubbles:true}));
        if (optionalCalls !== 5) throw new Error("optional structural target view");
        removeView(); removeAbsent();
        target.dispatchEvent(new MouseEvent("click", {bubbles:true}));
        if (optionalCalls !== 5) throw new Error("optional structural target cleanup");
        const seen = new WeakSet<Event>();
        let count = 0;
        let order = "";
        interface Owner { target: EventTarget; }
        const owners: Owner[] = [{target:window}, {target:document}, {target:parent}, {target}];
        function install(owner: Owner): () => void {
            const listener = (event: Event): void => { count++; };
            for (const type of ["pointerdown", "keydown", "beforeinput", "input", "change"] as const)
                owner.target.addEventListener(type, listener, {capture:true});
            return () => {
                for (const type of ["pointerdown", "keydown", "beforeinput", "input", "change"] as const)
                    owner.target.removeEventListener(type, listener, {capture:true});
            };
        }
        const removers: Array<()=>void> = [];
        for (const owner of owners) removers.push(install(owner));
        const original = new PointerEvent("pointerdown", {
            bubbles:true, cancelable:true, composed:true, clientX:12, clientY:34,
            screenX:56, screenY:78, pointerId:9, pointerType:"pen", isPrimary:true,
            pressure:0.75, button:0, buttons:1, ctrlKey:true
        });
        const stored: PointerEvent[] = [original];
        if (stored[0] !== original || original.target !== null || original.currentTarget !== null)
            throw new Error("fresh event identity and targets");
        function copy(event: PointerEvent): PointerEvent {
            return new PointerEvent(event.type, {bubbles:event.bubbles, cancelable:event.cancelable,
                composed:event.composed, clientX:event.clientX, clientY:event.clientY,
                screenX:event.screenX, screenY:event.screenY, pointerId:event.pointerId,
                pointerType:event.pointerType, isPrimary:event.isPrimary, pressure:event.pressure,
                button:2, buttons:2, ctrlKey:false});
        }
        target.addEventListener("pointerdown", (event: PointerEvent) => {
            if (seen.has(event)) { order += "C"; event.preventDefault(); return; }
            if (event !== original || event.target !== target || event.currentTarget !== target ||
                event.clientX !== 12 || event.clientY !== 34 || event.screenX !== 56 || event.screenY !== 78 ||
                event.pointerId !== 9 || event.pointerType !== "pen" || !event.isPrimary || event.pressure !== 0.75)
                throw new Error("pointer payload or callback identity");
            order += "O";
            event.stopImmediatePropagation();
            const translated = copy(event);
            seen.add(translated);
            if (target.dispatchEvent(translated) || !translated.defaultPrevented)
                throw new Error("nested translated cancellation");
        });
        parent.addEventListener("pointerdown", () => {order += "P";});
        if (!target.dispatchEvent(original) || order !== "OCP" || count !== 8)
            throw new Error("nested routing and independent cancellation");
        for (const remove of removers) remove();
        seen.add(original);
        order = "";
        if (target.dispatchEvent(original) || order !== "CP" || count !== 8)
            throw new Error("cleanup, redispatch or retained cancellation");
        if (original.currentTarget !== null || original.target !== target || original.eventPhase !== 0)
            throw new Error("dispatch state cleanup");
        let inputs = 0;
        const input = new InputEvent("beforeinput", {data:"x", inputType:"insertText", isComposing:true,
            bubbles:true, cancelable:true});
        target.addEventListener("beforeinput", (event: InputEvent) => {
            inputs++;
            if (event.data !== "x" || event.inputType !== "insertText" || !event.isComposing || event !== input)
                throw new Error("input payload");
            event.preventDefault();
        }, {once:true});
        if (target.dispatchEvent(input) || inputs !== 1 || target.dispatchEvent(input) || inputs !== 1)
            throw new Error("input once and redispatch cancellation");
        function inputData(event: Event): string | null { return (event as InputEvent).data; }
        if (inputData(input) !== "x") throw new Error("checked base input view");
        const passive = new Event("change", {cancelable:true});
        target.addEventListener("change", event => event.preventDefault(), {passive:true});
        if (!target.dispatchEvent(passive) || passive.defaultPrevented) throw new Error("passive event");
        let receiver: EventTarget = target;
        const other = document.createElement("div");
        let refused = 0;
        let fabricated = false;
        other.addEventListener("click", event => {
            try { fabricated = event.clientX === 0; }
            catch { refused++; }
        });
        other.dispatchEvent(new Event("click"));
        if (refused !== 1 || fabricated) throw new Error("base event mouse view");
        let targetReads = 0;
        function argument(): PointerEvent { receiver = other; return new PointerEvent("pointerup"); }
        target.addEventListener("pointerup", () => {targetReads++;});
        receiver.dispatchEvent(argument());
        if (targetReads !== 1) throw new Error("dispatch receiver snapshot");
        const children: HTMLElement[] = [target];
        for (const child of children) {
            const ancestor = child.parentElement;
            if (!ancestor || ancestor.firstElementChild !== child || ancestor.lastElementChild?.parentElement !== ancestor)
                throw new Error("stored nullable tree projection");
        }
        target.remove();
        if (target.parentElement !== null) throw new Error("removed tree parent");
        parent.appendChild(target);
        const text = document.createElement("input");
        text.id = "physical";
        document.body.appendChild(text);
        const retained: PointerEvent[] = [];
        function keep(event: PointerEvent): void { retained.push(event); }
        text.addEventListener("pointermove", function collect(event: PointerEvent): void { keep(event); });
        text.addEventListener("pointerup", () => {
            const event = retained[0]!;
            if (event.clientX !== 77 || event.pointerId !== 15 || event.target !== text || event.currentTarget !== null)
                throw new Error("retained physical payload after dispatch");
            if (!event.isTrusted) throw new Error("physical trust before script dispatch");
            text.dispatchEvent(event);
            if (event.isTrusted || retained[1] !== event || event.currentTarget !== null)
                throw new Error("retained redispatch trust and identity");
            text.setAttribute("data-retained", "yes");
        });
        let physical = "";
        document.addEventListener("input", (event:Event) => {
            if (event.target !== text || text.value !== "native") throw new Error("physical state before capture");
            physical += "D";
        }, true);
        text.addEventListener("input", (event:Event) => { physical += "I"; event.preventDefault(); });
        text.addEventListener("change", (event:Event) => {
            if (event.composed || !event.bubbles || event.cancelable) throw new Error("physical change flags");
            physical += "C"; text.setAttribute("data-order", physical);
        });
        globalThis.close();
    `);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    emitUpstreamGenerated(directory, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "dom-event-values", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_HAS_PBR_RENDERER: 0,
            BBLITE_HAS_SDL_GPU: 1,
            BBLITE_HAS_DAWN: 0,
        },
        includeDirectories: [join(directory, "upstream/include")],
    });
});

test("synthetic event options reject fields without native ownership", () => {
    assert.throws(
        () =>
            compileSource(
                `new PointerEvent("pointerdown", {relatedTarget:document.body});`,
            ),
        /option 'relatedTarget' is not represented/,
    );
    assert.throws(
        () =>
            compileSource(
                `const options = {get clientX(){return 1;}}; new MouseEvent("click", options);`,
            ),
        /option accessors are not represented/,
    );
});
