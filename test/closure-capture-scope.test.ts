import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test(
    "retained callbacks share a rebound non-null mesh handle",
    { skip: !tools },
    () => {
        const result = compileSource(`
        import { createEngine, createBox, startEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const engine = await createEngine({});
            let mesh = createBox(engine);
            setTimeout(() => { if (mesh.position.x !== 7) throw new Error("stale mesh capture"); }, 0);
            setTimeout(() => { mesh = createBox(engine); mesh.position.x = 7; }, 0);
            startEngine(engine);
        }
        void main();
    `);
        const output = resolve("artifacts/rebound-mesh-capture-check");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "program.hpp"), result.cpp);
        const source = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(
            source,
            `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace { std::vector<std::function<void()>> callbacks; }
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            MeshHandle create_box(Engine& engine, BoxOptions) {
                engine.meshes.emplace_back();
                return {static_cast<std::uint32_t>(engine.meshes.size() - 1)};
            }
            void defer_callback(Engine&, std::function<void()> callback) {
                callbacks.push_back(std::move(callback));
            }
            void mark_mesh_dirty(Engine&, MeshHandle) {}
            void start_engine(Engine& engine) {
                assert(callbacks.size() == 2);
                callbacks[1]();
                callbacks[0]();
                callbacks.clear();
                assert(engine.meshes.size() == 2);
            }
        }
        int main() {
            return generated_main();
        }
    `,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/MD",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            source,
        ]);
        execFileSync(executable, { encoding: "utf8" });
    },
);

