import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
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
                        globalThis.close();
                    }, 0);
                }, 0);
            }, 0);
        }, 0);
    `);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
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
});

test("Window attribute observers explicitly refuse records, subtree and old values", () => {
    for (const options of [
        "{childList:true}",
        "{attributes:true,subtree:true}",
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
    assert.ok(
        reached.cpp.indexOf("window_defer_capture_until_canvas_ready()") <
            reached.cpp.indexOf("ui_create_element("),
    );
    for (const body of [
        `element.dataset.ready = "true";`,
        `function unused(canvas: HTMLCanvasElement): void { canvas.dataset.ready = "true"; }`,
    ])
        assert.doesNotMatch(
            compile(body).cpp,
            /window_defer_capture_until_canvas_ready/,
        );
});
