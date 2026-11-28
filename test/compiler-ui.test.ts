import { cppFunction } from "./native-fixture.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { CompileError, compileSource, surveySource } from "../src/compiler.js";
import { hostUiOptions } from "./host-page-fixture.js";
import { pinnedAssetUrl } from "./compiler-fixtures.js";

const palUiRmlSource = readFileSync(
    resolve("native/src/pal_ui_rml.cpp"),
    "utf8",
);

function compileUiScene(body: string) {
    return compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            ${body}
        }
        void main();
    `);
}

test("owns retained Map.get records while immediate field reads borrow", () => {
    const result = compileSource(`
        interface Item {
            value: number;
        }
        const items = new Map<string, Item>();
        const original: Item = { value: 7 };
        items.set("item", original);
        const saved = items.get("item");
        const immediate = items.get("item")?.value;
        items.delete("item");
        if (!saved || saved !== original || immediate !== 7) {
            throw new Error("Map.get ownership");
        }
    `);

    assert.match(
        result.cpp,
        /bblscene::Item v_saved = v_items\.get_owned\("item"\);/,
    );
    assert.match(
        result.cpp,
        /const bblscene::Item& (v_bblite_optional_chain_\d+) = v_items\.get\("item"\);[\s\S]*\1->value/,
    );
});

test("does not fold mutable reference-record fields into retained callbacks", () => {
    const result = compileSource(`
        interface View { x: number }
        interface Reader { read: () => number }
        const view: View = { x: 0 };
        const views: View[] = [view];
        const count = views.length;
        const reader: Reader = {
            read: () => view.x,
        };
        function recenter(): void {
            view.x = 4;
        }
        recenter();
        const current = reader.read();
    `);

    assert.match(
        result.cpp,
        /stored_callback\{\d+u, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{v_view\}, bblscene::\w+/,
    );
    assert.match(result.cpp, /return v_view->x;/);
    assert.doesNotMatch(result.cpp, /return 0\.0;/);
});

test("shares mutable bindings across retained event callbacks", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        interface Controller { read: () => boolean }
        async function main() {
            await createEngine({});
            let active = true;
            const button = document.createElement("button");
            const stop = (): void => { active = false; };
            button.addEventListener("click", () => {
                active = !active;
            });
            window.addEventListener("pointerdown", stop);
            const controller: Controller = {
                read: () => active,
            };
            controller.read();
        }
    `);

    const storage = result.cpp.match(
        /auto (v_active) = bbl::js::make_gc_shared<bool>\(true\);/,
    );
    assert.ok(storage);
    assert.equal(
        (result.cpp.match(new RegExp(`\\(\\*${storage[1]}\\)`, "g")) ?? [])
            .length >= 3,
        true,
    );
});

test("shares auto-rotate state across UI, pointer, and frame callbacks", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        await createEngine({});
        const canvas =
            document.getElementById("renderCanvas") as HTMLCanvasElement;
        const button = document.createElement("button");
        let autoRotate = true;
        let turns = 0;
        button.addEventListener("click", () => {
            autoRotate = !autoRotate;
        });
        canvas.addEventListener("pointerdown", () => {
            autoRotate = false;
        });
        requestAnimationFrame(() => {
            if (autoRotate) turns += 1;
        });
    `);

    const storage = result.cpp.match(
        /auto (v_autoRotate) = bbl::js::make_gc_shared<bool>\(true\);/,
    );
    assert.ok(storage);
    assert.match(
        result.cpp,
        new RegExp(`\\(\\*${storage[1]}\\) = !\\(\\(\\*${storage[1]}\\)\\)`),
    );
    assert.match(result.cpp, new RegExp(`\\(\\*${storage[1]}\\) = false`));
    assert.match(result.cpp, new RegExp(`if \\(\\(\\*${storage[1]}\\)\\)`));
});

test("shares a let assigned by a callback a helper invokes from its click listener", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        function bindToggle(id: string, initial: boolean, update: (enabled: boolean) => void): void {
            const button = document.getElementById(id) as HTMLButtonElement;
            let enabled = initial;
            const refresh = (): void => {
                button.textContent = enabled ? "On" : "Off";
                update(enabled);
            };
            button.addEventListener("click", () => {
                enabled = !enabled;
                refresh();
            });
            refresh();
        }
        await createEngine({});
        let autoOrbit = false;
        let turns = 0;
        requestAnimationFrame(() => {
            if (autoOrbit) turns += 1;
        });
        bindToggle("toggleOrbit", false, (enabled) => {
            autoOrbit = enabled;
        });
    `);

    // The frame callback and the inlined click listener must dereference
    // one cell: a by-value copy in the listener would leave the frame
    // callback reading the initial value forever.
    const storage = result.cpp.match(
        /auto (v_autoOrbit) = bbl::js::make_gc_shared<bool>\(false\);/,
    );
    assert.ok(storage);
    assert.match(
        result.cpp,
        new RegExp(`\\(\\*${storage[1]}\\) = v_fn\\d+_enabled;`),
    );
    assert.match(result.cpp, new RegExp(`if \\(\\(\\*${storage[1]}\\)\\)`));
    assert.doesNotMatch(result.cpp, /std::ref\(v_autoOrbit\)/);
});

test("shares pointer press coordinates with the release callback", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        await createEngine({});
        const canvas =
            document.getElementById("renderCanvas") as HTMLCanvasElement;
        let downX = 0;
        let downY = 0;
        let clicks = 0;
        canvas.addEventListener("pointerdown", (event) => {
            downX = event.clientX;
            downY = event.clientY;
        });
        canvas.addEventListener("pointerup", (event) => {
            if (Math.hypot(
                event.clientX - downX,
                event.clientY - downY,
            ) < 6) {
                clicks += 1;
            }
        });
    `);

    const downX = result.cpp.match(
        /auto (v_downX) = bbl::js::make_gc_shared<double>\(0\.0\);/,
    );
    const downY = result.cpp.match(
        /auto (v_downY) = bbl::js::make_gc_shared<double>\(0\.0\);/,
    );
    assert.ok(downX);
    assert.ok(downY);
    assert.match(result.cpp, new RegExp(`client_x - \\(\\*${downX[1]}\\)`));
    assert.match(result.cpp, new RegExp(`client_y - \\(\\*${downY[1]}\\)`));
});

test("keeps listener-producing class methods on the per-instance inliner", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        class Controls {
            private locked = false;
            bind(canvas: HTMLCanvasElement): void {
                canvas.addEventListener("click", () => {
                    this.locked = true;
                });
            }
        }
        async function main() {
            await createEngine({});
            const canvas =
                document.getElementById("renderCanvas") as HTMLCanvasElement;
            const controls = new Controls();
            controls.bind(canvas);
        }
    `);

    assert.match(result.cpp, /bbl::on_dom_pointer\([^\n]*"click"/);
    assert.doesNotMatch(result.cpp, /void Controls_bind\(/);
});

test("shares callbacks assigned after UI handlers are retained", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        await createEngine({});
        const button = document.createElement("button");
        let action: (() => void) | null = null;
        button.addEventListener("click", () => {
            action?.();
        });
        let count = 0;
        action = () => {
            count += 1;
        };
    `);

    const storage = result.cpp.match(
        /auto (v_action) = bbl::js::make_gc_shared<bbl::js::Callback<void\(\)>>/,
    );
    assert.ok(storage);
    assert.match(
        result.cpp,
        new RegExp(
            `const auto (\\w+) = bbl::js::snapshot_callback\\(\\(\\*${storage[1]}\\)\\);\\s*if \\(!\\1\\) return;\\s*\\1\\(\\);`,
        ),
    );
    assert.match(result.cpp, new RegExp(`\\(\\*${storage[1]}\\) = `));
});

test("a loop that starts async activations and registers async listeners stays one native loop", () => {
    // An await suspends the function it stands in: those in a callee or a
    // listener the body registers belong to other activations.
    const result = compileSource(`
        const log: string[] = [];
        async function settle(name: string): Promise<void> { await Promise.resolve(); log.push(name); }
        const list = document.createElement("div");
        document.body.appendChild(list);
        function fill(): void {
            for (const name of ["a", "b", "c"]) {
                const item = document.createElement("span");
                item.textContent = name;
                list.appendChild(item);
                item.addEventListener("click", async () => { await settle(name); });
                void settle(name);
            }
        }
        window.addEventListener("keydown", () => fill());
    `);
    assert.equal(result.cpp.match(/ui_create_element\(.*"span"\)/g)?.length, 1);
    assert.match(
        result.cpp,
        /for \(std::size_t (\w+) = 0; \1 < \w+\.size\(\); \+\+\1\) \{\s*\[\[maybe_unused\]\] auto \w+ = bbl::js::snapshot_value/,
    );
});

test("shares mutable state between retained callbacks and returned disposers", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSceneContext,
            onBeforeRender,
        } from "@babylonjs/lite";

        function install(scene: ReturnType<typeof createSceneContext>): () => void {
            let disposed = false;
            onBeforeRender(scene, () => {
                if (disposed) return;
            });
            return () => {
                disposed = true;
            };
        }

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const stop = install(scene);
            window.addEventListener("click", stop);
        }
    `);

    const disposed = result.cpp.match(
        /auto (v_\w*disposed) = bbl::js::make_gc_shared<bool>\(false\);/,
    )?.[1];
    assert.ok(disposed);
    assert.match(
        result.cpp,
        new RegExp(
            `= bbl::js::make_closure\\(bblscene::bbl_environment_\\w+\\{${disposed}\\}, bblscene::\\w+`,
        ),
    );
    assert.match(result.cpp, new RegExp(`\\(\\*${disposed}\\) = true;`));
});

test("owns readonly arrays retained by class fields after construction", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSceneContext,
            onBeforeRender,
        } from "@babylonjs/lite";

        interface Ship { value: number }

        class CameraRig {
            private readonly ships: readonly Ship[];

            constructor(ships: readonly Ship[]) {
                this.ships = ships;
            }

            update(): number {
                const anchor = this.ships[1] ?? this.ships[0]!;
                return anchor.value;
            }
        }

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const source: Ship[] = [{ value: 1 }, { value: 2 }];
            const rig = new CameraRig(source.map((ship) => ship));
            let observed = 0;
            onBeforeRender(scene, () => {
                observed = rig.update();
            });
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /bbl::js::Array<bblscene::Ship> v_bblite_class_field_ships_\d+\{\};/,
    );
    assert.doesNotMatch(
        result.cpp,
        /bbl::js::Span<const bblscene::Ship> v_bblite_class_field_ships_\d+/,
    );
});

test("compiles the cascaded shadow generator's own factory and options", () => {
    const result = compileSource(`
        import {
            addToScene,
            createCsmDirectionalShadowGenerator,
            createDirectionalLight,
            createEngine,
            createSceneContext,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const light = createDirectionalLight([-1, -2, -1], 1);
            addToScene(scene, light);
            createCsmDirectionalShadowGenerator(engine, light, {
                mapSize: 2048,
                numCascades: 4,
                lambda: 0.6,
                bias: 0.00008,
                darkness: 0.2,
            });
        }

        void main();
    `);

    assert.ok(result.manifest.features.includes("shadow:csm"));
    assert.ok(!result.manifest.features.includes("shadow:pcf-directional"));
    assert.match(result.cpp, /create_csm_directional_shadow_generator/);
    assert.match(result.cpp, /CsmDirectionalShadowOptions\{/);
    // The cascade array is the pin's own now, so nothing about it is an
    // adaptation: what a scene reaches instead of building is refused.
    assert.deepStrictEqual(
        result.manifest.adaptations.filter(({ id }) => id.includes("csm")),
        [],
    );
});

test("iterates runtime data arrays through a retained owner and live index", () => {
    const result = compileSource(`
        function values(): number[] {
            return [Math.random(), 2, 3];
        }
        let total = 0;
        for (const value of values()) {
            total += value;
        }
    `);

    assert.match(result.cpp, /const auto& \w+ = bblscene::values\(\);/);
    assert.match(result.cpp, /for \(std::size_t/);
    assert.match(result.cpp, /v_total \+= v_bblite_item_\d+;/);
});

test("snapshots scalar members of records retained by classes", () => {
    const result = compileSource(`
        import { createBox, createEngine, type Mesh } from "@babylonjs/lite";

        interface Vehicle { body: Mesh; element: HTMLElement; bodyRestY: number }
        function makeVehicle(body: Mesh): Vehicle {
            return {
                body,
                element: document.createElement("div"),
                bodyRestY: body.position.y,
            };
        }
        class Controller {
            private readonly vehicle: Vehicle;
            constructor(vehicle: Vehicle) { this.vehicle = vehicle; }
            value(): number { return this.vehicle.bodyRestY; }
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const body = createBox(engine, 1);
            const vehicle = makeVehicle(body);
            const controller = new Controller(vehicle);
            body.position.y = 10;
            body.position.y = controller.value();
        }
        main();
    `);
    // The shared factory stores the scalar in the record it returns; the
    // method reads that field rather than the live mesh position.
    assert.match(
        result.cpp,
        /VehicleData\{std::pair<bbl::StoredEngine, bbl::MeshHandle>\{bbl::StoredEngine\{(\w+)\}, (\w+)\}, std::pair<bbl::StoredEngine, bbl::UiElementHandle>\{bbl::StoredEngine\{\1\}, \w+\}, bbl::handle_at\(\1\.meshes, \2\)\.position\.y\}/,
    );
    const stored =
        /bblscene::Vehicle (v_bblite_class_field_vehicle_\d+)\{\};/.exec(
            result.cpp,
        );
    assert.ok(stored);
    // The argument binds first; the field is assigned from it once stored.
    const argument = /auto& (\w+) = v_vehicle;/.exec(result.cpp);
    assert.ok(argument);
    const initialized = `${stored[1]} = ${argument[1]};`;
    assert.ok(result.cpp.indexOf(initialized) > result.cpp.indexOf(stored[0]));
    assert.ok(result.cpp.includes(`return ${stored[1]}->bodyRestY;`));
    const mutation = result.cpp.indexOf(".position.y = 10.0;");
    assert.ok(mutation > result.cpp.indexOf(initialized));
    assert.match(result.cpp, /double bodyRestY\{\};/);
});

test("folds the browser canvas guard around a void-wrapped auto-run", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function scene(canvas: HTMLCanvasElement) {
            const engine = await createEngine(canvas);
            createBox(engine);
        }

        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        if (canvas) {
            void scene(canvas);
        }
    `);

    assert.match(result.cpp, /bbl::create_box/);
    assert.doesNotMatch(result.cpp, /document|getElementById/);

    const missing = compileSource(`
                if (document.getElementById("definitelyMissing")) {
                    console.log("unreachable");
                }
            `);
    assert.match(missing.cpp, /ui_find_element_by_id[^\n]+"definitelyMissing"/);
    assert.ok(missing.manifest.features.includes("platform:window"));

    assert.doesNotThrow(() => compileSource(`void 1;`));
});

test("retains optional DOM-local writes beside adjacent native state", () => {
    const result = compileSource(`
        let enabled = false;
        const button = document.getElementById("toggle") as HTMLButtonElement | null;
        function setEnabled(on: boolean): void {
            enabled = on;
            if (button) {
                button.textContent = on ? "enabled" : "disabled";
                button.setAttribute("aria-pressed", String(on));
            }
        }
        setEnabled(true);
    `);

    assert.match(result.cpp, /v_enabled = true;/);
    assert.match(result.cpp, /ui_set_attribute[^\n]+"aria-pressed"/);
    assert.match(result.cpp, /ui_set_text/);
    assert.match(result.cpp, /\.has_value\(\)/);
});

test("lowers a tag.class sheet selector beside its tag-descendant base rule", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                ".controls button { color: #f5f7ff; } button.disabled { color: #929bb2; }";
            document.head.appendChild(style);
            const controls = document.createElement("div");
            controls.className = "controls";
            const button = document.createElement("button");
            controls.appendChild(button);
            document.body.appendChild(controls);
            button.classList.toggle("disabled", true);
        }

        void main();
    `);

    // The tag/class compound carries the class-plus-tag specificity of the
    // base rule, so the later disabled rule wins by source order as in the
    // browser cascade.
    assert.match(
        result.cpp,
        /UiStyleSelectorKind::ClassDescendantTag, \.primary = "controls", \.tag = "button", \.style = "[^"]*"[,}]/,
    );
    assert.match(
        result.cpp,
        /UiStyleSelectorKind::TagClass, \.primary = "disabled", \.tag = "button", \.style = "[^"]*"[,}]/,
    );
    assert.match(result.cpp, /ui_(?:set|toggle)_class[^\n]*"disabled", true/);
});