test(
    "platform locals remain visible through shared and retained closures",
    { skip: !tools },
    () => {
        const result = compileSource(`
        import { createEngine, startEngine } from "@babylonjs/lite";
        function hidden(): boolean { return document.hidden; }
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const button = document.createElement("button");
            const snapshot = button.getBoundingClientRect();
            button.addEventListener("pointermove", event => {
                function offset(): number { return event.clientX - snapshot.left; }
                button.textContent = String(offset() / snapshot.width);
            });
            document.addEventListener("visibilitychange", () => {
                button.textContent = String(hidden());
            });
            document.addEventListener("visibilitychange", () => {
                button.hidden = hidden();
            });
            document.body.appendChild(button);
            startEngine(engine);
        }
        void main();
    `);
        const rect = /const auto (\w+) = bbl::ui_get_client_rect\(/.exec(
            result.cpp,
        )?.[1];
        assert.ok(rect);
        assert.equal(result.cpp.match(/bbl::ui_get_client_rect\(/g)?.length, 1);
        // A bounding rectangle's extent is the border box.
        for (const field of ["left", "top", "offset_width", "offset_height"])
            assert.match(result.cpp, new RegExp(`= ${rect}\\.${field};`));
        runGeneratedProgram(
            tools!,
            "platform-local-capture-check",
            `
        #define main generated_main
        ${result.cpp}
        #undef main
        #include <cassert>
        namespace {
            bbl::UiClientRect rectangle{10, 20, 80, 40, 100, 50};
            int rectangle_reads = 0;
            std::string button_text;
            bool hidden = false;
        }
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            UiElementHandle ui_create_element(Engine&, std::string_view tag) {
                assert(tag == "button");
                return {0};
            }
            UiClientRect ui_get_client_rect(Engine&, UiElementHandle) {
                ++rectangle_reads;
                return rectangle;
            }
            void ui_set_text(Engine&, UiElementHandle element, std::string value) {
                assert(element.value == 0);
                button_text = std::move(value);
            }
            void ui_set_boolean_attribute(Engine&, UiElementHandle element,
                                          std::string name, bool present) {
                assert(element.value == 0 && name == "hidden");
                hidden = present;
            }
            UiElementHandle ui_append_to_root(Engine&, UiElementHandle element) {
                return element;
            }
            void on_visibility_change(Engine& engine, std::size_t identity,
                                      js::Callback<void(bool)> callback, bool once) {
                engine.visibility_change_callbacks.add(identity, std::move(callback), once);
            }
            void start_engine(Engine& engine) {
                assert(rectangle_reads == 1);
                rectangle = {100, 200, 180, 140, 200, 150};
                PlatformMouseEvent pointer;
                pointer.client_x = 60;
                dispatch_dom_pointer(engine, dom_event(pointer, "pointermove",
                                     {DomEventTarget::node(0)}));
                assert(button_text == "0.5");
                engine.document_hidden = true;
                engine.visibility_change_callbacks.dispatch(true);
                assert(button_text == "true" && hidden);
                engine.document_hidden = false;
                engine.visibility_change_callbacks.dispatch(false);
                assert(button_text == "false" && !hidden);
                assert(rectangle_reads == 1);
            }
        }
        int main() { return generated_main(); }
        `,
            { defines: ["BBLITE_HAS_UI=1"], timeoutMs: 10000 },
        );
    },
);

test(
    "stored closures retain copied nullable handles and their presence storage",
    { skip: !tools },
    () => {
        const result = compileSource(`
        import { createEngine, createBox } from "@babylonjs/lite";
        import type { Mesh } from "@babylonjs/lite";
        async function main(canvas: HTMLCanvasElement): Promise<void> {
            const engine = await createEngine(canvas);
            const callbacks = new Set<() => void>();
            let second: HTMLCanvasElement | null = null;
            if (Math.random() > 0.5) {
                second = document.createElement("canvas");
                const copied = second;
                callbacks.add(() => copied.remove());
            }
            let mesh: Mesh | null = null;
            if (Math.random() > 0.5) mesh = createBox(engine);
            const copiedMesh = mesh;
            callbacks.add(() => { if (copiedMesh) copiedMesh.position.x += 1; });
            for (const callback of callbacks) callback();
        }
        main(document.createElement("canvas"));
    `);
        assert.ok(
            (result.cpp.match(/bbl::js::make_closure\(/g)?.length ?? 0) >= 2,
        );
        const output = resolve("artifacts/closure-capture-scope-check");
        mkdirSync(output, { recursive: true });
        const source = join(output, "check.cpp");
        writeFileSync(source, result.cpp);
        // Compile the generated closures themselves; text assertions cannot prove
        // that all native identifiers resolve inside an explicit environment.
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/c",
            "/DBBLITE_HAS_UI=1",
            `/Fo:${output}\\`,
            "/I",
            "native/include",
            source,
        ]);
    },
);

test(
    "frame timers retain local cells and rebind shared storage buffers",
    { skip: !tools },
    () => {
        const result = compileSource(`
        import {
            createEngine, createStorageBuffer, updateStorageBuffer,
            disposeStorageBuffer, startEngine, type EngineContext, type StorageBuffer,
        } from "@babylonjs/lite";
        function makePalette(engine: EngineContext): { grow(need: number): void; flush(): void } {
            let slots = 4;
            let data = new Float32Array(slots * 4);
            data[0] = 5;
            let buffer: StorageBuffer = createStorageBuffer(engine, data, "palette");
            const ensure = (need: number): void => {
                if (need <= slots) return;
                const grown = new Float32Array(need * 4);
                grown.set(data);
                const retired = buffer;
                data = grown;
                slots = need;
                buffer = createStorageBuffer(engine, data, "palette");
                disposeStorageBuffer(retired);
            };
            return {
                grow(need: number): void { ensure(need); },
                flush(): void { data[0] += 4; updateStorageBuffer(engine, buffer, data); },
            };
        }
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const palette = makePalette(engine);
            requestAnimationFrame((timestamp) => {
                let frameLocal = timestamp;
                const scratch = timestamp * 2;
                setTimeout(() => { frameLocal++; palette.grow(8); palette.flush(); }, 0);
                setInterval(() => {
                    if (frameLocal !== 7 || scratch !== 12) throw new Error("frame capture");
                }, 30);
            });
            await startEngine(engine);
        }
        void main();
    `);
        const output = resolve("artifacts/frame-storage-capture-check");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "program.hpp"), result.cpp);
        const source = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        // Only the engine and scheduling seam is replaced. Generated closures
        // and native buffer allocation, mutation and disposal execute unchanged.
        writeFileSync(
            source,
            `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace { std::vector<std::function<void()>> timers; }
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            void defer_callback(Engine&, std::function<void()> callback) {
                timers.push_back(std::move(callback));
            }
            double set_interval(Engine&, std::function<void()> callback, double period) {
                assert(period == 30);
                timers.push_back(std::move(callback));
                return static_cast<double>(timers.size());
            }
            void start_engine(Engine& engine) {
                auto frames = std::move(engine.animation_frame_once_callbacks);
                assert(frames.size() == 1);
                frames[0](6);
                frames.clear();
                assert(timers.size() == 2);
                timers[0]();
                timers[1]();
                timers[1]();
                timers.clear();
                assert(engine.storage_buffers.size() == 2);
                const auto& retired = engine.storage_buffers[0];
                const auto& current = engine.storage_buffers[1];
                assert(retired.disposed && retired.bytes.empty());
                assert(!current.disposed && current.bytes.size() == 128);
                float first = 0;
                std::memcpy(&first, current.bytes.data(), sizeof(first));
                assert(first == 9);
            }
        }
        int main() { return generated_main(); }
    `,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/MD",
            `/Fo:${output}/`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            source,
        ]);
        execFileSync(executable, { encoding: "utf8", timeout: 10000 });
    },
);
