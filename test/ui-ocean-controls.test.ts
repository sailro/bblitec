import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
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
    assert.match(result.cpp, /ui_on_event\([^;]+"change"/);
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