test("accepts a tag.class rule from the host page's sheet", () => {
    const result = compileSource(
        `
            import { createEngine, startEngine } from "@babylonjs/lite";

            async function main(): Promise<void> {
                const engine = await createEngine({});
                const button = document.getElementById("toggle") as HTMLButtonElement;
                button.classList.toggle("disabled", true);
                await startEngine(engine);
            }

            void main();
        `,
        hostUiOptions({
            styleSheets: [
                { text: "button.disabled { color: #929bb2; }", line: 1 },
            ],
            elements: [
                {
                    tag: "button",
                    attributes: { id: "toggle" },
                },
            ],
        }),
    );

    assert.match(
        result.cpp,
        /ui_add_style_rule[^\n]*UiStyleSelectorKind::TagClass[^\n]*"disabled"[^\n]*"button"[^\n]*"color:#929bb2;?"/,
    );
});

test("retains event callbacks owned by an optional DOM local", () => {
    const result = compileSource(`
        let enabled = true;
        const button = document.getElementById("toggle") as HTMLButtonElement | null;
        if (button) {
            button.addEventListener("click", () => {
                enabled = !enabled;
                button.textContent = enabled ? "enabled" : "disabled";
            });
        }
        if (enabled) {
            const reached = 1;
        }
    `);

    assert.match(
        result.cpp,
        /auto v_enabled = bbl::js::make_gc_shared<bool>\(true\);/,
    );
    assert.match(result.cpp, /on_dom_pointer[^\n]+"click"/);
    assert.match(result.cpp, /ui_set_text/);
    assert.match(result.cpp, /\.has_value\(\)/);
});

test("narrows an assigned nullable retained-UI class field", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        class Palette {
            private root: HTMLElement | null = null;
            build(): void {
                this.root = document.createElement("div");
                document.body.appendChild(this.root);
            }
            cleanup(): void { this.root?.remove(); }
        }
        await createEngine({});
        const palette = new Palette();
        palette.build();
        palette.cleanup();
    `);

    assert.match(result.cpp, /ui_append_to_root/);
    assert.match(
        result.cpp,
        /if \(\(\*(v_bblite_class_field_root_\d+)\)\.has_value\(\)\) \{\s*\[\[maybe_unused\]\] const auto (\w+) = bbl::js::snapshot_value\(\(\*\(\*\1\)\)\);\s*bbl::ui_remove\(\(\*\(\2\)\.first\), \(\2\)\.second\);/,
    );
    assert.match(
        result.cpp,
        /\(\*v_bblite_class_field_root_\d+\) = bbl::js::Nullable<std::pair<bbl::StoredEngine, bbl::UiElementHandle>>\{std::pair<bbl::StoredEngine, bbl::UiElementHandle>\{bbl::StoredEngine\{(\w+)\}, bbl::ui_create_element\(\1, "div"\)\}\}\.to_optional\(\);/,
    );
    assert.equal(
        (result.cpp.match(/bbl::ui_create_element\(/g) ?? []).length,
        1,
    );
});

test("retains stylesheet tags assigned through nullable class fields", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        class Palette {
            private style: HTMLStyleElement | null = null;
            build(): void {
                this.style = document.createElement("style");
                this.style.textContent =
                    ".palette { position: fixed; bottom: 70px; }";
                document.head.appendChild(this.style);
            }
        }
        await createEngine({});
        const palette = new Palette();
        palette.build();
    `);

    assert.match(
        result.cpp,
        /ui_add_class_style\([^;]*"palette"[^;]*"position:absolute;bottom:70px;"/,
    );
});

test("lowers scene-created DOM controls to the retained native UI IR", () => {
    const result = compileSource(`
        import { createEngine, startEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            let enabled = false;
            const button = document.createElement("button");
            button.textContent = "Feature: OFF";
            button.setAttribute(
                "style",
                "position:absolute;bottom:12px;left:calc(50% - 60px);",
            );
            button.addEventListener("click", () => {
                enabled = !enabled;
                button.textContent = "Feature: " + (enabled ? "ON" : "OFF");
            });
            document.body.appendChild(button);
            await startEngine(engine);
        }

        void main();
    `);

    assert.ok(result.manifest.features.includes("ui:rml"));
    assert.ok(result.manifest.runtimeSources.includes("src/pal_ui_rml.cpp"));
    assert.match(result.cpp, /#include <bblite\/pal_ui\.hpp>/);
    assert.match(result.cpp, /bbl::ui_create_element/);
    assert.match(result.cpp, /bbl::ui_set_text/);
    assert.match(result.cpp, /bbl::ui_set_attribute/);
    assert.match(result.cpp, /left:50%;margin-left:-60px;/);
    assert.doesNotMatch(result.cpp, /calc\(/);
    assert.match(result.cpp, /bbl::on_dom_pointer\([^\n]*"click"/);
    assert.match(result.cpp, /bbl::ui_append_to_root/);
    assert.doesNotMatch(result.cpp, /document|createElement|textContent/);
});

test("UI text reads the string a record type declares where a shared layout may hold it absent", () => {
    // `{ x, y }` records coalesced with a city share the city layout, whose
    // `name` storage they leave empty; a city's own name is still a string.
    const result = compileSource(`
        interface City { x: number; y: number; size: number; name: string }
        const cities: City[] = [{ x: 1, y: 2, size: 5, name: String(Date.now()) }];
        const tiles: { x: number; y: number }[] = [{ x: 3, y: 4 }];
        const visited = new Set<{ x: number; y: number }>();
        const start = cities[1] ?? tiles[0]!;
        visited.add(start);
        const label = document.createElement("span");
        label.textContent = cities[0]!.name;
        document.body.appendChild(label);
    `);
    assert.match(result.cpp, /bbl::ui_set_text\([^;]*\(\*[^;]*->name\)\)/);
});

test("lowers retained UI properties, append, removal, and dynamic attributes", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const panel = document.createElement("div");
            panel.className = "hud";
            panel.style.cssText = "position:fixed;left:calc(50% - 20px);font:600 13px system-ui,sans-serif;backdrop-filter:blur(3px);";
            const button = document.createElement("button");
            button.id = "go";
            button.type = "button";
            button.innerText = "GO";
            panel.append(button);
            document.body.appendChild(panel);
            let active = false;
            button.addEventListener("click", () => {
                active = !active;
                button.style.background = active ? "#fff" : "#000";
                button.setAttribute("aria-pressed", active ? "true" : "false");
                panel.remove();
            });
        }

        void main();
    `);

    assert.match(result.cpp, /ui_set_attribute/);
    assert.match(result.cpp, /position:absolute/);
    assert.match(result.cpp, /left:50%;margin-left:-20px;/);
    assert.match(
        result.cpp,
        /font-weight:600;font-size:13px;font-family:system-ui/,
    );
    assert.match(result.cpp, /backdrop-filter:blur\(/);
    assert.doesNotMatch(result.cpp, /sans-serif,sans-serif/);
    assert.match(result.cpp, /ui_set_style_property/);
    assert.match(result.cpp, /ui_append_child/);
    assert.match(result.cpp, /ui_remove/);
});

test("folds a static CSS fragment array joined into retained UI cssText", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const panel = document.createElement("div");
            panel.style.cssText = [
                "position:fixed",
                "top:16px",
                "background:rgba(10,12,20,0.75)",
            ].join(";");
            document.body.appendChild(panel);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /position:absolute;top:16px;background-clip:border-box;[^"]*background-color:rgba\(10,12,20,0\.75\)/,
    );
});

test("preserves retained UI animations and lowers responsive font shorthands", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const title = document.createElement("div");
            title.style.cssText =
                "font:900 clamp(40px,9vw,82px) system-ui,sans-serif;" +
                "animation:bob 3s ease-in-out infinite;";
            document.body.appendChild(title);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /font-weight:900;font-size:82px;font-family:system-ui/,
    );
    assert.match(result.cpp, /animation:bob 3s ease-in-out infinite/);
    assert.doesNotMatch(result.cpp, /clamp\(/);
});

test("preserves native grid tracks and absolute shrink-to-fit blocks", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const panel = document.createElement("div");
            panel.style.cssText =
                "position:absolute;right:16px;min-width:180px";
            const grid = document.createElement("div");
            grid.style.cssText =
                "display:grid;grid-template-columns:repeat(4,18px);" +
                "grid-template-rows:repeat(4,18px);gap:2px";
            panel.appendChild(grid);
            for (let index = 0; index < 16; index++) {
                const cell = document.createElement("div");
                cell.style.cssText = "width:18px;height:18px";
                grid.appendChild(cell);
            }
            for (const label of ["LONG INLINE CONTROL", "SECOND CONTROL"]) {
                const button = document.createElement("button");
                button.textContent = label;
                button.style.width = "100%";
                panel.appendChild(button);
            }
            document.body.appendChild(panel);
        }

        void main();
    `);

    assert.match(result.cpp, /min-width:180px/);
    assert.doesNotMatch(result.cpp, /min-width:180px;?width:180px/);
    assert.match(result.cpp, /--bbl-intrinsic-min-width:180px/);
    assert.doesNotMatch(result.cpp, /232\.5/);
    assert.match(result.cpp, /display:grid/);
    assert.match(result.cpp, /grid-template-rows:repeat\(/i);
    assert.doesNotMatch(result.cpp, /--bbl-(?:fr-)?grid/);
    assert.match(result.cpp, /grid-template-columns/i);
});

test("centres direct text in fixed-height retained flex controls", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const button = document.createElement("div");
            button.textContent = "A";
            button.style.cssText =
                "display:flex;align-items:center;justify-content:center;" +
                "width:64px;height:64px;font:700 26px system-ui,sans-serif;";
            document.body.appendChild(button);
            const badge = document.createElement("span");
            badge.textContent = "1";
            badge.style.cssText =
                "display:inline-flex;align-items:center;justify-content:center;" +
                "height:14px;font-size:10px;";
            document.body.appendChild(badge);
        }

        void main();
    `);

    assert.match(result.cpp, /line-height:64px;text-align:center/);
    assert.match(result.cpp, /display:inline-block/);
    assert.match(result.cpp, /line-height:14px;text-align:center/);
});

test("normalizes uppercase retained canvas tags", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const canvas = document.createElement("CANVAS");
            canvas.width = 32;
            canvas.height = 16;
            const context = canvas.getContext("2d")!;
            context.clearRect(0, 0, canvas.width, canvas.height);
            document.body.appendChild(canvas);
        }
        void main();
    `);

    assert.match(result.cpp, /ui_create_element\([^\n]*"canvas"\)/);
    assert.doesNotMatch(result.cpp, /ui_create_element\([^\n]*"CANVAS"\)/);
    assert.match(result.cpp, /ui_canvas_clear/);

    const host = compileSource(
        `
            import { createEngine } from "@babylonjs/lite";
            async function main(): Promise<void> {
                await createEngine({});
            }
            void main();
        `,
        hostUiOptions(
            { elements: [{ tag: "CANVAS" }] },
            { path: "uppercase.html" },
        ),
    );
    assert.match(host.cpp, /ui_create_element\([^\n]*"canvas"\)/);
    assert.doesNotMatch(host.cpp, /ui_create_element\([^\n]*"CANVAS"\)/);
});

test("resolves flex text wrappers through specificity, inline, and hover cascade", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                ".shell div:hover { display:flex; }" +
                "#label { display:block; }" +
                ".label { display:flex; }";
            document.head.appendChild(style);
            const shell = document.createElement("section");
            shell.className = "shell";
            const label = document.createElement("div");
            label.id = "label";
            label.className = "label";
            label.style.cssText = "display:block";
            label.textContent = "status";
            shell.appendChild(label);
            document.body.appendChild(shell);
        }
        void main();
    `);
    assert.match(result.cpp, /UiStyleSelectorKind::ClassDescendantTag/);
    assert.match(result.cpp, /ui_add_id_style[^\n]*display:block/);
    assert.match(result.cpp, /ui_add_class_style[^\n]*display:flex/);

    const projection = palUiRmlSource;
    const resolver = projection.slice(
        projection.indexOf("std::string resolved_style_attribute"),
        projection.indexOf("void append_text_content"),
    );
    assert.match(resolver, /ui_style_rule_specificity\(rule\)/);
    // Text wrapping follows the display RmlUi computes, re-projected when it moves.
    const wrapper = cppFunction(projection, "bool text_needs_flex_wrapper(");
    assert.doesNotMatch(wrapper, /for_each_active_style_rule/);
    assert.match(wrapper, /element\.GetComputedValues\(\)\.display\(\)/);
    assert.match(
        cppFunction(projection, "bool sync_text_wrappers("),
        /update_element\(UiElementHandle\{index\}\)/,
    );
});

test("stores retained UI elements in explicitly typed DOM arrays", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const cells: HTMLDivElement[] = [];
            for (let index = 0; index < 2; index++) {
                const cell = document.createElement("div");
                cells.push(cell);
                document.body.appendChild(cell);
            }
            for (const cell of cells) {
                cell.style.background = "#fff";
            }
        }

        void main();
    `);

    assert.match(result.cpp, /bbl::js::Array<bbl::UiElementHandle>/);
    const inserted = [
        ...result.cpp.matchAll(/\.push_back\((v_\w*cell)\)/g),
    ].map((match) => match[1]);
    assert.equal(new Set(inserted).size, 2);
    assert.match(result.cpp, /ui_set_style_property/);
});

test("carries document.body through an inlined retained UI mount helper", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        function mount(root: HTMLElement): void {
            const panel = document.createElement("div");
            panel.textContent = "mounted";
            const footer = document.createElement("div");
            root.append(panel, footer);
        }

        async function main(): Promise<void> {
            await createEngine({});
            mount(document.body);
        }

        void main();
    `);

    for (const element of ["panel", "footer"]) {
        const argument = result.cpp.match(
            new RegExp(`ui_append_child\\([^,]+, [^,]+, (v_\\w+${element})\\)`),
        )?.[1];
        assert.ok(argument, "the immutable mount argument is retained");
        const declaration = result.cpp.indexOf(` ${argument} =`);
        assert.ok(
            declaration >= 0 &&
                declaration < result.cpp.indexOf("ui_append_child("),
            "the source handle is initialized before insertion",
        );
    }
});

test("carries document.body through a retained UI class constructor", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        class Hud {
            constructor(parent: HTMLElement) {
                const panel = document.createElement("div");
                panel.textContent = "mounted";
                parent.appendChild(panel);
            }
        }

        async function main(): Promise<void> {
            await createEngine({});
            const hud = new Hud(document.body);
        }

        void main();
    `);

    assert.match(result.cpp, /ui_append_child\([^,]+, [^,]+, v_[^)]+panel\)/);
});

test("lowers static retained UI innerHTML to RmlUi markup", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const help = document.createElement("div");
            help.innerHTML = [
                "<div style='font-weight:600;box-shadow:0 0 2px #000'>CONTROLS</div>",
                "<div>← / → &nbsp; move</div>",
            ].join("");
            document.body.appendChild(help);
        }

        void main();
    `);

    assert.match(result.cpp, /ui_set_inner_rml/);
    assert.match(result.cpp, /CONTROLS/);
    assert.match(result.cpp, /display:block/);
    assert.doesNotMatch(result.cpp, /innerHTML/);
    assert.match(result.cpp, /box-shadow:0 0 2px #000/);
});

test("lowers dynamic retained UI innerHTML substitutions", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const stats = document.createElement("div");
            window.addEventListener("keydown", (event) => {
                stats.innerHTML = \`<span>KEY \${event.code || "?"}</span>\`;
            });
            window.addEventListener("pointermove", (event) => {
                stats.innerHTML =
                    \`<span style="color:#ff6b6b">X \${Math.round(event.clientX)}</span>\` +
                    \`<span>Y \${event.clientY}</span>\`;
            });
            document.body.appendChild(stats);
        }

        void main();
    `);

    assert.match(result.cpp, /ui_set_inner_rml/);
    assert.match(result.cpp, /number_to_string/);
    assert.match(result.cpp, /ui_escape_rml/);
    assert.match(result.cpp, /color:#ff6b6b/);
    assert.match(result.cpp, /\.empty\(\)/);
    assert.doesNotMatch(result.cpp, /__BBLITE_UI_MARKUP_/);
});

