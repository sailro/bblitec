import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("realm rendering survives an empty scene interval and stops during that wait", () => {
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "The native fixture compiler is required.");
    const frames = readFileSync("native/src/pal_gpu_frame.cpp", "utf8");
    const driver = readFileSync("native/src/pal_sdl.cpp", "utf8");
    runGeneratedProgram(
        tools,
        "realm-scene-restart",
        `
        #include <bblite/pal_frame_driver.hpp>
        #include <bblite/js_realm_state.hpp>
        #include <cassert>
        namespace bbl::pal {
            // GPU construction is isolated; the real frame scheduler and restart logic run.
            struct GpuBackend {};
            const GpuBackend& selected_gpu_backend() { static const GpuBackend backend; return backend; }
            ${cppFunction(frames, "bool registered_scene_set_changed(")}
            ${cppFunction(frames, "bool request_renderer_restart_if_scene_set_changed(")}
        }
        namespace bbl {
            enum class RendererKind { scene, frame_graph };
            RendererKind renderer_kind(const Engine&) { return RendererKind::scene; }
            [[noreturn]] void refuse_uncompiled_renderer(RendererKind, const pal::GpuBackend&) {
                throw std::runtime_error("unexpected missing renderer");
            }
            enum class Change { replacement, stop, dispose };
            Change change;
            int activations = 0, rendered = 0;
            bool timer_ran = false;
            pal::SceneRun fixture_renderer(Engine& engine) {
                assert(!engine.scenes().empty());
                const auto planned = engine.scenes();
                ++activations;
                ++rendered;
                co_yield true;
                if (activations == 1) {
                    // A before-render callback disposes the final scene, then awaits loading.
                    engine.rendering_contexts.clear();
                    assert(pal::request_renderer_restart_if_scene_set_changed(engine, planned));
                    assert(engine.renderer_restart_requested);
                    pal::EventLoop::current().set_timeout([&engine] {
                        timer_ran = true;
                        if (change == Change::replacement)
                            engine.rendering_contexts.push_back("scene", std::make_shared<Scene>());
                        else if (change == Change::stop)
                            engine.stopped = true;
                        else
                            engine.device_disposed = true;
                    }, 10);
                } else {
                    ++rendered;
                    co_yield true;
                }
                co_return true;
            }
            pal::SceneRun run_renderer(Engine& engine, RendererKind, const pal::GpuBackend&) {
                return fixture_renderer(engine);
            }
            ${cppFunction(driver, "void deliver_realm_frame_failure(")}
            ${cppFunction(driver, "js::Promise<js::PromiseVoid> run_realm_frames(")}
        }
        int main() {
            using namespace bbl;
            // Standalone scene removal still ends its driver.
            Engine standalone;
            standalone.rendering_contexts.push_back("scene", std::make_shared<Scene>());
            const auto planned = standalone.scenes();
            standalone.rendering_contexts.clear();
            assert(pal::request_renderer_restart_if_scene_set_changed(standalone, planned));
            assert(!standalone.renderer_restart_requested);
            for (const auto mutation : {Change::replacement, Change::stop, Change::dispose}) {
                const js::RealmScope realm;
                pal::EventLoop loop;
                auto frames = std::make_shared<pal::AnimationFrameSource>();
                pal::OffscreenSurface surface(32, 32, frames);
                pal::OffscreenDevice device;
                auto engine = std::make_shared<Engine>();
                engine->offscreen_run = std::make_shared<pal::OffscreenRun>(surface, device);
                engine->rendering_contexts.push_back("scene", std::make_shared<Scene>());
                change = mutation;
                activations = rendered = 0;
                timer_ran = false;
                int ready_count = 0;
                bool finished = false;
                loop.run([&] {
                    js::Promise<js::PromiseVoid> ready;
                    const auto rethrow = [](std::exception_ptr error) { std::rethrow_exception(error); };
                    ready.observe([&](const js::PromiseVoid&) { ++ready_count; }, rethrow);
                    run_realm_frames(engine, ready).observe([&](const js::PromiseVoid&) {
                        finished = true;
                        loop.close();
                    }, rethrow);
                    loop.set_timeout([frames] { frames->tick(pal::EventLoop::Clock::now()); }, 1, true);
                    loop.set_timeout([] { throw std::runtime_error("scene replacement timed out"); }, 1000);
                });
                assert(finished && timer_ran && ready_count == 1);
                assert(activations == (mutation == Change::replacement ? 2 : 1));
                assert(rendered == (mutation == Change::replacement ? 3 : 1));
            }
        }
        `,
        {
            flags: [
                "/DBBLITE_WORKERS=1",
                "/DBBLITE_OFFSCREEN_SURFACES=1",
                "/DBBLITE_DEVICE_RECOVERY=0",
            ],
            expectedOutput: "",
            timeoutMs: 10000,
        },
    );
});
