import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("details, select options and output values retain their source properties", () => {
    const result = compileSource(`import {createEngine} from "@babylonjs/lite";
        await createEngine({});
        const details = document.createElement("details");
        details.open = true;
        const summary = document.createElement("summary");
        summary.textContent = "Settings";
        const select = document.createElement("select");
        const option = document.createElement("option");
        option.value = "128";
        option.textContent = "128";
        option.selected = true;
        select.appendChild(option);
        const output = document.createElement("output");
        output.value = "128";
        select.addEventListener("change", () => { output.value = select.value; });
        details.append(summary, select, output);
        document.body.append(details);
        if (!details.open || !option.selected || output.value !== "128") throw new Error("state");`);
    assert.match(result.cpp, /ui_set_boolean_attribute\([^;]+"open", true\)/);
    assert.match(result.cpp, /ui_set_selected\(/);
    assert.match(result.cpp, /ui_get_selected\(/);
    assert.match(result.cpp, /ui_get_form_value\(/);
    assert.match(
        result.cpp,
        /on_dom_pointer\([^;]+DomEventTarget::node\(v_select\.value\), "change", \d+u, bbl::js::make_closure\(/,
    );
});

test("native Ocean controls preserve selection, output, disclosure and authored identity", (t) => {
    runRmlUiFixture(t, "ui-ocean-controls");
});

test("boolean control properties accept live comparisons", () => {
    const result = compileSource(`import {createEngine} from "@babylonjs/lite";
        await createEngine({});
        const input=document.createElement("input");input.type="checkbox";
        const option=document.createElement("option");
        const details=document.createElement("details");
        input.addEventListener("change",()=>{
            const value=Number(input.value);
            option.selected=value===128;
            input.checked=value>0;
            details.open=value!==0;
            input.disabled=value<0;
        });`);
    assert.match(result.cpp, /ui_set_selected\([^;]+== 128/);
    assert.match(result.cpp, /ui_set_checked\([^;]+> 0/);
    assert.match(result.cpp, /ui_set_boolean_attribute\([^;]+"open"[^;]+!= 0/);
    assert.match(
        result.cpp,
        /ui_set_boolean_attribute\([^;]+"disabled"[^;]+< 0/,
    );
});

test("range bounds and increments survive helper calls and reflect as strings", () => {
    const result = compileSource(`import {createEngine} from "@babylonjs/lite";
        await createEngine({});
        function range(min: number, max: number, step: number) {
            const input = document.createElement("input");
            input.type = "range";
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            document.body.append(input);
            if (input.min !== "-0.5" || input.max !== "0.5" || input.step !== "0.001")
                throw new Error("Range bounds changed");
        }
        range(-0.5, 0.5, 0.001);`);
    for (const name of ["min", "max", "step"]) {
        assert.match(
            result.cpp,
            new RegExp(`ui_set_attribute\\([^;]+"${name}"`),
        );
        assert.match(
            result.cpp,
            new RegExp(`ui_get_attribute\\([^;]+"${name}"`),
        );
    }
});

test("details toggle listeners join shared DOM dispatch with removal", () => {
    const result = compileSource(`import {createEngine} from "@babylonjs/lite";
        await createEngine({});
        const details = document.createElement("details");
        let toggles = 0;
        const onToggle = (): void => { toggles += details.open ? 1 : 0; };
        details.addEventListener("toggle", onToggle);
        details.removeEventListener("toggle", onToggle);
        details.open = toggles === 0;`);
    assert.match(result.cpp, /on_dom_pointer\([^;]+"toggle"/);
    assert.match(result.cpp, /off_dom_pointer\([^;]+"toggle"/);
});

test("a summary click on the Window display toggles the realm's details once per click", (t) => {
    // test/fixtures/window-details-toggle-check.cpp clicks the summary three
    // times through the Window display; the realm's toggle listener reads the
    // disclosure and writes an output, a status text and its hidden flag.
    const result = compileSource(`
        let trace = "";
        const log = document.createElement("div");
        log.id = "log";
        document.body.append(log);
        const details = document.createElement("details");
        details.style.cssText = "position:absolute;left:0px;top:0px;width:400px;margin:0;";
        const summary = document.createElement("summary");
        summary.textContent = "Pose";
        summary.style.cssText = "display:block;height:200px;";
        const value = document.createElement("output");
        value.value = "0.00";
        const status = document.createElement("p");
        status.hidden = true;
        status.textContent = "Unavailable";
        details.append(summary, value, status);
        document.body.append(details);
        let toggles = 0;
        const update = (): void => {
            toggles++;
            if (details.open) {
                value.value = \`\${toggles}.00\`;
                status.textContent = \`toggle \${toggles}\`;
                status.hidden = toggles > 1;
                trace += "o" + value.value + (status.hidden ? "h" : "s");
            } else trace += "c";
            log.textContent = trace;
            if (toggles === 3) setTimeout(() => globalThis.close(), 0);
        };
        details.addEventListener("toggle", update);
        document.addEventListener("toggle", () => { trace += "!"; });
    `);
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.match(result.cpp, /run_window_application/);
    const output = resolve("artifacts/window-details-toggle");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "program.hpp"), result.cpp);
    emitUpstreamGenerated(output, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "window-details-toggle", {
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