test("evaluates a retained UI substitution's || right operand only when taken", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        let reads = 0;
        function pickLabel(): string { reads++; return reads > 1 ? "k" : ""; }
        function fallbackLabel(): string { reads += 10; return "?"; }
        async function main(): Promise<void> {
            await createEngine({});
            const stats = document.createElement("div");
            window.addEventListener("keydown", () => {
                stats.innerHTML = \`<span>KEY \${pickLabel() || fallbackLabel()}</span>\`;
            });
            document.body.appendChild(stats);
        }
        void main();
    `);
    // The fallback's effect sits under the left operand's falsy test.
    assert.match(
        result.cpp,
        /if \([^\n]*empty\(\)[^\n]*\) \{\n\s*\(\*v_reads\) \+= 10\.0;/,
    );
    assert.equal(result.cpp.match(/\(\*v_reads\) \+= 10\.0;/g)?.length, 1);
});

test("folds static string concatenation assigned to retained UI text", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent = "@keyframes a{}" + "@keyframes b{}";
            document.head.appendChild(style);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /ui_set_text\([^;]+"@keyframes a\{\}@keyframes b\{\}"\)/,
    );
    assert.doesNotMatch(result.cpp, /"@keyframes a\{\}" \+ "@keyframes b\{\}"/);
});

test("imports simple retained stylesheet id and class rules", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent = \`
                #labels { position: fixed; inset: 0; }
                #labels .label { display: flex; background: rgba(1,2,3,.5); }
                @keyframes pulse { 0%, 49% { opacity: 1; } 50%, 100% { opacity: .05; } }
            \`;
            document.head.appendChild(style);
            const labels = document.createElement("div");
            labels.id = "labels";
            const label = document.createElement("div");
            label.className = "label";
            labels.appendChild(label);
            document.body.appendChild(labels);
        }

        void main();
    `);

    assert.match(result.cpp, /ui_add_id_style[^\n]*"labels"/);
    assert.match(result.cpp, /position:absolute/);
    assert.match(result.cpp, /UiStyleSelectorKind::IdDescendantClass/);
    assert.match(result.cpp, /\.primary = "labels", \.secondary = "label"/);
    assert.match(result.cpp, /background-color:\s*rgba\(1,2,3,.5\)/);
    // The @keyframes block is not a rule: it rides ui_set_text and the PAL
    // projects it from there, so its percentage blocks emit no rules and
    // trip no selector refusal.
    assert.doesNotMatch(result.cpp, /ui_add_class_style[^\n]*"pulse"/);
    assert.match(result.cpp, /ui_set_text[^\n]*@keyframes pulse/);
    // The reviewed descendant form remains scoped in the typed rule IR.
    assert.ok(
        result.manifest.adaptations.some(
            (adaptation) =>
                adaptation.id === "substituted-ui-runtime" &&
                adaptation.nativeSemantics.includes("'#labels .label'") &&
                adaptation.nativeSemantics.includes("remain scoped"),
        ),
    );
});

test("orders retained UI stylesheets by live root attachment order", () => {
    const projection = palUiRmlSource;
    const activeSheets = projection.slice(
        projection.indexOf("void for_each_active_style_element"),
        projection.indexOf("void sync_style_sheet"),
    );
    assert.match(activeSheets, /engine\.ui_root_children/);
    assert.doesNotMatch(
        activeSheets,
        /for \(const UiElementRecord& record : engine\.ui_elements\)/,
    );

    const appendRoot = projection.slice(
        projection.indexOf("UiElementHandle ui_append_to_root"),
        projection.indexOf("void ui_replace_children"),
    );
    assert.match(appendRoot, /ui_root_children\.push_back\(child\)/);
    const remove = projection.slice(
        projection.indexOf("void ui_remove"),
        projection.indexOf("void ui_on_click"),
    );
    assert.match(remove, /ui_root_children\.erase/);
    assert.match(
        appendRoot,
        /std::find_if[\s\S]*ui_root_children\.erase\(existing\)[\s\S]*ui_root_children\.push_back\(child\)/,
    );
});

test("attaches grid styles in reattached stylesheet order", () => {
    const result = compileUiScene(`
            const first = document.createElement("style");
            document.head.appendChild(first);
            const last = document.createElement("style");
            last.textContent = ".cell { width:24px; height:24px; }";
            first.textContent =
                ".grid { display:grid;grid-template-columns:repeat(2,24px); }" +
                ".cell { width:20px; height:24px; }";
            document.head.appendChild(last);
            document.head.appendChild(first);
            document.head.appendChild(last);

            const grid = document.createElement("div");
            grid.className = "grid";
            const cell = document.createElement("button");
            cell.className = "cell";
            grid.appendChild(cell);
            document.body.appendChild(grid);
    `);

    assert.equal(
        [
            ...result.cpp.matchAll(
                /ui_append_child\([^;]+UiDocumentPart::Head[^;]+v_(?:first|last)\)/g,
            ),
        ].length,
        4,
    );
    assert.match(result.cpp, /grid-template-columns/i);
});

test("retains dynamically ordered grid stylesheet attachments", () => {
    assert.doesNotThrow(() =>
        compileUiScene(`
                    const style = document.createElement("style");
                    style.textContent =
                        ".grid { display:grid;grid-template-columns:repeat(2,24px); }" +
                        ".cell { width:24px;height:24px; }";
                    const grid = document.createElement("div");
                    grid.className = "grid";
                    const cell = document.createElement("button");
                    cell.className = "cell";
                    grid.appendChild(cell);
                    document.body.appendChild(grid);
                    grid.addEventListener("click", () => {
                        document.head.appendChild(style);
                    });
            `),
    );
    assert.doesNotThrow(() =>
        compileUiScene(`
                    const style = document.createElement("style");
                    style.textContent =
                        ".grid { display:grid;grid-template-columns:repeat(2,24px); }" +
                        ".cell { width:24px;height:24px; }";
                    document.head.appendChild(style);
                    const grid = document.createElement("div");
                    grid.className = "grid";
                    const cell = document.createElement("button");
                    cell.className = "cell";
                    grid.appendChild(cell);
                    grid.addEventListener("click", () => {
                        style.textContent = ".grid { display:block; }";
                    });
                    document.body.appendChild(grid);
            `),
    );
});

test("refuses stylesheet selectors outside the reviewed surface by name", () => {
    const sheet = (rules: string): string => `
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent = \`${rules}\`;
            document.head.appendChild(style);
        }

        void main();
    `;

    assert.throws(
        () =>
            compileSource(
                sheet(".pill:has(.icon:has(.detail)) { color: red; }"),
            ),
        /Retained stylesheet selector '\.pill:has\(\.icon:has\(\.detail\)\)' is not lowered/,
    );
    for (const selector of ["div p", ".a > .b"])
        assert.match(
            compileSource(sheet(`${selector} { color: red; }`)).cpp,
            /UiStyleSelectorKind::Sequence/,
        );
});

test("keeps scoped and direct class rules distinct in cascade order", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent = \`
                #a .badge { color: red; }
                .badge { color: blue; }
            \`;
            document.head.appendChild(style);
            const root = document.createElement("div");
            root.id = "a";
            const badge = document.createElement("span");
            badge.className = "badge";
            root.appendChild(badge);
            document.body.appendChild(root);
        }

        void main();
    `);

    assert.match(result.cpp, /UiStyleSelectorKind::IdDescendantClass/);
    assert.match(result.cpp, /ui_add_class_style[^\n]*"badge"/);
    assert.doesNotMatch(result.cpp, /global class rule/);
});

test("retains grid declarations and CSS specificity", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent = \`
                #palette {
                    display:grid;
                    grid-template-columns:repeat(2,24px);
                    gap:2px;
                }
                .palette {
                    display:grid;
                    grid-template-columns:repeat(3,24px);
                    gap:2px;
                }
                .swatch { width:24px; height:24px; }
            \`;
            document.head.appendChild(style);
            const palette = document.createElement("div");
            palette.id = "palette";
            palette.className = "palette";
            for (let index = 0; index < 6; index++) {
                const swatch = document.createElement("button");
                swatch.className = "swatch";
                palette.appendChild(swatch);
            }
            document.body.appendChild(palette);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /ui_add_id_style[^\n]*grid-template-columns:repeat\(2,24px\)/i,
    );
    assert.match(
        result.cpp,
        /ui_add_class_style[^\n]*grid-template-columns:repeat\(3,24px\)/i,
    );
    const projection = palUiRmlSource;
    const resolver = projection.slice(
        projection.indexOf("std::string resolved_style_attribute"),
        projection.indexOf("bool text_needs_flex_wrapper"),
    );
    assert.match(resolver, /ui_style_rule_specificity\(rule\)/);
    assert.match(resolver, /std::stable_sort/);
    assert.match(
        projection,
        /case UiStyleSelectorKind::IdDescendantClass:[\s\S]{0,120}\+\+ids;[\s\S]{0,80}\+\+classes;/,
    );
});

test("resolves fixed-grid activation and alignment through the complete cascade", () => {
    for (const reset of ["block", "flex", "none"]) {
        const resetResult = compileSource(`
            import { createEngine } from "@babylonjs/lite";
            async function main(): Promise<void> {
                await createEngine({});
                const style = document.createElement("style");
                style.textContent =
                    ".grid { display:grid;grid-template-columns:repeat(2,24px); }" +
                    ".cell { width:20px;height:20px; }" +
                    "#palette { display:${reset}; }";
                document.head.appendChild(style);
                const grid = document.createElement("div");
                grid.id = "palette";
                grid.className = "grid";
                const cell = document.createElement("button");
                cell.className = "cell";
                grid.appendChild(cell);
                document.body.appendChild(grid);
            }
            void main();
        `);
        assert.doesNotMatch(
            resetResult.manifest.adaptations.find(
                ({ id }) => id === "substituted-ui-runtime",
            )?.nativeSemantics ?? "",
            /repeat\(2, 24px\)/,
        );
    }

    const aligned = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                ".grid {" +
                "display:grid;grid-template-columns:repeat(2,24px);" +
                "justify-content:start;" +
                "}" +
                ".cell { width:24px;height:24px; }" +
                "#palette { justify-content:end; }";
            document.head.appendChild(style);
            const grid = document.createElement("div");
            grid.id = "palette";
            grid.className = "grid";
            const cell = document.createElement("button");
            cell.className = "cell";
            grid.appendChild(cell);
            document.body.appendChild(grid);
        }
        void main();
    `);
    assert.match(aligned.cpp, /ui_add_id_style[^\n]*justify-content:end/);

    // The grid's display is RmlUi's cascade, which text wrapping reads.
    assert.match(
        cppFunction(palUiRmlSource, "bool text_needs_flex_wrapper("),
        /Rml::Style::Display::Grid/,
    );

    const inheritedAlignment = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                "#palette {" +
                "display:grid;grid-template-columns:repeat(2,24px);" +
                "}" +
                ".grid { justify-content:end; }" +
                ".cell { width:24px;height:24px; }";
            document.head.appendChild(style);
            const grid = document.createElement("div");
            grid.id = "palette";
            grid.className = "grid";
            const cell = document.createElement("button");
            cell.className = "cell";
            grid.appendChild(cell);
            document.body.appendChild(grid);
        }
        void main();
    `);
    assert.doesNotMatch(
        inheritedAlignment.cpp,
        /--bbl-grid-justify-(?:content|authored)/,
    );
    assert.match(
        inheritedAlignment.cpp,
        /ui_add_class_style[^\n]*justify-content:end/,
    );
});

test("retains class-tag descendants and hover without leaking to unrelated tags", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent = \`
                .panel button { color: #ddd; }
                .panel button:hover { background: rgba(80,80,80,.75); }
            \`;
            document.head.appendChild(style);
            const panel = document.createElement("div");
            panel.className = "panel";
            const inside = document.createElement("button");
            panel.appendChild(inside);
            document.body.appendChild(panel);
            const outside = document.createElement("button");
            document.body.appendChild(outside);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /UiStyleSelectorKind::ClassDescendantTag, \.primary = "panel", \.tag = "button", \.style = "[^"]*"}/,
    );
    assert.match(
        result.cpp,
        /UiStyleSelectorKind::ClassDescendantTag, \.primary = "panel", \.tag = "button", \.style = "[^"]*", \.hover = true}/,
    );
    assert.doesNotMatch(result.cpp, /ui_add_class_style[^\n]*"button"/);
    assert.match(
        result.manifest.adaptations.find(
            ({ id }) => id === "substituted-ui-runtime",
        )?.nativeSemantics ?? "",
        /RmlUi evaluates reached input state/,
    );
});

test("retains className and cssText grid replacement states", () => {
    const source = (childSetup: string): string => `
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            let alternate = false;
            const style = document.createElement("style");
            style.textContent =
                ".grid { display:grid;grid-template-columns:repeat(1,24px); }" +
                ".a.b { width:24px;height:24px; }" +
                ".cell { width:24px;height:24px; }" +
                ".cell.active { color:red; }";
            document.head.appendChild(style);
            const grid = document.createElement("div");
            grid.className = "grid";
            const cell = document.createElement("button");
            ${childSetup}
            grid.appendChild(cell);
            document.body.appendChild(grid);
        }
        void main();
    `;

    assert.doesNotThrow(() =>
        compileSource(source(`cell.className = alternate ? "a" : "b";`)),
    );
    assert.doesNotThrow(() =>
        compileSource(
            source(`
                    cell.style.cssText = "width:24px;height:24px";
                    cell.style.cssText = "color:red";
                `),
        ),
    );
    assert.doesNotThrow(() =>
        compileSource(
            source(`
                    cell.style.cssText = alternate
                        ? "width:24px;height:24px"
                        : "color:red";
                `),
        ),
    );
    assert.doesNotThrow(() =>
        compileSource(
            source(`cell.className = "cell" + (alternate ? " active" : "");`),
        ),
    );
    assert.doesNotThrow(() =>
        compileSource(
            source(`
                cell.style.width = "20px";
                cell.style.cssText = "width:24px;height:24px";
            `),
        ),
    );
});

test("lowers compound classes and add remove forced-toggle mutations", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                ".tool.active { border-color: #08c; }";
            document.head.appendChild(style);
            const button = document.createElement("button");
            button.className = "tool";
            const buttons = new Map<string, HTMLButtonElement>();
            buttons.set("tool", button);
            buttons.get("tool")?.classList.add("active");
            buttons.get("tool")?.classList.remove("active");
            button.classList.toggle("active", true);
            document.body.appendChild(button);
        }

        void main();
    `);

    assert.match(result.cpp, /UiStyleSelectorKind::CompoundClass/);
    assert.match(result.cpp, /\.primary = "tool", \.secondary = "active"/);
    assert.equal(
        [...result.cpp.matchAll(/ui_(?:set|toggle)_class/g)].length,
        3,
    );
    assert.match(result.cpp, /"active", true/);
    assert.match(result.cpp, /"active", false/);
    const mapGets = [
        ...result.cpp.matchAll(
            /const auto (v_bblite_map_get_\d+) = [^;]+\.get\([^;]+\);/g,
        ),
    ];
    assert.equal(mapGets.length, 2);
    for (const [, temporary] of mapGets) {
        assert.match(
            result.cpp,
            new RegExp(
                `if \\(${temporary}\\.has_value\\(\\)\\) \\{\\s+` +
                    `\\[\\[maybe_unused\\]\\] auto (\\w+) = ${temporary}\\.value_or\\(bbl::UiElementHandle\\{\\}\\);\\s+` +
                    `bbl::ui_(?:set|toggle)_class\\([^,\\n]+, \\1, "active", (?:true|false)\\);\\s+\\}`,
            ),
        );
    }
});

