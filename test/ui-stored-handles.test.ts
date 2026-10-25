import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

for (const mode of ["window", "window-with-engine", "scene"] as const) {
    test(`stored DOM handles preserve their document owner in ${mode}`, (t) => {
        const window = mode !== "scene";
        const engine = mode !== "window";
        const directory = resolve(`artifacts/ui-stored-handles-${mode}`);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "worker.ts"), "self.close();");
        const result = compileSource(
            `
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
            ${window ? "globalThis.close();" : ""}
            ${window && engine ? "} void run();" : ""}
        `,
            { fileName: join(directory, "entry.ts") },
        );
        if (window) {
            const writes = result.cpp
                .split("\n")
                .filter((line) => line.includes("bbl::ui_set_text("));
            assert.equal(writes.length, 3);
            const paired = writes.filter((line) => line.includes(".second,"));
            assert.equal(paired.length, 2);
            assert.ok(paired.every((line) => line.includes(".first)")));
            const direct = writes.filter((line) => !paired.includes(line));
            assert.ok(
                direct.every((line) =>
                    line.includes(
                        "bbl::ui_set_text(bbl::pal::window_document_engine(),",
                    ),
                ),
            );
            // Both record fields store the document owner beside the handle,
            // including when a rendering engine is also in scope.
            assert.equal(
                [
                    ...result.cpp.matchAll(
                        /std::pair<bbl::StoredEngine, bbl::UiElementHandle>\{bbl::StoredEngine\{bbl::pal::window_document_engine\(\)\},/g,
                    ),
                ].length,
                2,
            );
        }
        // The CPU fixture exercises Window and scene ownership independently.
        // The combined case checks selection with a rendering engine in scope.
        if (window && engine) return;
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        writeFileSync(join(directory, "program.hpp"), result.cpp);
        const cpp = join(directory, "check.cpp"),
            executable = join(directory, "check.exe");
        writeFileSync(
            cpp,
            `
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
            ${
                window
                    ? `namespace bbl::pal {
                Engine& window_document_engine() { static Engine host; return host; }
                int run_window_application(WorkerEntry initialize, EngineOptions) {
                    const js::RealmScope scope;
                    EventLoop loop;
                    WorkerRealm realm(loop);
                    loop.run([&] { initialize(realm); });
                    return 0;
                }
            }`
                    : ""
            }
            int main() { const int result = generated_main(); assert(bbl::writes == 3); return result; }
        `,
        );
        runNativeFixtureCompiler(tools, [
            "/DBBLITE_HAS_UI=1",
            ...(window
                ? ["/DBBLITE_WORKERS=1", "/DBBLITE_OFFSCREEN_SURFACES=1"]
                : []),
            `/Fo:${directory}/`,
            `/Fe:${executable}`,
            cpp,
        ]);
        assert.equal(
            execFileSync(executable, {
                encoding: "utf8",
                timeout: 10000,
                stdio: "pipe",
            }),
            "",
        );
    });
}

test("a shared class stores its canvas and 2D context and registers a listener per instance", () => {
    const result = compileSource(`
        class Overlay {
            private readonly canvas: HTMLCanvasElement;
            private readonly ctx: CanvasRenderingContext2D;
            private constructor() {
                const canvas = document.createElement("canvas");
                document.body.appendChild(canvas);
                this.canvas = canvas;
                this.ctx = canvas.getContext("2d")!;
                this.resize();
                window.addEventListener("resize", () => this.resize());
            }
            static async create(): Promise<Overlay> {
                await Promise.resolve();
                return new Overlay();
            }
            resize(): void {
                this.canvas.width = window.innerWidth;
                const { ctx, canvas } = this;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.fillRect(0, 0, 1, 1);
            }
        }
        void (async () => {
            const overlay = await Overlay.create();
            overlay.resize();
            globalThis.close();
        })();
    `);
    const slot = (field: string): string =>
        `\\(\\*\\(\\w+->${field}\\)\\.first\\), \\(\\w+->${field}\\)\\.second`;
    assert.match(
        result.cpp,
        /->canvas = std::pair<bbl::StoredEngine, bbl::UiElementHandle>\{/,
    );
    assert.match(
        result.cpp,
        /->ctx = std::pair<bbl::StoredEngine, bbl::UiElementHandle>\{/,
    );
    assert.match(
        result.cpp,
        new RegExp(`bbl::ui_canvas_set_width\\(${slot("canvas")}, `),
    );
    assert.match(
        result.cpp,
        new RegExp(`bbl::ui_canvas_fill_rect\\(${slot("ctx")}, `),
    );
    assert.match(result.cpp, /bbl::ui_canvas_clear_rect\(/);
    assert.match(
        result.cpp,
        /bbl::on_dom_pointer\([^;]*"resize", bbl::js::next_callback_identity\(\)/,
    );
});

test("a 2D context maps to its canvas's handle wherever data stores it", () => {
    const result = compileSource(`
        class Overlay {
            private ctx: CanvasRenderingContext2D | null = null;
            private readonly canvas: HTMLCanvasElement;
            constructor() {
                const canvas = document.createElement("canvas");
                document.body.appendChild(canvas);
                this.canvas = canvas;
            }
            attach(): void {
                this.ctx = this.canvas.getContext("2d");
            }
            draw(): void {
                if (this.ctx) this.ctx.fillRect(0, 0, 1, 1);
            }
        }
        const overlay = new Overlay();
        overlay.attach();
        requestAnimationFrame(() => overlay.draw());
        const layers: { ctx: CanvasRenderingContext2D }[] = [];
        const extra = document.createElement("canvas");
        document.body.appendChild(extra);
        layers.push({ ctx: extra.getContext("2d")! });
        requestAnimationFrame(() => {
            for (const layer of layers) layer.ctx.fillRect(1, 1, 2, 2);
        });
    `);
    assert.match(
        result.cpp,
        /std::optional<std::pair<bbl::StoredEngine, bbl::UiElementHandle>>/,
    );
    assert.match(
        result.cpp,
        /std::pair<bbl::StoredEngine, bbl::UiElementHandle> ctx;/,
    );
    assert.match(
        result.cpp,
        /bbl::ui_canvas_fill_rect\([^;]*, 0\.0, 0\.0, 1\.0, 1\.0\)/,
    );
    assert.match(
        result.cpp,
        /bbl::ui_canvas_fill_rect\([^;]*->ctx[^;]*, 1\.0, 1\.0, 2\.0, 2\.0\)/,
    );
});

test("a const 2D context names its canvas, whatever its nullable annotation", () => {
    const result = compileSource(`
        const canvas = document.createElement("canvas");
        document.body.appendChild(canvas);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2D context");
        ctx.fillRect(0, 0, 1, 1);
    `);
    assert.match(result.cpp, /auto& v_ctx = v_canvas;/);
    assert.doesNotMatch(result.cpp, /no 2D context/);
    assert.match(result.cpp, /bbl::ui_canvas_fill_rect\([^;]*, v_ctx, /);
});
