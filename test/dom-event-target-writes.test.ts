import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/dom-event-target-writes");

function compileEntry(body: string): string {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    return compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        ${body}`,
        { fileName: join(directory, "entry.ts") },
    ).cpp;
}

test("an event target narrowed to an element writes like the retained element it is", (t) => {
    const cpp = compileEntry(`
        const sheet = document.createElement("style");
        sheet.textContent = ".swatch{opacity:1;transition:opacity 0.1s}.open .swatch{opacity:0}.origin{opacity:1;transition:opacity 0.05s}.origin.open{opacity:0.5}";
        document.head.appendChild(sheet);
        const origin = document.createElement("div");
        origin.id = "origin";
        origin.className = "origin";
        function swatch(id: string, delay: string): void {
            const element = document.createElement("div");
            element.id = id;
            element.className = "swatch";
            element.style.transitionDelay = delay;
            origin.appendChild(element);
        }
        swatch("a", "20ms");
        swatch("b", "40ms");
        const button = document.createElement("button");
        button.id = "button";
        origin.appendChild(button);
        document.body.appendChild(origin);
        // One bubbling listener settles every control whose transition ends;
        // the origin's own transition is told apart by identity.
        origin.addEventListener("transitionend", (e) => {
            if (e.propertyName === "opacity" && e.target instanceof HTMLElement && e.target !== origin) {
                e.target.style.transitionDelay = "0ms";
                e.target.classList.add("settled");
                e.target.dataset.settled = e.propertyName;
            }
        });
        origin.addEventListener("click", (e) => {
            if (e.target instanceof Element && e.target !== e.currentTarget)
                e.target.setAttribute("aria-pressed", "true");
            if (e.currentTarget instanceof HTMLElement)
                e.currentTarget.dataset.last = e.target === e.currentTarget ? "self" : "bubbled";
        });
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        origin.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        // A target a record keeps, read back through a function: a detached
        // node hands its event to the document.
        interface Capture { readonly pointerId: number; readonly target: EventTarget }
        const captures = new Map<number, Capture>();
        function read(id: number): Capture | null { return captures.get(id) ?? null; }
        let pressedOn: EventTarget | null = null;
        captures.set(1, { pointerId: 1, target: document.createElement("span") });
        pressedOn = button;
        document.addEventListener("pointercancel", () => { origin.dataset.cancelled = "document"; });
        const cancelPress = (id: number): string => {
            const downOn = read(id)?.target ?? pressedOn;
            if (!downOn) return "none";
            (downOn instanceof Node && !downOn.isConnected ? document : downOn).dispatchEvent(new MouseEvent("pointercancel", { bubbles: true }));
            return String(downOn instanceof Node && downOn.isConnected);
        };
        origin.setAttribute("data-connected1", cancelPress(1));
        origin.setAttribute("data-connected2", cancelPress(2));
        // The same test kept in a name is the target's own answer too.
        const kept = (id: number): string => {
            const downOn = read(id)?.target ?? pressedOn;
            if (!downOn) return "none";
            const detached = typeof Node !== "undefined" && downOn instanceof Node && !downOn.isConnected;
            return detached ? "detached" : "attached";
        };
        origin.setAttribute("data-kept1", kept(1));
        origin.setAttribute("data-kept2", kept(2));
        // An element that may be absent falls back to another that may be.
        interface Layer { panel: HTMLElement }
        const stacks = new Map<Window, Layer[]>();
        const topLayer = (stack: Layer[]): Layer | undefined => stack[stack.length - 1];
        function topPanel(target: Window = window): HTMLElement | null {
            const stack = stacks.get(target);
            return stack ? topLayer(stack)?.panel ?? null : null;
        }
        function startScreen(): HTMLElement | null {
            const splash = document.getElementById("loading");
            return splash && splash.classList.contains("is-ready") ? splash : null;
        }
        let panels = "";
        const focused = (): void => {
            const panel = topPanel() ?? startScreen();
            panels += panel === null ? "none," : panel.id + ",";
        };
        focused();
        const splash = document.createElement("div");
        splash.id = "loading";
        splash.classList.add("is-ready");
        document.body.appendChild(splash);
        focused();
        stacks.set(window, [{ panel: button }]);
        focused();
        origin.setAttribute("data-panels", panels);
        // A binding every branch gives a constructed event owns that event.
        let downs = 0;
        button.addEventListener("pointerdown", () => { downs++; });
        const send = (target: EventTarget, pointer: boolean): void => {
            let event: Event;
            if (pointer) event = new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 });
            else event = new MouseEvent("pointerdown", { bubbles: true });
            target.dispatchEvent(event);
        };
        send(button, true);
        send(button, false);
        origin.setAttribute("data-downs", String(downs));
        // A constructed event carries the target the pointer came from.
        const previous = document.createElement("div");
        origin.appendChild(previous);
        button.addEventListener("pointerover", (e) => {
            origin.setAttribute("data-related", e.relatedTarget === previous ? "previous" : e.relatedTarget === null ? "none" : "other");
        });
        const hover = (from: Element | null): void => {
            button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: from }));
        };
        hover(null);
        origin.setAttribute("data-related-first", origin.getAttribute("data-related") ?? "");
        hover(previous);
        // An init typed as the platform's dictionary sets represented fields.
        button.addEventListener("pointermove", (e) => {
            origin.setAttribute("data-client", String(e.clientX));
        });
        const plain: MouseEventInit = { bubbles: true, clientX: 3 };
        button.dispatchEvent(new MouseEvent("pointermove", plain));
        globalThis.close();
    `);
    writeFileSync(join(directory, "program.hpp"), cpp);
    for (const write of [
        /bbl::ui_set_style_property\(bbl::dom_target_owner\([^;]+"transition-delay", "0ms"\)/,
        /bbl::ui_(?:set|toggle)_class\(bbl::dom_target_owner\([^;]+"settled", true\)/,
        /bbl::ui_set_attribute\(bbl::dom_target_owner\([^;]+"data-settled"/,
        /bbl::ui_set_attribute\(bbl::dom_target_owner\([^;]+"aria-pressed", "true"\)/,
        /bbl::ui_set_attribute\(bbl::dom_target_owner\([^;]+"data-last"/,
    ])
        assert.match(cpp, write);
    runRmlUiFixture(t, "dom-event-target-writes", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});