test("preserves Map UI identity across dynamic grid geometry changes", () => {
    assert.doesNotThrow(() =>
        compileSource(`
                import { createEngine } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    await createEngine({});
                    const style = document.createElement("style");
                    style.textContent =
                        ".grid { display:grid;grid-template-columns:repeat(2,24px); }" +
                        ".cell { width:24px;height:24px; }" +
                        ".cell.compact { width:20px; }";
                    document.head.appendChild(style);
                    const grid = document.createElement("div");
                    grid.className = "grid";
                    const cell = document.createElement("button");
                    cell.className = "cell";
                    grid.appendChild(cell);
                    const cells = new Map<string, HTMLButtonElement>();
                    cells.set("one", cell);
                    cells.get("one")?.classList.add("compact");
                    document.body.appendChild(grid);
                }
                void main();
            `),
    );

    assert.doesNotThrow(() =>
        compileSource(`
                import { createEngine } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    await createEngine({});
                    const style = document.createElement("style");
                    style.textContent =
                        ".grid { display:grid;grid-template-columns:repeat(2,24px); }" +
                        ".cell { width:24px;height:24px; }" +
                        ".cell.compact { width:20px; }";
                    document.head.appendChild(style);
                    const grid = document.createElement("div");
                    grid.className = "grid";
                    const cell = document.createElement("button");
                    cell.className = "cell";
                    grid.appendChild(cell);
                    const cells = new Map<string, HTMLButtonElement>();
                    cells.set("one", cell);
                    window.addEventListener("keydown", (event) => {
                        cells.get(event.code)?.classList.add("compact");
                    });
                    document.body.appendChild(grid);
                }
                void main();
            `),
    );

    const safe = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                ".grid { display:grid;grid-template-columns:repeat(2,24px); }" +
                ".cell { width:24px;height:24px; }" +
                ".cell.active { box-shadow:inset 0 0 0 2px blue; }";
            document.head.appendChild(style);
            const grid = document.createElement("div");
            grid.className = "grid";
            const cell = document.createElement("button");
            cell.className = "cell";
            grid.appendChild(cell);
            const cells = new Map<string, HTMLButtonElement>();
            cells.set("one", cell);
            window.addEventListener("keydown", (event) => {
                cells.get(event.code)?.classList.add("active");
            });
            document.body.appendChild(grid);
        }
        void main();
    `);
    const get = safe.cpp.match(
        /const auto (v_bblite_map_get_\d+) = [^;]+\.get\([^;]+\);/,
    );
    assert.ok(get);
    assert.match(
        safe.cpp,
        new RegExp(
            `if \\(${get[1]}\\.has_value\\(\\)\\) \\{\\s+` +
                `\\[\\[maybe_unused\\]\\] auto (\\w+) = ${get[1]}\\.value_or\\(bbl::UiElementHandle\\{\\}\\);\\s+` +
                `bbl::ui_(?:set|toggle)_class\\([^,\\n]+, \\1, "active", true\\);\\s+\\}`,
        ),
    );
    assert.equal(
        [...safe.cpp.matchAll(new RegExp(`const auto ${get[1]} =`, "g"))]
            .length,
        1,
    );
    assert.match(safe.cpp, /UiStyleSelectorKind::CompoundClass/);
    assert.match(safe.cpp, /box-shadow:inset 0 0 0 2px blue;/);
});

test("retains jointly activating grid geometry classes", () => {
    assert.doesNotThrow(() =>
        compileSource(
            `
                    import { createEngine } from "@babylonjs/lite";
                    async function main(): Promise<void> {
                        await createEngine({});
                        const style = document.createElement("style");
                        style.textContent =
                            ".grid { display:grid;grid-template-columns:repeat(1,24px); }" +
                            ".cell { width:24px;height:24px; }" +
                            ".compact.tight { max-width:20px; }";
                        document.head.appendChild(style);
                        const grid = document.createElement("div");
                        grid.className = "grid";
                        const cell = document.createElement("button");
                        cell.className = "cell";
                        grid.appendChild(cell);
                        const cells = new Map<string, HTMLButtonElement>();
                        cells.set("one", cell);
                        window.addEventListener("keydown", (event) => {
                            cells.get(event.code)?.classList.add("compact");
                            cells.get(event.key)?.classList.add("tight");
                        });
                        document.body.appendChild(grid);
                    }
                    void main();
                `,
            { fileName: "test/joint-grid-classes.ts" },
        ),
    );
});

test("retains runtime class and id changes affecting grid geometry", () => {
    const mutationSource = (
        selector: string,
        initialAttribute: string,
        mutation: string,
    ): string => `
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                "${selector} { display:grid;grid-template-columns:repeat(1,24px); }" +
                ".cell { width:24px;height:24px; }";
            document.head.appendChild(style);
            const grid = document.createElement("div");
            ${initialAttribute}
            const cell = document.createElement("button");
            cell.className = "cell";
            grid.appendChild(cell);
            document.body.appendChild(grid);
            window.addEventListener("keydown", (event) => {
                ${mutation}
            });
        }
        void main();
    `;

    assert.doesNotThrow(() =>
        compileSource(
            mutationSource(
                ".grid",
                'grid.className = "grid";',
                "grid.className = event.code;",
            ),
        ),
    );
    assert.doesNotThrow(() =>
        compileSource(
            mutationSource(
                "#palette",
                'grid.id = "palette";',
                "grid.id = event.code;",
            ),
        ),
    );

    assert.doesNotThrow(() =>
        compileSource(`
                import { createEngine } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    await createEngine({});
                    const style = document.createElement("style");
                    style.textContent =
                        "#palette { display:grid;grid-template-columns:repeat(1,24px); }" +
                        ".cell { width:24px;height:24px; }";
                    document.head.appendChild(style);
                    const grid = document.createElement("div");
                    grid.id = "palette";
                    const cell = document.createElement("button");
                    cell.className = "cell";
                    grid.appendChild(cell);
                    document.body.appendChild(grid);
                    window.addEventListener("keydown", (event) => {
                        cell.className = event.code;
                    });
                }
                void main();
            `),
    );
});

test("retains runtime class and id values beside grid layout", () => {
    assert.doesNotThrow(() =>
        compileSource(`
            import { createEngine } from "@babylonjs/lite";
            async function main(): Promise<void> {
                await createEngine({});
                const grid = document.createElement("div");
                grid.style.cssText =
                    "display:grid;grid-template-columns:repeat(1,24px)";
                const cell = document.createElement("button");
                cell.style.cssText = "width:24px;height:24px";
                grid.appendChild(cell);
                document.body.appendChild(grid);
                const status = document.createElement("div");
                document.body.appendChild(status);
                window.addEventListener("keydown", (event) => {
                    status.className = event.code;
                    status.id = event.key;
                });
            }
            void main();
        `),
    );
});

test("retains max-width media cascade and auto resets for live resize", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent = \`
                .panel { right: 8px; bottom: 8px; }
                @media (max-width: 768px) {
                    .panel { top: 5px; left: 5px; right: auto; bottom: auto; }
                }
            \`;
            document.head.appendChild(style);
            const panel = document.createElement("div");
            panel.className = "panel";
            document.body.appendChild(panel);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /UiStyleSelectorKind::Class, \.primary = "panel", \.style = "[^"]*", \.max_width = 768\.0/,
    );
    assert.match(result.cpp, /right:\s*auto;\s*bottom:\s*auto/);
    const palUi = palUiRmlSource;
    assert.match(
        palUi,
        /for \(const auto& \[feature, bound\] : ui_viewport_features\)/,
    );
    assert.match(palUi, /context->SetDimensions/);
});

test("recomputes retained UI intrinsic width without overriding responsive width", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent = \`
                @media (max-width:640px) {
                    .panel { width:120px; }
                }
            \`;
            document.head.appendChild(style);
            const panel = document.createElement("div");
            panel.className = "panel";
            panel.style.cssText =
                "position:absolute;right:8px;min-width:180px";
            const button = document.createElement("button");
            button.style.width = "100%";
            panel.appendChild(button);
            document.body.appendChild(panel);
        }
        void main();
    `);

    assert.match(result.cpp, /--bbl-intrinsic-min-width:180px/);
    assert.doesNotMatch(result.cpp, /min-width:180px;?width:180px/);
    const projection = palUiRmlSource;
    // A resized viewport lays out again, which recomputes intrinsic widths.
    assert.match(projection, /viewport_changed = dimensions_changed/);
    assert.match(
        projection,
        /layout_changed = [^;]*viewport_changed[^;]*;[\s\S]{0,200}if \(layout_changed\)\s+runtime\.update_intrinsic_widths\(\);/,
    );
    const intrinsic = projection.slice(
        projection.indexOf("bool has_active_authored_width"),
        projection.indexOf("void render_canvas("),
    );
    // The pass's widths restore the element's own inline width when cleared.
    assert.match(
        intrinsic,
        /intrinsic_width\.set\(\*projected\.element, Rml::PropertyId::Width, std::nullopt\)/,
    );
    assert.match(intrinsic, /intrinsic_width\.set_string\(/);
    assert.match(intrinsic, /has_active_authored_width/);
});

test("switches synthetic intrinsic width with active hover width rules", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent = ".shell div:hover { width:240px; }";
            document.head.appendChild(style);
            const shell = document.createElement("section");
            shell.className = "shell";
            const panel = document.createElement("div");
            panel.style.cssText =
                "position:absolute;right:8px;min-width:180px";
            const child = document.createElement("button");
            child.style.width = "100%";
            panel.appendChild(child);
            shell.appendChild(panel);
            document.body.appendChild(shell);
        }
        void main();
    `);
    assert.match(result.cpp, /--bbl-intrinsic-min-width:180px/);

    const projection = palUiRmlSource;
    const intrinsic = projection.slice(
        projection.indexOf("bool has_active_authored_width"),
        projection.indexOf("void render_canvas("),
    );
    // RmlUi's cascade, hover rules and CSS-wide keywords included, gives the width.
    assert.match(
        intrinsic,
        /element\.GetLocalProperty\(Rml::PropertyId::Width\)/,
    );
    // The element cascade reads the matching rules through the shared core.
    const cascade = cppFunction(
        projection,
        "std::string cascaded_declaration(",
    );
    assert.match(cascade, /cascade_declaration\(record, property/);
    assert.match(cascade, /for_each_matching_style_rule/);
    const core = cppFunction(projection, "std::string cascade_declaration(");
    assert.match(
        core,
        /consider_cascaded_declaration\(cascaded, take_css_declaration\(style, property\),\s*ui_style_rule_specificity\(rule\), rule_order\)/,
    );
    const matching = cppFunction(
        projection,
        "std::size_t for_each_matching_style_rule(",
    );
    assert.match(matching, /!style_selectors\.matches\(origin, rule_order\)/);
    const update = projection.slice(
        projection.indexOf("void update_ui_rml_runtime"),
        projection.indexOf("const UiRenderFrame& record_ui_rml_frame"),
    );
    assert.match(
        update,
        /const bool hover_changed = runtime\.sync_hover_states/,
    );
    assert.match(
        update,
        /if \(hover_changed \|\| containers_changed\) \{[\s\S]*?runtime\.sync_tree\(\)/,
    );
    assert.match(
        update,
        /const bool layout_changed =[^;]*\bhover_changed;[\s\S]*if \(layout_changed\)\s+runtime\.update_intrinsic_widths/,
    );
});

test("retains fixed-column grid declarations without synthetic geometry", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent = \`
                .palette {
                    position: fixed;
                    left: 50%;
                    display: grid;
                    grid-template-columns: repeat(7, 24px);
                    gap: 3px;
                }
                .swatch { width: 24px; height: 24px; border: none; padding: 0; }
            \`;
            document.head.appendChild(style);
            const palette = document.createElement("div");
            palette.className = "palette";
            for (let index = 0; index < 14; index++) {
                const swatch = document.createElement("button");
                swatch.className = "swatch";
                palette.appendChild(swatch);
            }
            document.body.appendChild(palette);
        }

        void main();
    `);

    assert.match(result.cpp, /grid-template-columns/i);
    assert.match(result.cpp, /grid-template-columns/i);
});

test("preserves explicit grid rows and equal min/max child constraints", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                ".grid {" +
                "DISPLAY:GRID;GRID-TEMPLATE-COLUMNS:repeat(2,24px);" +
                "GRID-TEMPLATE-ROWS:repeat(2,24px);JUSTIFY-CONTENT:CENTER;" +
                "}" +
                ".cell {" +
                "WIDTH:24px;HEIGHT:24px;" +
                "MIN-WIDTH:24px;MAX-WIDTH:24px;" +
                "MIN-HEIGHT:24px;MAX-HEIGHT:24px;" +
                "}";
            document.head.appendChild(style);
            const grid = document.createElement("div");
            grid.className = "grid";
            for (let index = 0; index < 4; index++) {
                const cell = document.createElement("button");
                cell.className = "cell";
                grid.appendChild(cell);
            }
            document.body.appendChild(grid);
        }
        void main();
    `);
    assert.match(result.cpp, /grid-template-rows:repeat\(/i);
    assert.match(result.cpp, /grid-template-rows:repeat\(/i);
    assert.match(result.cpp, /justify-content:center/i);

    assert.doesNotThrow(() =>
        compileSource(`
                import { createEngine } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    await createEngine({});
                    const style = document.createElement("style");
                    style.textContent =
                        ".grid { display:grid;grid-template-columns:repeat(2,24px);" +
                        "grid-template-rows:repeat(3,24px); }" +
                        ".cell { width:24px;height:24px; }";
                    document.head.appendChild(style);
                    const grid = document.createElement("div");
                    grid.className = "grid";
                    for (let index = 0; index < 4; index++) {
                        const cell = document.createElement("button");
                        cell.className = "cell";
                        grid.appendChild(cell);
                    }
                    document.body.appendChild(grid);
                }
                void main();
            `),
    );
});

test("admits hidden and positioned children beside explicit grid rows", () => {
    const source = (extra: string): string => `
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                ".grid {" +
                "display:grid;grid-template-columns:repeat(1,24px);" +
                "grid-template-rows:repeat(1,24px);" +
                "}" +
                ".cell { width:24px;height:24px;${extra} }";
            document.head.appendChild(style);
            const grid = document.createElement("div");
            grid.className = "grid";
            const cell = document.createElement("button");
            cell.className = "cell";
            grid.appendChild(cell);
            document.body.appendChild(grid);
        }
        void main();
    `;

    assert.doesNotThrow(() => compileSource(source("display:none;")));
    assert.doesNotThrow(() => compileSource(source("position:absolute;")));
    assert.doesNotThrow(() =>
        compileSource(
            source("").replace(
                "document.body.appendChild(grid);",
                `let hidden = false;
                     cell.style.display = hidden ? "none" : "block";
                     document.body.appendChild(grid);`,
            ),
        ),
    );
});

test("retains static and responsive min/max grid geometry changes", () => {
    const source = (extraRule: string): string => `
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                ".grid { display:grid;grid-template-columns:repeat(1,24px); }" +
                ".cell { width:24px;height:24px;max-width:20px; }" +
                ${JSON.stringify(extraRule)};
            document.head.appendChild(style);
            const grid = document.createElement("div");
            grid.className = "grid";
            const cell = document.createElement("button");
            cell.className = "cell";
            grid.appendChild(cell);
            document.body.appendChild(grid);
        }
        void main();
    `;
    assert.doesNotThrow(() => compileSource(source("")));

    const responsive = (rule: string): string =>
        source(rule).replace("max-width:20px;", "");
    assert.doesNotThrow(() =>
        compileSource(responsive(".grid button:hover { max-height:20px; }")),
    );
    assert.doesNotThrow(() =>
        compileSource(
            responsive(
                "@media (max-width:640px) { .cell { min-width:20px; } }",
            ),
        ),
    );
    assert.doesNotThrow(() =>
        compileSource(
            responsive(
                ".grid button:hover { max-width:24px; }" +
                    "@media (max-width:640px) { .cell { min-height:24px; } }",
            ),
        ),
    );
});

test("retains responsive geometry changes on grid items", () => {
    assert.doesNotThrow(() =>
        compileSource(
            `
                    import { createEngine } from "@babylonjs/lite";
                    async function main(): Promise<void> {
                        await createEngine({});
                        const style = document.createElement("style");
                        style.textContent = \`
                            .palette {
                                display:grid;
                                grid-template-columns:repeat(2,24px);
                                gap:2px;
                            }
                            .swatch { width:24px; height:24px; }
                            @media (max-width:640px) {
                                .swatch { width:20px; }
                            }
                        \`;
                        document.head.appendChild(style);
                        const palette = document.createElement("div");
                        palette.className = "palette";
                        const swatch = document.createElement("button");
                        swatch.className = "swatch";
                        palette.appendChild(swatch);
                        document.body.appendChild(palette);
                    }
                    void main();
                `,
            { fileName: "test/retained-grid-media.ts" },
        ),
    );
    assert.doesNotThrow(() =>
        compileSource(`
                import { createEngine } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    await createEngine({});
                    const style = document.createElement("style");
                    style.textContent =
                        ".palette { display:grid;grid-template-columns:repeat(2,24px); }" +
                        ".swatch { width:24px;height:24px; }" +
                        ".swatch.compact { width:20px; }";
                    document.head.appendChild(style);
                    const palette = document.createElement("div");
                    palette.className = "palette";
                    const swatch = document.createElement("button");
                    swatch.className = "swatch";
                    palette.appendChild(swatch);
                    swatch.classList.add("compact");
                    document.body.appendChild(palette);
                }
                void main();
            `),
    );
});

