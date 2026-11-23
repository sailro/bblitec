import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("Window beforeunload and pagehide preserve targets, flags, callback ordering and storage before cleanup", (t) => {
    const entry = resolve("test/fixtures/window-pagehide.ts");
    const source = readFileSync(entry, "utf8");
    const generated = compileSource(source, { fileName: entry });
    assert.ok(generated.manifest.features.includes("platform:window"));
    // localStorage links the durable store's unit, which the fixture below
    // replaces with an in-memory store of the same three operations.
    assert.ok(generated.manifest.features.includes("storage:local"));
    assert.ok(
        generated.manifest.runtimeSources.includes("src/pal_storage.cpp"),
    );
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
    runGeneratedProgram(
        tools,
        "window-pagehide-check",
        `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        #include <map>
        #include <semaphore>
        #include <bblite/pal_native_job.hpp>
        #include <bblite/pal_offscreen.hpp>
        namespace bbl::pal {
            Engine document;
            std::map<std::string, std::string> stored;
            Engine& window_document_engine() { return document; }
            const void* window_document_identity() { return &document; }
            std::optional<std::string> read_local_storage(const std::string& key) {
                const auto found = stored.find(key);
                return found == stored.end() ? std::nullopt : std::optional{found->second};
            }
            void write_local_storage(const std::string& key, const std::string& value) {
                stored.insert_or_assign(key, value);
            }
            void remove_local_storage(const std::string& key) { stored.erase(key); }
            OffscreenSurface surface(32,32);
            OffscreenDevice device;
            std::binary_semaphore job_started{0}, finish_job{0};
            std::atomic<bool> job_finished{false}, settled{false};
            std::weak_ptr<OffscreenImage> submitted;
            void child_with_pending_work(WorkerRealm& child) {
                child.loop().register_completion([](auto) {}, [] {finish_job.release();});
                OffscreenRun producer(surface,device);
                auto image = std::make_shared<OffscreenImage>();
                submitted = image;
                producer.publish(32,32,std::move(image));
                start_native_job([] {
                    job_started.release();
                    finish_job.acquire();
                    job_finished = true;
                    return 1;
                }, [](auto&) { settled = true; });
            }

            int run_window_application(WorkerEntry initialize, EngineOptions) {
                const js::RealmScope scope;
                EventLoop loop;
                std::optional<OffscreenFrame> in_flight;
                {
                    WorkerRealm realm(loop);
                    bool cleaned = false;
                    loop.defer_cleanup([&] { cleaned = true; });
                    loop.run([&] {
                        realm.create_worker(child_with_pending_work, "closing worker");
                        job_started.acquire();
                        in_flight = surface.take_frame();
                        assert(in_flight && in_flight->image && !job_finished);
                        initialize(realm);
                    }, [&] {
                        assert(!cleaned && !job_finished && !submitted.expired());
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
                    assert(cleaned && !job_finished);
                } // The realm terminates and joins its children after the closing turn.
                assert(job_finished && !settled && !submitted.expired());
                in_flight.reset();
                assert(submitted.expired());
                return 0;
            }
        }
        int main() {
            const auto ordinary = bbl::dom_event(bbl::PlatformMouseEvent{}, "click", {bbl::DomEventTarget::window()});
            assert(!bbl::dom_event_persisted(ordinary).has_value());
            const int result = generated_main();
            assert(result == 0);
            assert(bbl::pal::job_finished && !bbl::pal::settled && bbl::pal::submitted.expired());
            assert(bbl::pal::stored.size() == 1);
            assert(bbl::pal::stored.at("pagehide-result") == "beforeunload;capture;target;microtask;");
            bbl::pal::document.dom_input.reset();
        }
    `,
        {
            flags: [
                "/DBBLITE_WORKERS=1",
                "/DBBLITE_OFFSCREEN_SURFACES=1",
                "/DBBLITE_HAS_UI=1",
                "/DBBLITE_HAS_DOM_INPUT=1",
            ],
            timeoutMs: 10000,
        },
    );
});
