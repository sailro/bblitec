import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

for (const mode of ["window", "window-with-engine", "scene"] as const) {
    test(`stored DOM handles preserve their document owner in ${mode}`, t => {
        const window = mode !== "scene";
        const engine = mode !== "window";
        const directory = resolve(`artifacts/ui-stored-handles-${mode}`);
        mkdirSync(directory, {recursive:true});
        writeFileSync(join(directory, "worker.ts"), "self.close();");
        const result = compileSource(`
            ${engine ? 'import {createEngine} from "@babylonjs/lite";' : ""}
            ${window ? 'const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"}); worker.terminate();' : ""}
            ${window && engine ? "async function run(): Promise<void> {" : ""}
            ${engine ? `const engine = await createEngine(${window ? 'document.createElement("canvas")' : "{}"});` : ""}
            interface View { label: HTMLElement; optional: HTMLElement | null; }
            const label = document.createElement("div");
            const views = new Map<string, View>();
            views.set("main", {label, optional:label});
            function update(view: View): void {
                view.label.textContent = "record";
                if (view.optional) view.optional.textContent = "optional";
            }
            const view = views.get("main");
            if (view) update(view);
            const labels: HTMLElement[] = [label];
            function rename(element: HTMLElement): void { element.textContent = "array"; }
            rename(labels[0]!);
            ${window ? 'globalThis.close();' : ""}
            ${window && engine ? "} void run();" : ""}
        `, {fileName:join(directory, "entry.ts")});
        if (window) {
            const writes = result.cpp.split("\n").filter(line => line.includes("bbl::ui_set_text("));
            assert.equal(writes.length, 3);
            assert.ok(writes.every(line => line.includes("bbl::ui_set_text(bbl::pal::window_document_engine(),")));
        }
        // The CPU fixture exercises Window and scene ownership independently.
        // The combined case checks selection with a rendering engine in scope.
        if (window && engine) return;
        const tools = optionalNativeFixtureTools(false);
        if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
        writeFileSync(join(directory, "program.hpp"), result.cpp);
        const cpp = join(directory, "check.cpp"), executable = join(directory, "check.exe");
        writeFileSync(cpp, `
            #define main generated_main
            #include "program.hpp"
            #undef main
            #include <cassert>
            namespace bbl {
                Engine* document = nullptr;
                unsigned writes = 0;
                Engine create_engine(EngineOptions) { return {}; }
                UiElementHandle ui_create_element(Engine& owner, std::string_view tag) {
                    if (tag == "canvas") return UiElementHandle{1};
                    assert(tag == "div");
                    ${window ? "assert(&owner == &pal::window_document_engine());" : ""}
                    document = &owner;
                    return UiElementHandle{0};
                }
                void ui_set_text(Engine& owner, UiElementHandle element, std::string text) {
                    assert(&owner == document && element.value == 0);
                    const char* expected[] = {"record", "optional", "array"};
                    assert(writes < 3 && text == expected[writes]);
                    ++writes;
                }
            }
            ${window ? `namespace bbl::pal {
                Engine& window_document_engine() { static Engine host; return host; }
                int run_window_application(WorkerEntry initialize, EngineOptions) {
                    const js::RealmScope scope;
                    EventLoop loop;
                    WorkerRealm realm(loop);
                    loop.run([&] { initialize(realm); });
                    return 0;
                }
            }` : ""}
            int main() { const int result = generated_main(); assert(bbl::writes == 3); return result; }
        `);
        runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
            "/DBBLITE_HAS_UI=1", ...(window ? ["/DBBLITE_WORKERS=1", "/DBBLITE_OFFSCREEN_SURFACES=1"] : []),
            "/I", "native/include", `/Fo:${directory}/`, `/Fe:${executable}`, cpp]);
        assert.equal(execFileSync(executable, {encoding:"utf8", timeout:10000, stdio:"pipe"}), "");
    });
}