test("preserves retained UI grid track alignment", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent = \`
                .start {
                    display:grid;
                    grid-template-columns:repeat(2,24px);
                }
                .center {
                    display:grid;
                    grid-template-columns:repeat(2,24px);
                    justify-content:center;
                }
                .swatch { width:24px; height:24px; }
            \`;
            document.head.appendChild(style);
            for (const className of ["start", "center"]) {
                const palette = document.createElement("div");
                palette.className = className;
                const swatch = document.createElement("button");
                swatch.className = "swatch";
                palette.appendChild(swatch);
                document.body.appendChild(palette);
            }
        }
        void main();
    `);

    assert.doesNotMatch(result.cpp, /--bbl-grid-justify-content:start/);
    assert.match(result.cpp, /justify-content:center/i);
});

test("preserves grid class toggles without projected child containers", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                ".palette { display:grid;grid-template-columns:repeat(2,24px); }" +
                ".swatch { width:24px;height:24px; }";
            document.head.appendChild(style);
            const palette = document.createElement("div");
            const swatch = document.createElement("button");
            swatch.className = "swatch";
            palette.appendChild(swatch);
            document.body.appendChild(palette);
            palette.classList.add("palette");
            palette.classList.remove("palette");
        }
        void main();
    `);
    assert.equal(
        [...result.cpp.matchAll(/ui_(?:set|toggle)_class/g)].length,
        2,
    );
});

test("retains mutable-class grid track lists", () => {
    const source = (tightWidth: number): string => `
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                ".tight { display:grid;grid-template-columns:repeat(2,${tightWidth}px); }" +
                ".wide { display:grid;grid-template-columns:repeat(4,24px); }" +
                ".cell { width:24px;height:24px; }";
            document.head.appendChild(style);
            const grid = document.createElement("div");
            grid.className = "wide";
            const cell = document.createElement("button");
            cell.className = "cell";
            grid.appendChild(cell);
            document.body.appendChild(grid);
            grid.classList.remove("wide");
            grid.classList.add("tight");
        }
        void main();
    `;

    assert.doesNotThrow(() => compileSource(source(20)));
    const valid = compileSource(source(24));
    assert.match(valid.cpp, /grid-template-columns:repeat\(4,24px\)/);
    assert.match(valid.cpp, /grid-template-columns:repeat\(2,24px\)/);
});

test("keeps grid children addressable by authored selectors", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent =
                ".grid { display:grid;grid-template-columns:repeat(2,24px); }" +
                ".grid div { width:24px;height:24px;color:red; }";
            document.head.appendChild(style);
            const grid = document.createElement("div");
            grid.className = "grid";
            const cell = document.createElement("div");
            grid.appendChild(cell);
            document.body.appendChild(grid);
        }
        void main();
    `);
    assert.match(result.cpp, /UiStyleSelectorKind::ClassDescendantTag/);
    assert.throws(
        () =>
            compileSource(`
                import { createEngine } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    await createEngine({});
                    document.createElement("bbl-grid-children");
                }
                void main();
            `),
        /is reserved for the retained projection/,
    );
});

test("lowers scoped class queries to retained DOM-order iteration", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const root = document.createElement("div");
            root.className = "palette";
            const first = document.createElement("button");
            first.className = "swatch";
            const second = document.createElement("button");
            second.className = "swatch";
            root.append(first, second);
            root.querySelectorAll(".swatch").forEach((element, index) => {
                element.classList.toggle("active", index === 1);
            });
            document.body.appendChild(root);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /ui_query_elements[^\n]*UiSelectorTestKind::Class, "swatch"/,
    );
    assert.match(result.cpp, /for \(std::size_t [^;]+;/);
    assert.match(result.cpp, /ui_(?:set|toggle)_class[^\n]*"active"/);
});

test("lowers dynamic rgb background strings on retained elements", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const button = document.createElement("button");
            let red = 10;
            button.style.background =
                \`rgb(\${Math.round(red)}, \${20}, \${30})\`;
            document.body.appendChild(button);
        }

        void main();
    `);

    assert.match(result.cpp, /ui_set_style_property/);
    assert.match(result.cpp, /ui_set_background\(/);
    assert.match(result.cpp, /rgb\(/);
});

test("carries retained mousedown cancellation from the executed callback", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            let cancel = true;
            const button = document.createElement("button");
            button.addEventListener("mousedown", (event: MouseEvent) => {
                const alias = event;
                if (cancel) alias.preventDefault();
                else event.preventDefault();
            });
            document.body.appendChild(button);
        }

        void main();
    `);

    assert.match(result.cpp, /\.prevent_default\(\)/);
    assert.equal([...result.cpp.matchAll(/\.prevent_default\(\)/g)].length, 2);
    assert.match(result.cpp, /const auto& (v_[^ ]*alias) = v_[^;]*event;/);
    assert.doesNotMatch(
        result.cpp,
        /(?:^|\n)\s*auto v_[^ ]*alias = v_[^;]*event;/,
    );
    assert.match(result.cpp, /on_dom_pointer[^\n]*"mousedown"/);
    assert.doesNotMatch(result.cpp, /"mousedown", true/);
    const projection = palUiRmlSource;
    assert.match(
        projection,
        /pointer\.default_prevented[\s\S]{0,80}default_prevented = true/,
    );
    assert.match(
        projection,
        /previous_focus[\s\S]{0,500}current_focus->Blur\(\)/,
    );
    // Descendants share their button's click target; the button itself remains
    // focusable, and cancelling mousedown still restores the previous focus.
    const defaults = readFileSync("native/src/pal_ui_defaults.hpp", "utf8");
    assert.match(defaults, /button \*\{focus:none;\}/);
    assert.doesNotMatch(defaults, /button\{focus:none/);

    assert.throws(
        () =>
            compileSource(`
                import { createEngine } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    await createEngine({});
                    const button = document.createElement("button");
                    button.addEventListener("mousedown", (event: MouseEvent) => {
                        const cancel = event.preventDefault;
                        cancel();
                    });
                    document.body.appendChild(button);
                }
                void main();
            `),
        /Platform mouse events do not expose 'preventDefault'/,
    );
});

// An escaping callback's captures of the event, through aliases and
// records, are copies of it (callback-registry.test.ts runs them against
// JavaScript).
test("a listener reads its event in place and hands later callbacks owned fields", () => {
    assert.doesNotThrow(() =>
        compileSource(`
            import { createEngine } from "@babylonjs/lite";
            async function main(): Promise<void> {
                await createEngine({});
                const button = document.createElement("button");
                button.addEventListener("mousedown", (event: MouseEvent) => {
                    const wrapped = { nested: [event] as const };
                    wrapped.nested[0].preventDefault();
                });
                document.body.appendChild(button);
            }
            void main();
        `),
    );
    const owned = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const button = document.createElement("button");
            window.addEventListener("keydown", (event) => {
                const code = event.code;
                button.addEventListener("click", () => {
                    button.textContent = code;
                });
            });
            document.body.appendChild(button);
        }
        void main();
    `);
    assert.match(owned.cpp, /std::string v_[^ ]*code = v_[^;]*event\.code/);
});

test("accepts bounded span and SVG innerHTML with inherited currentColor", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        const ICON =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
            ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="4" y="2" width="16" height="8" rx="2"/>' +
            '<path d="M10 10v11a1 1 0 001 1h2a1 1 0 001-1V10"/>' +
            '</svg>';

        async function main(): Promise<void> {
            await createEngine({});
            const style = document.createElement("style");
            style.textContent = ".tool svg { width: 36px; height: 36px; }";
            document.head.appendChild(style);
            const button = document.createElement("button");
            button.className = "tool";
            button.innerHTML =
                ICON + '<span class="hotkey">1</span>';
            document.body.appendChild(button);
        }

        void main();
    `);

    assert.match(result.cpp, /ui_set_inner_rml/);
    assert.match(result.cpp, /data-bbl-current-color/);
    assert.match(result.cpp, /stroke=\\?"white/);
    assert.match(result.cpp, /class=\\?"hotkey/);
    assert.ok(result.manifest.features.includes("ui:inline-svg"));
    assert.match(
        result.manifest.adaptations.find(
            ({ id }) => id === "substituted-ui-runtime",
        )?.nativeSemantics ?? "",
        /LunaSVG/,
    );
});

test("refuses retained UI selectors for LunaSVG path and rect internals", () => {
    for (const target of ["path", "rect"]) {
        assert.throws(
            () =>
                compileSource(
                    `
                        import { createEngine } from "@babylonjs/lite";
                        async function main(): Promise<void> {
                            await createEngine({});
                            const style = document.createElement("style");
                            style.textContent = ".tool ${target} { color:red; }";
                            document.head.appendChild(style);
                            const tool = document.createElement("button");
                            tool.className = "tool";
                            tool.innerHTML =
                                '<svg viewBox="0 0 8 8">' +
                                '<path d="M0 0L8 8"/>' +
                                '<rect x="0" y="0" width="8" height="8"/>' +
                                '</svg>';
                            document.body.appendChild(tool);
                        }
                        void main();
                    `,
                    { fileName: `test/retained-svg-${target}-selector.ts` },
                ),
            (error: unknown) => {
                assert.ok(error instanceof CompileError);
                assert.match(
                    error.message,
                    new RegExp(
                        `^test/retained-svg-${target}-selector\\.ts:\\d+:\\d+:`,
                    ),
                );
                assert.match(
                    error.message,
                    /cannot target SVG path\/rect nodes/,
                );
                return true;
            },
        );
    }
});

test("refuses mixed literal and currentColor retained SVG paints but keeps none", () => {
    const accepted = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const tool = document.createElement("button");
            tool.innerHTML =
                '<svg viewBox="0 0 8 8" fill="none" stroke="currentColor">' +
                '<path d="M0 0L8 8"/>' +
                '</svg>';
            document.body.appendChild(tool);
        }
        void main();
    `);
    assert.match(accepted.cpp, /data-bbl-current-color/);

    const childCurrentColor = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const tool = document.createElement("button");
            tool.innerHTML =
                '<svg viewBox="0 0 8 8" fill="none">' +
                '<path d="M0 0L8 8" fill="currentColor"/>' +
                '</svg>';
            document.body.appendChild(tool);
        }
        void main();
    `);
    assert.match(childCurrentColor.cpp, /data-bbl-current-color/);
    assert.match(childCurrentColor.cpp, /fill=\\?"white/);

    assert.throws(
        () =>
            compileSource(
                `
                    import { createEngine } from "@babylonjs/lite";
                    async function main(): Promise<void> {
                        await createEngine({});
                        const tool = document.createElement("button");
                        tool.innerHTML =
                            '<svg viewBox="0 0 8 8" stroke="currentColor">' +
                            '<rect x="0" y="0" width="8" height="8" fill="#f00"/>' +
                            '</svg>';
                        document.body.appendChild(tool);
                    }
                    void main();
                `,
                { fileName: "test/retained-svg-paint.ts" },
            ),
        (error: unknown) => {
            assert.ok(error instanceof CompileError);
            assert.match(
                error.message,
                /^test\/retained-svg-paint\.ts:\d+:\d+:/,
            );
            assert.match(
                error.message,
                /cannot mix currentColor with literal SVG paints/,
            );
            return true;
        },
    );

    assert.throws(
        () =>
            compileSource(
                `
                    import { createEngine } from "@babylonjs/lite";
                    async function main(): Promise<void> {
                        await createEngine({});
                        const tool = document.createElement("button");
                        tool.innerHTML =
                            '<svg viewBox="0 0 8 8" stroke="currentColor">' +
                            '<path d="M0 0L8 8"/>' +
                            '</svg>';
                        document.body.appendChild(tool);
                    }
                    void main();
                `,
                { fileName: "test/retained-svg-default-paint.ts" },
            ),
        (error: unknown) => {
            assert.ok(error instanceof CompileError);
            assert.match(
                error.message,
                /^test\/retained-svg-default-paint\.ts:\d+:\d+:/,
            );
            assert.match(error.message, /implicit default fill:black/);
            return true;
        },
    );
});

test("refuses unsafe or unbounded retained innerHTML", () => {
    const withMarkup = (markup: string): string => `
        import { createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            await createEngine({});
            const panel = document.createElement("div");
            panel.innerHTML = ${JSON.stringify(markup)};
            document.body.appendChild(panel);
        }
        void main();
    `;

    assert.throws(
        () => compileSource(withMarkup("<script>alert(1)</script>")),
        /outside the bounded (?:div\/span\/)?HTML\/SVG subset/,
    );
    assert.throws(
        () => compileSource(withMarkup('<span onclick="go()">x</span>')),
        /attribute 'onclick' is not supported/,
    );
    assert.throws(
        () =>
            compileSource(
                withMarkup(
                    '<svg viewBox="0 0 24 24"><path href="x" d="M0 0"/></svg>',
                ),
            ),
        /attribute 'href' is not supported/,
    );
});

test("admits scoped sheets, empty queries and dynamic grid children", () => {
    assert.match(
        compileSource(`
                import { createEngine } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    await createEngine({});
                    const style = document.createElement("style");
                    style.textContent = ".panel button { color: red; }";
                    document.head.appendChild(style);
                }
                void main();
            `).cpp,
        /UiStyleSelectorKind::ClassDescendantTag/,
    );
    assert.match(
        compileSource(`
                import { createEngine } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    await createEngine({});
                    const root = document.createElement("div");
                    root.querySelectorAll(".missing").forEach((element) => {
                        element.classList.toggle("active", true);
                    });
                    document.body.appendChild(root);
                }
                void main();
            `).cpp,
        /ui_query_elements[^\n]*UiSelectorTestKind::Class, "missing"/,
    );
    assert.doesNotThrow(() =>
        compileSource(`
                import { createEngine } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    await createEngine({});
                    const style = document.createElement("style");
                    style.textContent =
                        ".grid { display:grid;grid-template-columns:repeat(2,24px);gap:2px; }" +
                        ".cell { width:23px;height:24px; }";
                    document.head.appendChild(style);
                    const grid = document.createElement("div");
                    grid.className = "grid";
                    const cell = document.createElement("div");
                    cell.className = "cell";
                    grid.appendChild(cell);
                    document.body.appendChild(grid);
                }
                void main();
            `),
    );
});

test("refuses retained style properties outside the reviewed surface", () => {
    const withCss = (css: string): string => `
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const panel = document.createElement("div");
            panel.style.cssText = "${css}";
            document.body.appendChild(panel);
        }

        void main();
    `;

    assert.throws(
        () => compileSource(withCss("mix-blend-mode:screen;")),
        /Retained UI style property 'mix-blend-mode' is not lowered: only the reached difference-mode crosshair/,
    );
    const difference = compileSource(withCss("mix-blend-mode:difference;"));
    assert.match(
        difference.manifest.adaptations.find(
            ({ id }) => id === "substituted-ui-runtime",
        )?.nativeSemantics ?? "",
        /mix-blend-mode/,
    );
    assert.doesNotMatch(difference.cpp, /mix-blend-mode/);
    // The refusal names the accepted sets so the boundary is discoverable.
    assert.throws(
        () => compileSource(withCss("shape-outside:circle(4px);")),
        /accepted with a recorded degradation: .*backdrop-filter.*font-variant-numeric/,
    );
    assert.match(
        compileSource(withCss("background-size:cover;")).cpp,
        /bbl-background-size:cover/,
    );
    assert.match(
        compileSource(withCss("color:transparent;")).cpp,
        /color:transparent/,
    );
    assert.match(
        compileSource(withCss("display:inline-grid;color:#fff;")).cpp,
        /display:inline-grid/,
    );
    assert.throws(
        () => compileSource(withCss("text-shadow:oops;")),
        /Retained UI style property 'text-shadow' is not lowered: the shadow list 'oops'/,
    );
});

test("records reached degraded style properties in the UI adaptation", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const panel = document.createElement("div");
            panel.style.cssText =
                "position:fixed;backdrop-filter:blur(3px);" +
                "font-variant-numeric:tabular-nums;";
            const cell = document.createElement("div");
            cell.style.boxShadow = "0 0 10px #fff";
            document.body.appendChild(panel);
            document.body.appendChild(cell);
        }

        void main();
    `);

    const adaptation = result.manifest.adaptations.find(
        ({ id }) => id === "substituted-ui-runtime",
    );
    assert.ok(adaptation);
    assert.equal(adaptation.category, "platform");
    assert.match(adaptation.nativeSemantics, /font-variant-numeric/);
    assert.doesNotMatch(
        adaptation.nativeSemantics,
        /backdrop-filter|box-shadow/,
    );
    assert.match(result.cpp, /backdrop-filter:blur\(3px\)/);
    assert.match(adaptation.nativeSemantics, /RmlUi/);
    assert.match(adaptation.nativeSemantics, /element\.animate\(\)/);
    assert.match(adaptation.nativeSemantics, /steps\(\)/);
    // The degraded declarations still compile: accepted, not refused.
    assert.match(result.cpp, /ui_set_style_property/);
});

