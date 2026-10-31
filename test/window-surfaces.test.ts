import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("Window surfaces retain document ownership through disposal and recreation", (t) => {
    const output = resolve("artifacts/window-surfaces");
    emitUpstreamGenerated(output, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "window-surfaces", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_HAS_PBR_RENDERER: 0,
            BBLITE_HAS_SDL_GPU: 1,
            BBLITE_HAS_DAWN: 0,
        },
        includeDirectories: [join(output, "upstream/include")],
    });
});

test("an element whose tag only run time knows becomes a surface in the Window realm", () => {
    // The document decides the looked-up element's tag; the realm's
    // `attach_surface` checks it is a canvas (the fixture above).
    const source = (canvas: string) => `
        import { createEngine, createSurface, createSceneContext, registerScene } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
            const surface = createSurface(engine, ${canvas});
            await registerScene(createSceneContext(surface));
        }
        void main();
    `;
    const result = compileSource(
        source('document.getElementById("secondary") as HTMLCanvasElement'),
    );
    assert.match(result.cpp, /run_window_application/);
    assert.match(
        result.cpp,
        /auto v_\w*surface = bbl::create_surface\(\(\*v_\w+\), bbl::js::snapshot_value\(\(\*bbl::ui_find_element_by_id\(bbl::pal::window_document_engine\(\), "secondary"\)\)\)\);/,
    );
    assert.match(result.cpp, /bbl::create_scene_context\(v_\w*surface\)/);
    assert.ok(result.manifest.features.includes("renderer:surface"));
    // A created element's tag is known at generation.
    assert.throws(
        () =>
            compileSource(
                source(
                    'document.createElement("div") as unknown as HTMLCanvasElement',
                ),
            ),
        /Additional surfaces require retained canvas elements/,
    );
});

test("a surface program's primary scene keeps its direct pass", () => {
    // The renderer runs the surface scene's own graph after the primary
    // scene's direct pass (`scene_runs_own_graph`), so the primary scene
    // pays no default render task.
    const result = compileSource(`
        import { createEngine, createSurface, createSceneContext, registerScene } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
            await registerScene(createSceneContext(engine));
            const surface = createSurface(engine, document.getElementById("secondary") as HTMLCanvasElement);
            await registerScene(createSceneContext(surface));
        }
        void main();
    `);
    assert.match(
        result.cpp,
        /void bbl_register_scene\(bbl::Scene& scene\) \{\s+bbl::register_scene\(scene\);/,
    );
    assert.match(
        result.cpp,
        /bbl_ensure_default_render_task\((\w+)\);\s+bbl::register_scene\(\1\)/,
    );
});
