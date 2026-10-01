import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { cppFunction, runRmlUiFixture } from "./native-fixture.js";

test("callbacks passed through helpers keep per-evaluation identity and removal", (t) => {
    const directory = resolve("artifacts/dom-callback-factories");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    writeFileSync(
        join(directory, "layout.ts"),
        `
        const first = [{name: "first"}, {name: "second"}];
        export const layout: readonly {name: string}[] = [...first, ...[3].map(value => ({name: String(value)}))];
    `,
    );
    const result = compileSource(
        `
        import {layout} from "./layout.js";
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        await Promise.resolve();
        if (layout.length !== 3 || layout[2]!.name !== "3") throw new Error("module initialization before host coroutine");
        if (!document.getElementById("prebuilt")) throw new Error("host initialization before entry");
        const prebuilt = document.getElementById("prebuilt") as HTMLElement | null;
        let prebuiltCalls = 0;
        const prebuiltCallback = () => { prebuiltCalls++; };
        prebuilt?.addEventListener("click", prebuiltCallback);
        document.getElementById("prebuilt")!.click();
        prebuilt?.removeEventListener("click", prebuiltCallback);
        document.getElementById("prebuilt")!.click();
        if (prebuiltCalls !== 1) throw new Error("known-present optional listener");
        const originalFetch = globalThis.fetch;
        const wrappedFetch: typeof fetch = async (input, init) => originalFetch.call(globalThis, input, init);
        globalThis.fetch = wrappedFetch;
        if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
        const target = document.createElement("button");
        document.body.appendChild(target);
        const log = document.createElement("div");
        log.id = "factory-log";
        document.body.appendChild(log);
        let calls = "";
        function wire(element: HTMLElement, callback: () => void): () => void {
            element.addEventListener("click", callback);
            element.addEventListener("click", callback);
            return () => element.removeEventListener("click", callback);
        }
        function install(element: HTMLElement, value: number): () => void {
            return wire(element, () => {
                calls += String(value);
            });
        }
        const removers: Array<() => void> = [];
        for (const value of [1, 2]) removers.push(install(target, value));
        const first = removers[0]!;
        const second = removers[1]!;
        target.click();
        if (calls !== "12") throw new Error("distinct creation, duplicate registration");
        first();
        target.click();
        if (calls !== "122") throw new Error("remove first identity");
        second();
        target.click();
        if (calls !== "122") throw new Error("remove second identity");
        const note = document.createElement("div");
        note.id = "void-note";
        document.body.appendChild(note);
        let labels = 0;
        function label(): string { labels++; return "label-" + labels; }
        const updates: Array<() => void> = [];
        function observe(callback: () => void): void { updates.push(callback); callback(); }
        observe(() => note.textContent = label());
        updates[0]!();
        if (labels !== 2) throw new Error("discarded assignment must evaluate its right side once per call");
        target.id = "first-target";
        const other = document.createElement("button");
        other.id = "second-target";
        document.body.appendChild(other);
        let lookups = 0;
        function element<T extends HTMLElement>(id: string): T {
            lookups++;
            const found = document.getElementById(id);
            if (!found) throw new Error("missing element");
            return found as T;
        }
        const bindings: readonly [string, () => void][] = [
            ["first-target", () => { calls += "A"; }],
            ["second-target", () => { calls += "B"; }],
        ];
        for (const [id, callback] of bindings) element(id).addEventListener("click", callback);
        const remove = () => {
            for (const [id, callback] of bindings) element(id).removeEventListener("click", callback);
        };
        target.click(); other.click();
        if (calls !== "122AB" || lookups !== 2) throw new Error("helper-return listeners");
        remove();
        target.click(); other.click();
        if (calls !== "122AB" || lookups !== 4) throw new Error("helper-return cleanup");
        let selectedId = "first-target";
        let receiverCalls = 0;
        let argumentCalls = 0;
        const late = () => { calls += "L"; };
        function receiver(): HTMLElement { receiverCalls++; return element(selectedId); }
        function callbackArgument(): () => void { argumentCalls++; selectedId = "second-target"; return late; }
        receiver().addEventListener("click", callbackArgument(), {once: true});
        other.click();
        target.click(); target.click();
        if (calls !== "122ABL" || receiverCalls !== 1 || argumentCalls !== 1) throw new Error("listener receiver snapshot");
        function optional(present: boolean): HTMLElement | null { receiverCalls++; return present ? target : null; }
        optional(false)?.addEventListener("click", callbackArgument());
        optional(false)?.removeEventListener("click", callbackArgument());
        if (receiverCalls !== 3 || argumentCalls !== 1) throw new Error("absent listener receiver");
        optional(true)?.addEventListener("click", late);
        target.click();
        optional(true)?.removeEventListener("click", late);
        target.click();
        if (calls !== "122ABLL" || receiverCalls !== 5) throw new Error("optional listener cleanup");
        let assignedCalls = 0;
        function assignedText(): string {
            assignedCalls++;
            selectedId = "first-target";
            return "assigned";
        }
        selectedId = "second-target";
        receiver().textContent = assignedText();
        if (assignedCalls !== 1 || receiverCalls !== 6)
            throw new Error("helper receiver assignment order");
        element("second-target").hidden = true;
        if (!other.hidden) throw new Error("helper hidden assignment");
        element("second-target").hidden = false;
        element("second-target").dataset.mode = "active";
        element("second-target").style.opacity = String(0.5);
        if (other.hidden || other.dataset.mode !== "active")
            throw new Error("helper DOM property assignment");
        let blurs = 0;
        const blurred = () => { blurs++; };
        target.addEventListener("blur", blurred);
        target.focus(); other.focus();
        if (blurs !== 1) throw new Error("synchronous element blur");
        target.removeEventListener("blur", blurred);
        target.focus(); other.focus();
        if (blurs !== 1) throw new Error("removed element blur");
        const canvas = document.createElement("canvas");
        function canvasTabIndex(value: HTMLCanvasElement): number { return value.tabIndex; }
        if (canvasTabIndex(canvas) !== 0) throw new Error("native canvas focus contract");
        let selfCalls = "";
        function installSelf(value: number): void {
            const remove = (): void => {
                selfCalls += String(value);
                target.removeEventListener("click", remove);
            };
            target.addEventListener("click", remove);
            target.addEventListener("click", remove);
        }
        for (const value of [1, 2]) installSelf(value);
        target.click(); target.click();
        if (selfCalls !== "12") throw new Error("factory self-removal identity");
        let inlineCalls = "";
        function installInline(element: HTMLElement, value: number): void {
            element.addEventListener("click", () => { inlineCalls += String(value); }, {once: true});
        }
        for (const value of [1, 2]) installInline(target, value);
        target.click(); target.click();
        if (inlineCalls !== "12") throw new Error("inline factory evaluation identity");
        let namedInlineCalls = "";
        function installNamedInline(element: HTMLElement, value: number): void {
            element.addEventListener("click", function once(event: MouseEvent): void {
                if (event.target !== element || event.button !== 0)
                    throw new Error("named mouse callback payload");
                event.preventDefault();
                namedInlineCalls += String(value);
                element.removeEventListener("click", once);
            });
        }
        for (const value of [1, 2]) installNamedInline(target, value);
        target.click(); target.click();
        if (namedInlineCalls !== "12") throw new Error("named inline self-removal identity");
        let namedEventCalls = "";
        function installNamedEvent(element: HTMLElement, value: number): void {
            element.addEventListener("click", function record(event: Event): void {
                if (event.target !== element) throw new Error("named event callback payload");
                event.preventDefault();
                namedEventCalls += String(value);
            }, {once: true});
        }
        for (const value of [1, 2]) installNamedEvent(target, value);
        target.click(); target.click();
        if (namedEventCalls !== "12") throw new Error("named event callback identity");
        const visibility = document.createElement("div");
        visibility.id = "visibility-log";
        document.body.appendChild(visibility);
        let visibleCalls = "";
        function installVisibility(value: number): void {
            const change = (): void => {
                visibleCalls += String(value);
                visibility.textContent = visibleCalls;
                document.removeEventListener("visibilitychange", change);
            };
            document.addEventListener("visibilitychange", change);
            document.addEventListener("visibilitychange", change);
        }
        for (const value of [1, 2]) installVisibility(value);
        const fading = document.createElement("div");
        fading.id = "transition-log";
        document.body.appendChild(fading);
        let transitions = "";
        function installTransition(value: number): void {
            const hide = (event?: TransitionEvent): void => {
                if (event && (event.target !== fading || event.propertyName !== "opacity")) return;
                fading.removeEventListener("transitionend", hide);
                transitions += String(value);
                fading.textContent = transitions;
            };
            fading.addEventListener("transitionend", hide);
            fading.addEventListener("transitionend", hide);
            if (value === 3) setTimeout(() => hide(), 0);
        }
        for (const value of [1, 2, 3]) installTransition(value);
        let frames = "";
        function follow(read: () => number): () => void {
            let count = 0;
            let ticket = requestAnimationFrame(function step(): void {
                frames += String(read());
                if (++count < 2) ticket = requestAnimationFrame(step);
                if (frames.length === 4) {
                    if (frames !== "1212") throw new Error("named frame closure ownership");
                    log.textContent = "complete";
                    globalThis.close();
                }
            });
            return () => { cancelAnimationFrame(ticket); ticket = 0; };
        }
        const stops: Array<() => void> = [];
        for (const value of [1, 2, 3]) stops.push(follow(() => value));
        stops[2]!();
    `,
        {
            fileName: join(directory, "entry.ts"),
            nativeHostUi: {
                sourcePath: "test/dom-callback-factories.test.ts",
                elements: [{ tag: "div", attributes: { id: "prebuilt" } }],
            },
        },
    );
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    const scene = readFileSync("src/lowering/scene-lowerer.ts", "utf8");
    writeFileSync(
        join(directory, "visibility.hpp"),
        "namespace bbl {\n" +
            ["void on_visibility_change(", "void off_visibility_change("]
                .map((signature) => cppFunction(scene, signature))
                .join("\n") +
            "\n}",
    );
    runRmlUiFixture(t, "dom-callback-factories", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("named inline callbacks keep platform event borrows within dispatch", () => {
    for (const eventType of ["Event", "MouseEvent"]) {
        for (const body of [
            "setTimeout(() => event.preventDefault(), 0);",
            "saved = event;",
        ]) {
            assert.throws(
                () =>
                    compileSource(`
                        const element = document.createElement("button");
                        let saved: ${eventType} | null = null;
                        element.addEventListener("click", function handle(event: ${eventType}): void {
                            ${body}
                        });
                    `),
                /escaping callback cannot capture platform event|borrowed platform event cannot escape/,
            );
        }
    }
});