test("emits the UI adaptation for a page-only scene with its degradations", () => {
    const result = compileSource(
        `
            import { createEngine, startEngine } from "@babylonjs/lite";

            async function main(): Promise<void> {
                const engine = await createEngine({});
                await startEngine(engine);
            }

            void main();
        `,
        hostUiOptions(
            {
                elements: [
                    {
                        tag: "div",
                        text: "hint",
                        attributes: {
                            style: "position:fixed;backdrop-filter:blur(14px);",
                        },
                    },
                ],
            },
            { path: "test.html" },
        ),
    );

    const adaptation = result.manifest.adaptations.find(
        ({ id }) => id === "substituted-ui-runtime",
    );
    assert.ok(adaptation);
    assert.doesNotMatch(
        adaptation.nativeSemantics,
        /backdrop-filter|box-shadow/,
    );
    assert.match(result.cpp, /backdrop-filter:blur\(14px\)/);
});

test("keeps scenes without retained UI free of the UI adaptation", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            createBox(engine);
        }

        void main();
    `);

    assert.ok(
        !result.manifest.adaptations.some(
            ({ id }) => id === "substituted-ui-runtime",
        ),
    );
});

test("lowers retained UI replaceChildren clearing", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const pips = document.createElement("div");
            const pip = document.createElement("span");
            pips.appendChild(pip);
            pips.replaceChildren();
            document.body.appendChild(pips);
        }

        void main();
    `);

    assert.match(result.cpp, /ui_replace_children/);
});

test("lowers conditional retained UI gradients to RmlUi decorators", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const pip = document.createElement("span");
            let lit = true;
            pip.style.cssText =
                "width:22px;height:22px;" +
                (lit
                    ? "background:linear-gradient(#ff8a5d,#ff4d4d);"
                    : "background:rgba(40,40,48,.7);");
            document.body.appendChild(pip);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /v_lit \? "[^"]*background-color:transparent;bbl-background-image:linear-gradient\(#ff8a5d,#ff4d4d\);"/,
    );
    assert.match(result.cpp, /background-color:rgba\(40,40,48,.7\)/);
});

test("projects independently sized gradient layers into RmlUi decorators", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const crosshair = document.createElement("div");
            crosshair.style.cssText =
                "position:absolute;width:22px;height:22px;" +
                "background:" +
                "linear-gradient(#fff,#fff) center/2px 22px no-repeat," +
                "linear-gradient(#fff,#fff) center/22px 2px no-repeat;" +
                "mix-blend-mode:difference;opacity:0.9;";
            document.body.appendChild(crosshair);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /bbl-background-image:linear-gradient\(#fff,#fff\) padding-box \/ 2px 22px \/ 50% 50%,linear-gradient\(#fff,#fff\) padding-box \/ 22px 2px \/ 50% 50%/,
    );
    assert.doesNotMatch(result.cpp, /bbl-background-image:[^";]*no-repeat/);
    assert.doesNotMatch(result.cpp, /mix-blend-mode/);
});

test("lowers numeric template substitutions in retained UI cssText", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const hit = document.createElement("div");
            // Run-time numbers: a never-written literal folds into the text.
            let right = Number(JSON.parse("12"));
            let width = Number(JSON.parse("180"));
            hit.style.cssText =
                \`position:fixed;right:\${right}px;width:\${width}px;\` +
                "cursor:crosshair";
            document.body.appendChild(hit);
        }

        void main();
    `);

    assert.match(result.cpp, /position:absolute;right:/);
    assert.match(
        result.cpp,
        /right:", bbl::js::number_to_string\(v_right\), "px;width:"/,
    );
    assert.match(result.cpp, /number_to_string\(v_right\)/);
    assert.match(result.cpp, /number_to_string\(v_width\)/);
    assert.match(result.cpp, /cursor:crosshair/);
    assert.doesNotMatch(result.cpp, /right:;display:inline-block/);
});

test("lowers dynamic Number.toFixed values in retained UI styles", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const flash = document.createElement("div");
            window.addEventListener("pointermove", (event) => {
                flash.style.opacity = (event.clientX * 0.4).toFixed(2);
            });
            document.body.appendChild(flash);
        }

        void main();
    `);

    const receiver = /const double (\w+) = \([^;]*\.client_x \* 0\.4\);/.exec(
        result.cpp,
    );
    assert.ok(receiver);
    assert.match(
        result.cpp,
        new RegExp(`number_to_fixed\\(${receiver[1]}, 2\\.0\\)`),
    );
});

test("stores nullable retained UI handles in native optional storage", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            let stats: HTMLDivElement | null = null;
            stats = document.createElement("div");
            stats!.style.display = "flex";
            if (stats!.style.display === "flex") stats!.textContent = "READY";
            document.body.appendChild(stats!);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /std::optional<std::pair<bbl::StoredEngine, bbl::UiElementHandle>> v_stats\{\};/,
    );
    assert.match(
        result.cpp,
        /v_stats = bbl::js::Nullable<std::pair<bbl::StoredEngine, bbl::UiElementHandle>>\{std::pair<bbl::StoredEngine, bbl::UiElementHandle>\{bbl::StoredEngine\{(\w+)\}, bbl::ui_create_element\(\1, "div"\)\}\}\.to_optional\(\);/,
    );
    assert.equal(
        (result.cpp.match(/bbl::ui_create_element\(/g) ?? []).length,
        1,
    );
    const ownedUi = "std::pair<bbl::StoredEngine, bbl::UiElementHandle>";
    const styleReceiver = result.cpp.match(
        new RegExp(
            String.raw`bbl::js::Nullable<${ownedUi}> (v_bblite_style_receiver_\d+) = \(\[&\]\(\) -> bbl::js::Nullable<${ownedUi}> \{ const auto& (\w+) = v_stats; return \2 \? bbl::js::Nullable<${ownedUi}>\{\*\2\} : bbl::js::Nullable<${ownedUi}>\{std::nullopt\}; \}\(\)\);`,
        ),
    );
    assert.ok(styleReceiver);
    const stylePair = `(*${styleReceiver[1]})`;
    assert.ok(
        result.cpp.includes(
            `bbl::ui_set_style_property((*(${stylePair}).first), (${stylePair}).second, "display", "flex");`,
        ),
    );
    assert.ok(
        result.cpp.includes(
            'bbl::ui_get_style_property((*((*v_stats)).first), ((*v_stats)).second, "display")',
        ),
    );
    assert.ok(
        result.cpp.includes(
            'bbl::ui_set_text((*((*v_stats)).first), ((*v_stats)).second, "READY");',
        ),
    );
});

test("uses the first gradient colour for retained gradient text", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const logo = document.createElement("div");
            logo.style.cssText =
                "background:linear-gradient(90deg,#ff5d5d,#ffd95d);" +
                "-webkit-background-clip:text;background-clip:text;" +
                "color:transparent;";
            document.body.appendChild(logo);
        }

        void main();
    `);

    assert.match(result.cpp, /color:#ff5d5d/);
    assert.doesNotMatch(
        result.cpp,
        /linear-gradient|-webkit-color|background-clip/,
    );
});

test("lowers CSS text shadows to RmlUi glyph effects", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const label = document.createElement("div");
            label.textContent = "GAME OVER";
            label.style.cssText =
                "text-shadow:3px 3px 0 #000,0 0 16px rgba(210,29,18,.8);";
            document.body.appendChild(label);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /font-effect:shadow\(3px 3px #000\),glow\(0px 16px 0 0 rgba\(210,29,18,\.8\)\)/,
    );
    assert.doesNotMatch(result.cpp, /text-shadow/);
});

test("stores nullable retained UI callbacks as empty native functions", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const button = document.createElement("button");
            let callback: (() => void) | null = null;
            button.addEventListener("click", () => {
                if (callback) callback();
            });
            const install = (cb: () => void): void => {
                callback = cb;
            };
            install(() => {
                button.textContent = "done";
            });
            document.body.appendChild(button);
        }

        void main();
    `);

    assert.match(
        result.cpp,
        /auto v_callback = bbl::js::make_gc_shared<bbl::js::Callback<void\(\)>>/,
    );
    assert.match(result.cpp, /static_cast<bool>\(\(\*v_callback\)\)/);
    assert.match(
        result.cpp,
        /const auto (\w+) = bbl::js::snapshot_callback\(\(\*v_callback\)\);\s*\1\(\);/,
    );
    assert.match(
        result.cpp,
        /stored_callback = bbl::js::make_closure\(bblscene::bbl_environment_\w+\{v_button, std::ref\(v_bblite_inline_engine_\d+\)\}, bblscene::\w+/,
    );
    assert.match(result.cpp, /\(\*v_callback\) = \w+_stored_callback/);
});

test("projects host page chrome without changing scene source", () => {
    const result = compileSource(
        `
            import { createEngine, startEngine } from "@babylonjs/lite";

            async function main(): Promise<void> {
                const engine = await createEngine({});
                await startEngine(engine);
            }

            void main();
        `,
        hostUiOptions({
            styleSheets: [
                {
                    text: ".touch-controls { display: none; } .title span { display: block; color: #7fe0ff; }",
                    line: 1,
                },
            ],
            elements: [
                {
                    tag: "div",
                    text: "Keyboard help",
                    attributes: {
                        class: "controls-hint",
                        style: "position:fixed;background:rgba(0,0,0,0.5);",
                    },
                },
            ],
        }),
    );

    assert.ok(result.manifest.features.includes("ui:rml"));
    // A scene whose UI is only its page names the page, not the compiled
    // scene TypeScript.
    assert.equal(
        result.manifest.featureSites["ui:rml"],
        "fixture.html (host page)",
    );
    assert.match(
        result.cpp,
        /ui_add_(?:class_style|style_rule)\([^\n]*"touch-controls"[^\n]*"display:none;[^"]*--bbl-authored-display:1;"/,
    );
    assert.match(
        result.cpp,
        /ui_add_style_rule[^\n]*ClassDescendantTag[^\n]*"title"[^\n]*"span"[^\n]*"display:block;color:#7fe0ff;[^"]*--bbl-authored-display:1;"/,
    );
    assert.match(result.cpp, /ui_create_element[^\n]*"div"/);
    assert.match(result.cpp, /ui_set_text[^\n]*"Keyboard help"/);
    assert.match(
        result.cpp,
        /position:absolute;background-clip:border-box;[^"]*background-color:rgba\(0,0,0,0\.5\)/,
    );
    assert.match(result.cpp, /ui_append_to_root/);
});

test("resolves audited host UI ids before unchanged scene setup binds listeners", () => {
    const result = compileSource(
        `
            import { createEngine, startEngine } from "@babylonjs/lite";

            async function main(): Promise<void> {
                const engine = await createEngine({});
                let rotating = true;
                const toggle = document.getElementById("rotateToggle");
                if (toggle) {
                    toggle.addEventListener("click", () => {
                        rotating = !rotating;
                        toggle.textContent = rotating ? "Pause" : "Resume";
                    });
                }
                await startEngine(engine);
            }

            void main();
        `,
        hostUiOptions(
            {
                elements: [
                    {
                        tag: "button",
                        text: "Pause",
                        attributes: {
                            id: "rotateToggle",
                            style: "position:fixed;left:12px;bottom:10px;",
                        },
                    },
                ],
            },
            { path: "test.html" },
        ),
    );

    const create = result.cpp.indexOf("ui_create_element");
    const lookup = result.cpp.indexOf("ui_get_element_by_id");
    assert.ok(create >= 0 && lookup > create);
    assert.match(result.cpp, /ui_get_element_by_id[^\n]*"rotateToggle"/);
    assert.match(result.cpp, /on_dom_pointer[^\n]*"click"/);
    assert.match(result.cpp, /ui_set_text/);
    assert.doesNotMatch(result.cpp, /if \(false\)/);
});

test("lowers retained pointer state and class toggles", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const button = document.createElement("button");
            button.addEventListener("pointerdown", (event) => {
                button.classList.toggle("is-active", event.pointerId >= 0);
                button.setPointerCapture(event.pointerId);
            });
            button.addEventListener("pointerup", (event) => {
                button.releasePointerCapture(event.pointerId);
            });
            document.body.appendChild(button);
        }

        void main();
    `);

    assert.match(result.cpp, /on_dom_pointer[^\n]*"pointerdown"/);
    assert.match(result.cpp, /on_dom_pointer[^\n]*"pointerup"/);
    assert.match(result.cpp, /ui_(?:set|toggle)_class/);
    assert.doesNotMatch(result.cpp, /setPointerCapture|releasePointerCapture/);
});

