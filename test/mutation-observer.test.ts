import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/mutation-observer");
function compile(body: string) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    return compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const element = document.createElement("div");
        ${body}
    `,
        { fileName: join(directory, "entry.ts") },
    );
}

/**
 * Runs a program in the Window realm fixture, which requires every observer
 * disconnected when the realm ends.
 */
function runObserverFixture(t: TestContext, cpp: string): void {
    writeFileSync(join(directory, "program.hpp"), cpp);
    emitUpstreamGenerated(directory, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "mutation-observer", {
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
}

test("a reached observer selects the Window host before any engine or worker declaration", () => {
    const result = compileSource(
        `const observer = new MutationObserver(() => {}); const element = document.createElement("div"); observer.observe(element, {attributes:true}); observer.disconnect();`,
        { fileName: join(directory, "standalone.ts") },
    );
    assert.match(result.cpp, /run_window_application/);
    assert.match(result.cpp, /create_mutation_observer/);
});

test("Window attribute observers coalesce microtasks, filter targets, disconnect and preserve missing dataset values", (t) => {
    const result = compile(`
        const state = {count: 0, value: ""};
        const other = document.createElement("div");
        if ((element.dataset.progress ?? "missing") !== "missing") throw new Error("missing dataset");
        element.dataset.progress = "";
        if ((element.dataset.progress ?? "missing") !== "") throw new Error("empty dataset");
        element.removeAttribute("data-progress");
        if (element.dataset.progress !== undefined) throw new Error("removed dataset");
        const observer = new MutationObserver(() => {
            state.count++;
            state.value = element.dataset.progress ?? "missing";
        });
        // A subtree observer sees its descendants' class writes, a classList one included.
        function observeSubtree(): void {
            const parent = document.createElement("div");
            const child = document.createElement("span");
            parent.appendChild(child);
            const tree = {count: 0};
            const own = {count: 0};
            const deep = new MutationObserver(() => { tree.count++; });
            const shallow = new MutationObserver(() => { own.count++; });
            deep.observe(parent, {subtree: true, attributes: true, attributeFilter: ["class"]});
            shallow.observe(parent, {attributes: true, attributeFilter: ["class"], subtree: false});
            child.classList.add("open");
            setTimeout(() => {
                if (tree.count !== 1 || own.count !== 0) throw new Error("subtree class observation");
                child.classList.toggle("open");
                // Without a class attribute, removing an absent token changes nothing.
                parent.classList.remove("absent");
                setTimeout(() => {
                    if (tree.count !== 2 || own.count !== 0) throw new Error("token update steps");
                    parent.classList.add("x");
                    setTimeout(() => {
                        if (tree.count !== 3 || own.count !== 1) throw new Error("observed target");
                        deep.disconnect();
                        shallow.disconnect();
                        globalThis.close();
                    }, 0);
                }, 0);
            }, 0);
        }
        observer.observe(element, {attributeFilter:["data-progress"]});
        element.dataset.unrelated = "ignored";
        other.dataset.progress = "ignored";
        element.dataset.progress = "one";
        element.dataset.progress = "two";
        if (state.count !== 0) throw new Error("synchronous observer");
        setTimeout(() => {
            if (state.count !== 1 || state.value !== "two") throw new Error("coalesced observation");
            element.dataset.progress = "cancelled";
            observer.disconnect();
            setTimeout(() => {
                if (state.count !== 1) throw new Error("disconnect queued observation");
                observer.observe(element, {attributes:true, attributeFilter:[]});
                element.dataset.progress = "filtered";
                setTimeout(() => {
                    if (state.count !== 1) throw new Error("empty filter");
                    observer.observe(element, {attributes:true});
                    element.removeAttribute("data-progress");
                    setTimeout(() => {
                        if (state.count !== 2 || state.value !== "missing") throw new Error("reobserve and removal");
                        observer.disconnect();
                        observeSubtree();
                    }, 0);
                }, 0);
            }, 0);
        }, 0);
    `);
    runObserverFixture(t, result.cpp);
});

test("an auto-typed classic binding holds the observer assigned to it and calls it from a closure", (t) => {
    // `var observer = null` is `any` at its declaration and inside `hide`
    // (a page's classic script is JavaScript): the assignment types its
    // storage, and `hide` calls through it.
    mkdirSync(directory, { recursive: true });
    const result = compileSource(
        `
        var overlay = document.createElement("div");
        var status = document.createElement("div");
        var observer = null;
        function hide() {
            if (observer) {
                observer.disconnect();
                observer = null;
            }
            overlay.classList.add("is-hidden");
        }
        function check() {
            if (status.dataset.ready === "true") {
                hide();
                return true;
            }
            return false;
        }
        if (!check()) {
            observer = new MutationObserver(check);
            observer.observe(status, { attributes: true, attributeFilter: ["data-ready"] });
        }
        setTimeout(function () {
            status.dataset.ready = "true";
            setTimeout(function () {
                if (!overlay.classList.contains("is-hidden")) throw new Error("observer callback");
                globalThis.close();
            }, 0);
        }, 0);
    `,
        { fileName: join(directory, "classic.js") },
    );
    assert.match(
        result.cpp,
        /make_gc_shared<bbl::js::Nullable<std::shared_ptr<bbl::pal::MutationObserver>>>/,
    );
    assert.match(result.cpp, /\(\*\(\*v_\w*observer\)\)->disconnect\(\)/);
    // A declared nullable observer takes the same storage, and an optional
    // call disconnects it under the chain's presence test.
    const declared = compileSource(
        `const element = document.createElement("div");
            let observer: MutationObserver | null = null;
            function stop(): void { observer?.disconnect(); observer = null; }
            observer = new MutationObserver(stop);
            observer.observe(element, {attributes:true});
            setTimeout(stop, 0);`,
        { fileName: join(directory, "declared.ts") },
    ).cpp;
    assert.match(
        declared,
        /bbl::js::Nullable<std::shared_ptr<bbl::pal::MutationObserver>>/,
    );
    assert.match(declared, /\(\*v_bblite_optional_chain_\d+\)->disconnect\(\)/);
    runObserverFixture(t, result.cpp);
});

test("an observer callback its own var initializer creates reads that var assigned", (t) => {
    // The loader overlay's shape: `observer` is unassigned while its
    // initializer builds the callback, which the observer runs only later.
    mkdirSync(directory, { recursive: true });
    const result = compileSource(
        `
        var target = document.createElement("div");
        var observed = 0;
        var observer = new MutationObserver(function () {
            observed++;
            if (target.dataset.ready === "true") observer.disconnect();
        });
        observer.observe(target, { attributes: true, attributeFilter: ["data-ready"] });
        setTimeout(function () {
            target.dataset.ready = "true";
            setTimeout(function () {
                target.dataset.ready = "false";
                setTimeout(function () {
                    if (observed !== 1) throw new Error("the callback disconnected its own observer");
                    globalThis.close();
                }, 0);
            }, 0);
        }, 0);
    `,
        { fileName: join(directory, "own-initializer.js") },
    );
    assert.match(
        result.cpp,
        /make_gc_shared<std::shared_ptr<bbl::pal::MutationObserver>>/,
    );
    runObserverFixture(t, result.cpp);
});

test("Window attribute observers explicitly refuse records and old values", () => {
    for (const options of [
        "{childList:true}",
        "{attributes:true,attributeOldValue:true}",
        "{attributes:false}",
    ]) {
        assert.throws(
            () =>
                compile(
                    `const observer = new MutationObserver(() => {}); observer.observe(element, ${options});`,
                ),
            /MutationObserver/,
        );
    }
    assert.throws(() =>
        compile(
            "const observer = new MutationObserver((records) => { console.log(records.length); }); observer.observe(element, {attributes:true});",
        ),
    );
});

test("Window capture readiness activates only for reached canvas readiness writes", () => {
    const reached = compile(
        `const canvas = document.createElement("canvas"); setTimeout(() => { canvas.dataset.ready = "true"; }, 0);`,
    );
    assert.match(reached.cpp, /window_defer_capture_until_canvas_ready\(\)/);
    assert.equal(reached.manifest.canvasReadyGate, true);
    assert.ok(
        reached.cpp.indexOf("window_defer_capture_until_canvas_ready()") <
            reached.cpp.indexOf("ui_create_element("),
    );
    for (const body of [
        `element.dataset.ready = "true";`,
        `function unused(canvas: HTMLCanvasElement): void { canvas.dataset.ready = "true"; }`,
        `// startEngine(engine); canvas.dataset.ready = "true";`,
    ]) {
        const result = compile(body);
        assert.doesNotMatch(
            result.cpp,
            /window_defer_capture_until_canvas_ready/,
        );
        assert.equal(result.manifest.canvasReadyGate, undefined);
    }
});
