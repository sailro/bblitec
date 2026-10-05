import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("Window beforeunload and pagehide preserve targets, flags, callback ordering and storage before cleanup", (t) => {
    const entry = resolve("test/fixtures/window-pagehide.ts");
    const source = readFileSync(entry, "utf8");
    const generated = compileSource(source, { fileName: entry });
    assert.ok(generated.manifest.features.includes("platform:window"));
    // A synchronous scene registers them on its own engine; its frame loop
    // dispatches them when the window closes.
    for (const type of ["pagehide", "beforeunload"]) {
        const scene = compileSource(
            `import { createEngine } from "@babylonjs/lite";
            async function main() {
                const engine = await createEngine({});
                window.addEventListener("${type}", () => {});
            }
            void main();`,
        );
        assert.ok(!scene.manifest.features.includes("platform:window"));
        assert.ok(
            scene.cpp.includes(
                `bbl::on_dom_pointer(v_engine, bbl::DomEventTarget::window(), "${type}"`,
            ),
        );
    }
    assert.throws(
        () =>
            compileSource(
                source.replaceAll(
                    'window.addEventListener("pagehide"',
                    'document.addEventListener("pagehide"',
                ),
                { fileName: entry },
            ),
        /dispatch at the Window/,
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/window-pagehide-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "program.hpp"), generated.cpp);
    const cpp = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(
        cpp,
        `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace bbl::pal {
            Engine document;
            std::string stored;
            Engine& window_document_engine() { return document; }
            const void* window_document_identity() { return &document; }
            void write_local_storage(const std::string& key, const std::string& value) {
                assert(key == "pagehide-result"); stored = value;
            }
            int run_window_application(WorkerEntry initialize, EngineOptions) {
                const js::RealmScope scope;
                EventLoop loop;
                WorkerRealm realm(loop);
                bool cleaned = false;
                loop.defer_cleanup([&] { cleaned = true; });
                loop.run([&] { initialize(realm); }, [&] {
                    assert(!cleaned);
                    const auto ordinary = dom_event(PlatformMouseEvent{}, "click", {DomEventTarget::window()});
                    document.dom_input->pointer.dispatch(ordinary, [&](auto& callback, const auto& payload) {
                        loop.dispatch_callback([&] { callback(payload); });
                    }, &document);
                    for (const auto& event : {window_beforeunload_event(), window_pagehide_event()})
                        assert(event.dom->path == std::vector<DomEventTarget>{DomEventTarget::window()});
                    dispatch_page_lifecycle(document, [&](auto& callback, const auto& payload) {
                        loop.dispatch_callback([&] { callback(payload); });
                    });
                });
                assert(cleaned);
                return 0;
            }
        }
        int main() {
            const auto ordinary = bbl::dom_event(bbl::PlatformMouseEvent{}, "click", {bbl::DomEventTarget::window()});
            assert(!bbl::dom_event_persisted(ordinary).has_value());
            const int result = generated_main();
            assert(result == 0);
            assert(bbl::pal::stored == "beforeunload;capture;target;microtask;");
            bbl::pal::document.dom_input.reset();
        }
    `,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        "/DBBLITE_HAS_UI=1",
        "/DBBLITE_HAS_DOM_INPUT=1",
        "/I",
        "native/include",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        cpp,
    ]);
    execFileSync(executable, { stdio: "pipe", timeout: 10000 });
});