test("lowers retained layout reads and pointer motion coordinates", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const hit = document.createElement("div");
            hit.addEventListener("pointermove", (event) => {
                if (!hit.hasPointerCapture(event.pointerId)) return;
                const rect = hit.getBoundingClientRect();
                hit.textContent = String(
                    (event.clientX - rect.left) / rect.width,
                );
            });
            document.body.appendChild(hit);
        }

        void main();
    `);

    assert.match(result.cpp, /on_dom_pointer[^\n]*"pointermove"/);
    assert.match(
        result.cpp,
        /"pointermove", \d+u, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{(?:std::ref\(v_bblite_inline_engine_\d+\), v_hit|v_hit, std::ref\(v_bblite_inline_engine_\d+\))\}, bblscene::\w+/,
    );
    assert.match(result.cpp, /\.client_x/);
    assert.match(
        result.cpp,
        /const auto \w+ = std::make_shared<const bbl::UiClientRect>\(bbl::ui_get_client_rect\(/,
    );
    // The getters read the one snapshot; DOMRect sizes are the border box.
    assert.match(result.cpp, /\(\w+\)->left\b/);
    assert.match(result.cpp, /\(\w+\)->offset_width\b/);
    assert.equal(result.cpp.match(/bbl::ui_get_client_rect\(/g)?.length, 1);
    assert.doesNotMatch(result.cpp, /hasPointerCapture|getBoundingClientRect/);
});

test("captures callback-local values by value in retained UI listeners", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const trigger = document.createElement("button");
            trigger.addEventListener("mousedown", () => {
                const index = 4;
                const swatch = document.createElement("button");
                swatch.addEventListener("mousedown", () => {
                    swatch.textContent = String(index);
                });
                document.body.appendChild(swatch);
            });
            document.body.appendChild(trigger);
        }

        void main();
    `);

    assert.equal(
        result.cpp.match(
            /on_dom_pointer\([^\n]*"mousedown", \d+u, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{/g,
        )?.length,
        2,
    );
    assert.doesNotMatch(result.cpp, /"mousedown", \[&\]/);
    assert.match(
        result.cpp,
        /bblscene::bbl_environment_\w+\{v_fn\d+_swatch, std::ref\(v_bblite_inline_engine_\d+\)\}/,
    );
    // A retained listener owns its captures; only an immediate call of the
    // shared listener body may borrow them.
    assert.doesNotMatch(
        result.cpp,
        /on_dom_pointer\([^\n]*std::ref\(v_fn\d+_(?:swatch|index)\)/,
    );
});

test("retains dynamically indexed UI handles and camelCase style properties", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const cells: HTMLDivElement[] = [];
            for (let i = 0; i < 4; i++) {
                const cell = document.createElement("div");
                document.body.appendChild(cell);
                cells.push(cell);
            }
            const paint = (index: number, color: string): void => {
                const cell = cells[index];
                if (cell) {
                    cell.style.background = color;
                    cell.style.fontWeight = "600";
                    cell.style.boxShadow = "0 0 10px #fff";
                }
            };
            paint(2, "#fff");
        }

        void main();
    `);

    assert.match(result.cpp, /bbl::js::Array<bbl::UiElementHandle>/);
    assert.match(result.cpp, /ui_set_background\(/);
    assert.match(result.cpp, /ui_set_style_property[^\n]*font-weight/);
    assert.match(result.cpp, /ui_set_style_property[^\n]*box-shadow/);
    assert.doesNotMatch(result.cpp, /fontWeight|boxShadow/);
});

test("packages runtime-selected root UI backgrounds through an image decorator", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const icons: { iconUrl: string }[] = [
                { iconUrl: "/voxelpack/stone.png" },
            ];
            icons.forEach((icon) => {
                const slot = document.createElement("div");
                slot.style.cssText =
                    \`width:50px;background:#222 url("\${icon.iconUrl}") center/cover;image-rendering:pixelated;\`;
                document.body.appendChild(slot);
            });
        }

        void main();
    `);

    assert.match(result.cpp, /background-color:#222;decorator:image\(\\"/);
    assert.match(result.cpp, /, v_fn\d+_icon->iconUrl, /);
    assert.doesNotMatch(result.cpp, /root_asset_path/);
    assert.match(result.cpp, /\\" cover\);/);
    assert.doesNotMatch(result.cpp, /background-color:#222 url/);
});

test("lowers the reached Canvas2D overlay subset beside retained DOM UI", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const pixels = new Uint8Array([255, 128, 0, 255]);
            const source = document.createElement("canvas");
            source.width = 1;
            source.height = 1;
            source.getContext("2d")!.putImageData(
                new ImageData(new Uint8ClampedArray(pixels), 1, 1),
                0,
                0,
            );
            const overlay = document.createElement("canvas");
            overlay.width = 64;
            overlay.height = 64;
            const context = overlay.getContext("2d")!;
            context.imageSmoothingEnabled = false;
            context.clearRect(0, 0, 64, 64);
            const scale = 2;
            context.drawImage(
                source,
                4,
                5,
                source.width * scale,
                source.height * scale,
            );
            context.font = "14px monospace";
            context.textBaseline = "top";
            context.fillStyle = "rgba(255,255,238,0.85)";
            context.shadowColor = "#000";
            context.shadowBlur = 4;
            context.fillText("KILLS 1/2", 0, 0);
            document.body.appendChild(overlay);
            createBox(engine);
        }

        void main();
    `);

    assert.match(result.cpp, /bbl::create_box/);
    assert.match(result.cpp, /ui_create_element[^\n]*"canvas"/);
    assert.match(result.cpp, /ui_canvas_set_width/);
    assert.match(result.cpp, /ui_canvas_clear_rect/);
    assert.match(result.cpp, /ui_canvas_put_image_data/);
    assert.match(result.cpp, /ui_canvas_set_image_smoothing[^;]*false/);
    assert.match(result.cpp, /ui_canvas_draw_image/);
    assert.match(result.cpp, /ui_canvas_width\([^;]*\* v_scale/);
    assert.match(result.cpp, /ui_canvas_set_font/);
    assert.match(result.cpp, /ui_canvas_set_shadow_blur/);
    assert.match(result.cpp, /ui_canvas_fill_text/);
    assert.match(result.cpp, /ui_append_to_root/);
});

test("lowers every Canvas2D clearRect shape; the PAL clears the draws exactly", () => {
    // Full-surface, partial, offset and run-time extents: the retained draw
    // list decides at run time what each clear covers (ui-canvas-rectangle).
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const canvas = document.createElement("canvas");
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            const context = canvas.getContext("2d")!;
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.scale(canvas.width / 150, canvas.height / 150);
            context.clearRect(0, 0, 150, 150);
            context.clearRect(4, 0, 32, 32);
            let w = canvas.width;
            w = 12;
            context.clearRect(0, 0, w, canvas.height);
            document.body.appendChild(canvas);
        }

        void main();
    `);
    assert.equal((result.cpp.match(/ui_canvas_clear_rect/g) ?? []).length, 4);
    assert.match(
        result.cpp,
        /ui_canvas_clear_rect\([^;]*, 4\.0, 0\.0, 32\.0, 32\.0\)/,
    );
});

test("reads the window size bare or through globalThis as through window", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const canvas = document.createElement("canvas");
            canvas.width = typeof innerWidth === "number" ? innerWidth : 0;
            canvas.height = globalThis.innerHeight;
            document.body.appendChild(canvas);
        }

        void main();
    `);
    assert.match(result.cpp, /static_cast<double>\([^;]*\.options\.width\)/);
    assert.match(result.cpp, /static_cast<double>\([^;]*\.options\.height\)/);
});

test("refuses retained UI under the standalone effect and frame-graph drivers", () => {
    // NA-26: those two loops render no UiRenderFrame on either backend, so
    // the combination refuses at generation instead of silently dropping
    // the chrome.
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEffectRenderer,
                    createEffectWrapper,
                    createEngine,
                    registerEffectRenderer,
                    startEngine,
                } from "@babylonjs/lite";

                async function main(): Promise<void> {
                    const engine = await createEngine({});
                    const effect = createEffectWrapper(engine, {
                        name: "fx",
                        fragmentWGSL: "@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return vec4<f32>(1.0);}",
                    });
                    const renderer = createEffectRenderer(engine, effect, {
                        name: "fx-renderer",
                    });
                    registerEffectRenderer(renderer);
                    const hint = document.createElement("div");
                    hint.textContent = "hint";
                    document.body.appendChild(hint);
                    await startEngine(engine);
                }

                void main();
            `),
        /Retained UI is not lowered under the standalone fullscreen-effect driver/,
    );

    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createFrameGraphContext,
                    registerFrameGraphContext,
                    startEngine,
                } from "@babylonjs/lite";

                async function main(): Promise<void> {
                    const engine = await createEngine({});
                    const context = createFrameGraphContext(engine);
                    registerFrameGraphContext(context);
                    const hint = document.createElement("div");
                    hint.textContent = "hint";
                    document.body.appendChild(hint);
                    await startEngine(engine);
                }

                void main();
            `),
        /Retained UI is not lowered under the standalone frame-graph driver/,
    );
});

test("presents a realm's retained UI over an effect renderer and refuses a realm frame graph", () => {
    // The idle callback takes the application realm, whose Window host
    // composites the UI over every renderer's canvas frames.
    const program = (registration: string) => `
        import {
            createEffectRenderer,
            createEffectWrapper,
            createEngine,
            createFrameGraphContext,
            registerEffectRenderer,
            registerFrameGraphContext,
            startEngine,
        } from "@babylonjs/lite";

        async function main(): Promise<void> {
            requestIdleCallback(() => {});
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            ${registration}
            const hint = document.createElement("div");
            hint.textContent = "hint";
            document.body.appendChild(hint);
            await startEngine(engine);
        }

        void main();
    `;
    const effect = compileSource(
        program(`const effect = createEffectWrapper(engine, {
            name: "fx",
            fragmentWGSL: "@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return vec4<f32>(1.0);}",
        });
        registerEffectRenderer(createEffectRenderer(engine, effect, { name: "fx-renderer" }));`),
    );
    for (const feature of ["platform:workers", "ui:rml", "renderer:effect"])
        assert.ok(effect.manifest.features.includes(feature), feature);
    // The engine holds a registered FrameGraphContext by address.
    assert.throws(
        () =>
            compileSource(
                program(
                    "registerFrameGraphContext(createFrameGraphContext(engine));",
                ),
            ),
        /A standalone frame graph .*does not yet run in an application realm/,
    );
});

test("keeps the packaged success arm of a nullable retained-canvas factory", () => {
    const result = compileSource(
        `
            import { createEngine } from "@babylonjs/lite";

            class PixelHud {
                private readonly canvas: HTMLCanvasElement;

                private constructor(bytes: Uint8Array) {
                    this.canvas = document.createElement("canvas");
                    this.canvas.width = bytes.length;
                    document.body.appendChild(this.canvas);
                }

                static async create(): Promise<PixelHud | null> {
                    try {
                        const response = await fetch(
                            "./fixtures/compiler-modules/static-geometry.json",
                        );
                        if (!response.ok) return null;
                        const bytes = new Uint8Array(await response.arrayBuffer());
                        return new PixelHud(bytes);
                    } catch {
                        return null;
                    }
                }

                clear(): void {
                    this.canvas.getContext("2d")!.clearRect(
                        0,
                        0,
                        this.canvas.width,
                        this.canvas.height,
                    );
                }
            }

            async function main(): Promise<void> {
                await createEngine({});
                const hud = await PixelHud.create();
                if (hud) hud.clear();
            }

            void main();
        `,
        { fileName: "test/compiler-retained-canvas-factory.ts" },
    );

    assert.match(result.cpp, /read_binary_file/);
    assert.match(result.cpp, /ui_create_element[^\n]*"canvas"/);
    assert.match(result.cpp, /ui_canvas_clear_rect/);
    assert.doesNotMatch(result.cpp, /response|\.ok/);
});

test("does not erase an application condition from a retained-canvas factory", () => {
    const result = compileSource(`
        class OptionalHud {
            private readonly canvas: HTMLCanvasElement;

            private constructor() {
                this.canvas = document.createElement("canvas");
            }

            static async create(enabled: boolean): Promise<OptionalHud | null> {
                try {
                    if (!enabled) return null;
                    return new OptionalHud();
                } catch {
                    return null;
                }
            }

            static async run(): Promise<void> {
                const hud = await OptionalHud.create(Math.random() > 0.5);
                if (hud) globalThis.close();
            }
        }

        void OptionalHud.run();
    `);
    assert.match(
        result.cpp,
        /if \(!\(v_fn\d+_enabled\)\) \{\s*co_return bblscene::OptionalHud\{\};/,
    );
    assert.match(
        result.cpp,
        /->canvas = std::pair<bbl::StoredEngine, bbl::UiElementHandle>\{/,
    );
});

test("reads the live local bounds retained with mesh geometry", () => {
    const result = compileSource(`
        import { createEngine, createSphere } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const mesh = createSphere(engine, { diameter: 1 });
            const minimum = mesh.boundMin ?? [-0.5, -0.5, -0.5];
            const maximum = mesh.boundMax ?? [0.5, 0.5, 0.5];
            mesh.position.x = minimum[0]! + maximum[0]!;
        }
        void main();
    `);

    assert.match(result.cpp, /mesh_bound_min_array/);
    assert.match(result.cpp, /mesh_bound_max_array/);
});

test("refuses to erase a DOM call on a receiver erasure cannot classify", () => {
    const program = (helper: string, call: string): string => `
        import { createEngine, createSceneContext, registerScene, startEngine } from "@babylonjs/lite";
        function active(): HTMLElement { return ${helper}; }
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            ${call};
            await registerScene(scene);
            await startEngine(engine);
        }
        void main();
    `;
    const calls = [
        `active().style.setProperty("color", "red")`,
        `active().classList.add("busy")`,
    ];
    // The focused element is native state: its style and classes are written.
    const lowered = calls.map(
        (call) =>
            compileSource(
                program("document.activeElement as HTMLElement", call),
            ).cpp,
    );
    assert.match(
        lowered[0]!,
        /bbl::ui_set_style_property\([^;]*"color", "red"\)/,
    );
    assert.match(lowered[1]!, /bbl::ui_set_class\([^;]*"busy", true\)/);
    // A value the program made is no element the call could act on.
    for (const call of calls)
        assert.throws(
            () =>
                compileSource(
                    program(`({ id: "x" } as unknown) as HTMLElement`, call),
                ),
            /A DOM helper must return a retained element/,
        );
});

test("erases nullable DOM-only class factories as absent native objects", () => {
    const result = compileSource(
        `
            import { createBox, createEngine } from "@babylonjs/lite";
            import { BrowserHud } from "./fixtures/compiler-modules/browser-hud.js";

            async function main() {
                const engine = await createEngine({});
                const hud = await BrowserHud.create();
                if (hud) {
                    hud.update(42);
                }
                createBox(engine);
            }
        `,
        { fileName: "test/compiler-multi-file-entry.ts" },
    );

    assert.match(result.cpp, /bbl::create_box/);
    assert.doesNotMatch(result.cpp, /fetch|BrowserHud|hud\.bin/);
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "browser-setup-erasure",
        ),
    );
});

test("lowers platform listeners through generic engine callbacks", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            await createEngine({});
            let state = 0;
            window.addEventListener("keydown", (event) => {
                if (event.repeat || event.isComposing) return;
                if (event.code.startsWith("Digit")) {
                    state += Number(event.code.slice(5));
                }
                if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
                    state += 3;
                }
                switch (event.code) {
                    case "ArrowLeft":
                        state -= 1;
                        break;
                    case "Space":
                        event.preventDefault();
                        state += 1;
                        break;
                }
            });
            window.addEventListener("keyup", (event) => {
                if (event.code === "Escape") state = 0;
            });
            window.addEventListener("pointerdown", () => {
                state = 1;
            });
            window.addEventListener("resize", () => {
                state += 2;
            });
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) state = 0;
            });
        }
    `);

    assert.match(result.cpp, /bbl::on_dom_keyboard\([^\n]*"keydown"/);
    assert.match(result.cpp, /bbl::on_dom_keyboard\([^\n]*"keyup"/);
    assert.match(result.cpp, /bbl::on_dom_pointer\([^\n]*"pointerdown"/);
    assert.match(result.cpp, /bbl::on_dom_pointer\([^\n]*"resize"/);
    assert.match(result.cpp, /bbl::on_visibility_change/);
    assert.match(result.cpp, /const bbl::PlatformKeyboardEvent&/);
    assert.match(result.cpp, /std::string_view/);
    assert.match(result.cpp, /\.code/);
    assert.match(result.cpp, /\.repeat/);
    assert.match(result.cpp, /string_starts_with/);
    assert.match(result.cpp, /string_slice/);
    assert.match(result.cpp, /\.shift_key/);
    assert.match(result.cpp, /\.ctrl_key/);
    assert.match(result.cpp, /\.alt_key/);
    assert.match(result.cpp, /\.meta_key/);
    assert.match(result.cpp, /\.is_composing/);
    assert.doesNotMatch(
        result.cpp,
        /addEventListener|preventDefault|document\.hidden/,
    );
});

test("registers a callback returned by a local factory as a platform listener", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            await createEngine({});
            let pressed = false;
            const onKey = (down: boolean) => (event: KeyboardEvent): void => {
                if (event.code === "Space") pressed = down;
            };
            const onDown = onKey(true);
            const onUp = onKey(false);
            window.addEventListener("keydown", onDown);
            window.addEventListener("keyup", onUp);
        }
    `);

    const down = result.cpp.match(
        /on_dom_keyboard\([^\n]+"keydown"[^\n]+bblscene::bbl_environment_\w+\{v_onDown_owner\}, (bblscene::\w+)/,
    );
    const up = result.cpp.match(
        /on_dom_keyboard\([^\n]+"keyup"[^\n]+bblscene::bbl_environment_\w+\{v_onUp_owner\}, (bblscene::\w+)/,
    );
    assert.ok(down && up);
    assert.equal(
        down[1],
        up[1],
        "listeners share their adapter body with separate owners",
    );
    assert.match(
        result.cpp,
        /\(\*v_onDown_owner\)\(bbl::js::EventRef<const bbl::PlatformKeyboardEvent>\(v_bblite_dom_event_\d+\)\)/,
    );
});

test("removes a dynamically registered platform listener by callback identity", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        class Dragger {
            private active = false;
            private readonly onKey = (event: KeyboardEvent): void => {
                if (this.active && event.code === "KeyR") {
                    this.active = false;
                }
            };
            begin(): void {
                this.active = true;
                window.addEventListener("keydown", this.onKey);
            }
            end(): void {
                this.active = false;
                window.removeEventListener("keydown", this.onKey);
            }
        }

        async function main() {
            await createEngine({});
            const dragger = new Dragger();
            window.addEventListener("mousedown", () => {
                dragger.begin();
                dragger.end();
            });
        }
    `);

    const registration = result.cpp.match(
        /bbl::on_dom_keyboard\([^,]+, bbl::DomEventTarget::window\(\), "keydown", (\d+)u,/,
    );
    assert.ok(registration);
    assert.match(
        result.cpp,
        new RegExp(
            `bbl::off_dom_keyboard\\([^,]+, bbl::DomEventTarget::window\\(\\), "keydown", ${registration[1]}u, false\\)`,
        ),
    );
    assert.doesNotMatch(result.cpp, /bbl::on_dom_keyboard\([^;]+, \[&\]/);
});

test("retained platform listeners keep live scene aliases", () => {
    const result = compileSource(`
        import {
            createArcRotateCamera,
            createEngine,
            createSceneContext,
            type SceneContext,
        } from "@babylonjs/lite";

        class Picker {
            private readonly scene: SceneContext;
            private readonly onMove = (): void => {
                const camera = this.scene.camera;
                if (camera) camera.alpha += 0.1;
            };
            constructor(scene: SceneContext) {
                this.scene = scene;
                window.addEventListener("mousemove", this.onMove);
            }
        }

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            new Picker(scene);
            scene.camera = createArcRotateCamera(
                0,
                1,
                5,
                { x: 0, y: 0, z: 0 },
            );
        }
    `);

    assert.match(
        result.cpp,
        /bbl::on_dom_pointer\([^;]*make_closure\(bblscene::bbl_environment_\w+\{v_bblite_class_field_scene_\d+, std::ref\(v_engine\)\}, bblscene::\w+/,
    );
});

test("maps canvas pointer offsets to its platform-relative coordinates", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            await createEngine(canvas);
            canvas.addEventListener("pointerdown", (event) => {
                const state = event.offsetX + event.clientX + event.offsetY + event.clientY + event.button;
                canvas.dataset.pointerState = \`\${state}\`;
            });
        }
    `);

    assert.match(result.cpp, /bbl::on_dom_pointer\([^\n]*"pointerdown"/);
    assert.equal((result.cpp.match(/\.client_x/g) ?? []).length, 2);
    assert.equal((result.cpp.match(/\.client_y/g) ?? []).length, 2);
    assert.match(result.cpp, /\.button/);
    assert.doesNotMatch(result.cpp, /offset[XY]/);
    assert.match(result.cpp, /\[\[maybe_unused\]\] double v_fn\d+_state/);
});

test("projects render-canvas focus into native host state", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            canvas.focus();
            void engine;
        }
    `);

    assert.match(result.cpp, /bbl::focus_canvas\(v_engine\)/);
});

test("a record field holding the erased render canvas focuses and locks the render surface", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        interface Deps { canvas: HTMLCanvasElement }
        async function main(deps: Deps) {
            const engine = await createEngine(deps.canvas);
            deps.canvas.focus();
            deps.canvas.addEventListener("click", () => { void deps.canvas.requestPointerLock(); });
            void engine;
        }
        void main({ canvas: document.getElementById("renderCanvas") as HTMLCanvasElement });
    `);

    assert.match(result.cpp, /bbl::focus_canvas\(v_fn\d+_engine\)/);
    assert.match(result.cpp, /bbl::request_pointer_lock\(v_fn\d+_engine\)/);
});

test("lowers dynamic engine canvas cursor writes", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            await createEngine(canvas);
            let armed = false;
            canvas.addEventListener("pointerdown", () => {
                armed = !armed;
                canvas.style.cursor = armed ? "crosshair" : "";
            });
        }
    `);

    assert.match(result.cpp, /bbl::set_canvas_cursor/);
    assert.match(result.cpp, /"crosshair"/);
    assert.doesNotMatch(result.cpp, /style\.cursor/);
});

test("lowers focusable-canvas FPS controls and pointer lock", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            await createEngine(canvas);
            let key = "";
            let locked = false;
            let yaw = 0;
            let wheel = 0;
            document.addEventListener("pointerlockchange", () => {
                locked = document.pointerLockElement === canvas;
            });
            canvas.addEventListener("keydown", (event) => {
                key = event.code;
            });
            canvas.addEventListener("keyup", () => {
                key = "";
            });
            canvas.addEventListener("pointerdown", (event) => {
                if ((event.buttons & 2) && document.pointerLockElement !== canvas) {
                    void canvas.requestPointerLock();
                }
            });
            canvas.addEventListener("pointerup", (event) => {
                if (!(event.buttons & 2) && document.pointerLockElement === canvas) {
                    document.exitPointerLock();
                }
            });
            canvas.addEventListener("pointermove", (event) => {
                if (locked) yaw += event.movementX + event.movementY;
            });
            canvas.addEventListener("wheel", (event) => {
                event.preventDefault();
                wheel += event.deltaY;
            });
            canvas.addEventListener("pointercancel", () => {
                locked = false;
            });
        }
    `);

    assert.match(result.cpp, /bbl::on_dom_keyboard\([^\n]*"keydown"/);
    assert.match(result.cpp, /bbl::on_dom_keyboard\([^\n]*"keyup"/);
    assert.match(result.cpp, /bbl::on_dom_pointer\([^\n]*"pointermove"/);
    assert.match(result.cpp, /bbl::on_dom_pointer\([^\n]*"wheel"/);
    assert.match(result.cpp, /bbl::on_dom_pointer\([^\n]*"pointercancel"/);
    assert.match(result.cpp, /bbl::on_pointer_lock_change/);
    assert.match(result.cpp, /bbl::request_pointer_lock/);
    assert.match(result.cpp, /bbl::exit_pointer_lock/);
    assert.match(result.cpp, /\.pointer_locked/);
    assert.match(result.cpp, /\.movement_x/);
    assert.match(result.cpp, /\.movement_y/);
    assert.match(result.cpp, /\.delta_y/);
    assert.doesNotMatch(
        result.cpp,
        /addEventListener|requestPointerLock|exitPointerLock|preventDefault/,
    );
});

test("lowers document mousemove for pointer-lock camera controls", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        await createEngine(canvas);
        let locked = false;
        let yaw = 0;
        document.addEventListener("pointerlockchange", () => {
            locked = document.pointerLockElement === canvas;
        });
        document.addEventListener("mousemove", (event) => {
            if (!locked) return;
            yaw -= event.movementX * 0.002;
        });
    `);

    assert.match(result.cpp, /bbl::on_dom_pointer\([^\n]*"mousemove"/);
    assert.match(result.cpp, /\.movement_x \* 0\.002/);
    assert.doesNotMatch(result.cpp, /addEventListener|movementX/);
});

test("lowers canvas clicks with discarded async audio initialization", () => {
    const result = compileSource(`
        import {
            createAudioEngineAsync,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            await createEngine(canvas);
            canvas.addEventListener("click", () => {
                void canvas.requestPointerLock();
                void (async () => {
                    const audio = await createAudioEngineAsync();
                    audio.audioContext.createGain();
                })();
            });
        }
    `);

    assert.match(result.cpp, /bbl::on_dom_pointer\([^\n]*"click"/);
    assert.doesNotMatch(result.cpp, /bbl::on_dom_pointer\([^\n]*"pointerdown"/);
    assert.match(result.cpp, /bbl::request_pointer_lock/);
    assert.match(result.cpp, /bbl::pal::audio_create_context/);
    assert.ok(result.manifest.features.includes("audio:engine"));
});

test("keeps callback-local declarations inside platform listeners", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            await createEngine({});
            let on = true;
            let state = 0;
            const toggle = {
                toggle(): boolean {
                    on = !on;
                    return on;
                },
            };
            window.addEventListener("keydown", (event) => {
                if (event.key === "c") {
                    const nowOn = toggle.toggle();
                    state = nowOn ? 1 : 0;
                }
            });
        }
    `);

    const listener = result.cpp.indexOf("bbl::on_dom_keyboard");
    const localDeclaration = result.cpp.search(/bool v_\w*nowOn =/);
    assert.ok(listener >= 0);
    assert.ok(localDeclaration < result.cpp.indexOf("int main()"));
    assert.match(
        result.cpp,
        /bbl::on_dom_keyboard\([^\n]+bblscene::v_bblite_closure_body_\d+/,
    );
});

test("compiles Babylon Lite scene 51 premultiplied soft-sprite grid", () => {
    const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene51.ts";
    const result = compileSource(readFileSync(resolve(sourcePath), "utf8"), {
        fileName: sourcePath,
    });

    assert.equal(result.manifest.engineMsaaSamples, 1);
    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "sprite:2d",
        "renderer:sprite",
    ]);
    assert.equal(result.manifest.assets.length, 1);
    assert.equal(result.manifest.assets[0]!.kind, "sprite-atlas");
    assert.match(result.cpp, /LoadSpriteAtlasOptions\{[^}]*true, true,/);
    assert.match(result.cpp, /sprite_blend_premultiplied\(\)/);
    assert.equal(result.manifest.pureSpriteVertex, true);
    assert.match(
        result.cpp,
        /SpriteRendererOptions\{\{v_layer\}, true, bbl::Color4\{static_cast<float>\(0\.07\), static_cast<float>\(0\.08\), static_cast<float>\(0\.12\), static_cast<float>\(1\.0\)\}\}/,
    );
});

test("compiles Babylon Lite scene 13 PBR spheres grid", () => {
    const source = readFileSync(
        resolve("corpus/babylon-lite/lab/lite/src/lite/scene13.ts"),
        "utf8",
    );
    const result = compileSource(source, {
        fileName: "corpus/babylon-lite/lab/lite/src/lite/scene13.ts",
    });

    assert.deepEqual(result.manifest.features, [
        "core",
        "backend:sdl",
        "camera:arc-rotate",
        "camera:default",
        "environment:ibl",
        "environment:env",
        "background:ground",
        "light:hemispheric",
        "loader:gltf",
        "renderer:scene",
    ]);
    assert.deepEqual(
        result.manifest.assets.map(({ source, kind }) => ({ source, kind })),
        [
            {
                source: "https://assets.babylonjs.com/meshes/PBR_Spheres.glb",
                kind: "gltf",
            },
            {
                source: "https://assets.babylonjs.com/core/environments/environmentSpecular.env",
                kind: "environment",
            },
            {
                source: "https://assets.babylonjs.com/core/environments/backgroundGround.png",
                kind: "texture",
            },
            {
                source: pinnedAssetUrl(
                    "packages/babylon-lite/assets/brdf-lut.png",
                ),
                kind: "texture",
            },
        ],
    );
    assert.match(result.cpp, /PBR_Spheres\.glb/);
    assert.doesNotMatch(result.cpp, /skipSkybox/);
});

test("shares mutable class fields across retained callbacks", () => {
    const result = compileSource(`
        type State = "rest" | "walk";

        class Controller {
            private _state: State = "rest";
            private readonly _handlers = new Set<() => void>();

            constructor() {
                this._handlers.add(() => {
                    if (this._state === "rest") this._state = "walk";
                });
                this._handlers.add(() => {
                    if (this._state === "walk") this._state = "rest";
                });
            }

            run(): void {
                for (const handler of this._handlers) handler();
            }

            read(): State {
                return this._state;
            }
        }

        const controller = new Controller();
        controller.run();
        const state = controller.read();
    `);

    const state = result.cpp.match(
        /auto (v_bblite_class_field__state_\d+) = bbl::js::make_gc_shared<bblscene::State>\(bblscene::State::rest\);/,
    );
    assert.ok(state);
    assert.ok(
        (result.cpp.match(new RegExp(`\\(\\*${state[1]}\\)`, "g")) ?? [])
            .length >= 5,
        "both callbacks and the final read share one class-field cell",
    );
});

test("a function whose nested closure reads a canvas back is not a Canvas2D helper", () => {
    // Only a helper whose own body reads the canvas back, returning the
    // string, is run in the browser at generation; an entry that captures
    // a canvas later in a callback is lowered like any other function.
    const source = [
        'import { createEngine, createSceneContext, registerScene, startEngine } from "babylon-lite";',
        "",
        "async function main(): Promise<void> {",
        '    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;',
        "    const engine = await createEngine(canvas);",
        "    const scene = createSceneContext(engine);",
        '    const shots = { capture(): string { return canvas.toDataURL("image/png"); } };',
        "    (window as unknown as { shots: unknown }).shots = shots;",
        "    await registerScene(scene);",
        "    await startEngine(engine);",
        "}",
        "",
        "void main().catch((error) => {",
        "    console.error(error);",
        "    throw error;",
        "});",
    ].join("\n");
    const { report } = surveySource(source, { fileName: "input.ts" });
    assert.equal(report.terminal, undefined);
    assert.equal(report.complete, true);
});

test("bakes a Canvas2D helper reached through an inlined parameter", () => {
    // The helper's argument is a bound parameter rather than a literal, so
    // the fold is what turns the name back into the text the browser is
    // handed -- and the two calls draw different glyphs, so they bake to
    // different assets rather than sharing one.
    const source = [
        'import { createEngine, createSceneContext, createStandardMaterial, loadTexture2D, registerScene, startEngine } from "babylon-lite";',
        'import type { EngineContext, StandardMaterialProps } from "babylon-lite";',
        "",
        "function labelTextureUrl(text: string): string {",
        '    const canvas = document.createElement("canvas");',
        "    canvas.width = 32;",
        "    canvas.height = 16;",
        '    const ctx = canvas.getContext("2d");',
        "    if (!ctx) {",
        '        throw new Error("needs a 2D canvas context");',
        "    }",
        '    ctx.fillStyle = "black";',
        "    ctx.fillText(text, 4, 12);",
        '    return canvas.toDataURL("image/png");',
        "}",
        "",
        "async function label(engine: EngineContext, text: string): Promise<StandardMaterialProps> {",
        "    const material = createStandardMaterial();",
        "    material.diffuseTexture = await loadTexture2D(engine, labelTextureUrl(text), {});",
        "    material.alphaCutOff = 0.25;",
        "    return material;",
        "}",
        "",
        "async function main(): Promise<void> {",
        '    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;',
        "    const engine = await createEngine(canvas);",
        "    const scene = createSceneContext(engine);",
        '    await label(engine, "-");',
        '    await label(engine, "+");',
        "    await registerScene(scene);",
        "    await startEngine(engine);",
        "}",
        "",
        "main();",
    ].join("\n");
    const result = compileSource(source, { fileName: "input.ts" });
    const inlineAssets = result.manifest.assets.filter(
        (asset) => asset.kind === "texture",
    );
    assert.equal(inlineAssets.length, 2);
    assert.notEqual(inlineAssets[0]!.output, inlineAssets[1]!.output);
    // The setter is one record store: `alphaCutOff` is not a Standard
    // composition key, and every composed Standard fragment already
    // carries the discard the value feeds.
    const materials = [
        ...result.cpp.matchAll(
            /auto (\w+) = bbl::create_standard_material\((\w+)\);/g,
        ),
    ];
    assert.equal(materials.length, 2);
    for (const [, material, owner] of materials) {
        assert.ok(
            owner === "v_engine" ||
                result.cpp.includes(`auto& ${owner} = v_engine;`),
        );
        assert.ok(
            result.cpp.includes(
                `bbl::handle_at(${owner}.materials, ${material}).alpha_cutoff = 0.25f;`,
            ),
        );
    }
    assert.equal(result.cpp.match(/\.alpha_cutoff = 0\.25f;/g)?.length, 2);
});

test("reaches the flow-graph feature for an asset's runtimes and pointer picking", () => {
    // The Calculator demo's two touches of the subsystem: waiting for the
    // asset's runtimes (the generated graph attached at add) and enabling
    // the pinned pointer bridge, which picks through the GPU id buffer.
    const result = compileSource(`
        import {
            createEngine,
            createSceneContext,
            enableFlowGraphPointerPicking,
            loadGltf,
        } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const asset = await loadGltf(engine, "model.glb");
            await asset.flowGraphRuntimes;
            await enableFlowGraphPointerPicking(scene);
        }
        void main();
    `);
    assert.ok(result.manifest.features.includes("flow-graph:interactivity"));
    assert.ok(result.manifest.features.includes("picking:gpu"));
    assert.match(result.cpp, /bbl::enable_flow_graph_pointer_picking\(/);
});

test("fixed render targets snapshot runtime canvas dimensions", () => {
    const result = compileSource(
        `
        import {createEngine, createRenderTarget} from 'babylon-lite';
        async function main() {
            const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const target = createRenderTarget({format: engine.format, size: {width: canvas.width, height: Math.floor(canvas.height / 2)}});
        }
        main();
    `,
        { width: 1234, height: 678 },
    );
    assert.match(
        result.cpp,
        /render_target_dimension\(static_cast<double>\(v_engine.options.width\)\)/,
    );
    assert.match(
        result.cpp,
        /render_target_dimension\(std::floor\([^;]*v_engine.options.height/,
    );
});
