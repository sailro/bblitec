import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("checkbox properties and change listeners use retained input state", () => {
    const source = `import {createEngine} from "@babylonjs/lite";
        await createEngine({});
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = true;
        const label = document.createElement("span");
        input.addEventListener("change", () => {
            label.textContent = input.checked ? "on" : "off";
        });
        document.body.append(input, label);`;
    const result = compileSource(source);
    assert.match(result.cpp, /ui_set_checked\([^;]+true\)/);
    assert.match(result.cpp, /ui_get_checked\(/);
    assert.match(
        result.cpp,
        /on_dom_pointer\([^;]+DomEventTarget::node\(v_input\.value\), "change", \d+u, bbl::js::make_closure\(/,
    );
    assert.doesNotMatch(result.cpp, /ui_set_file_input/);
    assert.throws(
        () =>
            compileSource(
                source.replace(
                    'createElement("input")',
                    'createElement("div")',
                ),
            ),
        /checked requires an input/,
    );
});

test("checked takes any value as ToBoolean converts it", () => {
    // A parsed draft's member is a document value: truthy is checked.
    const result = compileSource(`import {createEngine} from "@babylonjs/lite";
        await createEngine({});
        type Key = "ssao" | "bloom";
        const features: { key: Key }[] = [{ key: "ssao" }, { key: "bloom" }];
        const draft: Partial<Record<Key, boolean>> = JSON.parse('{"ssao":true}');
        for (const feature of features) {
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = draft[feature.key] ?? false;
            document.body.append(input);
        }`);
    assert.match(result.cpp, /ui_set_checked\([^;]*truthy[^;]*\)/);
});

test("native checkbox edits retain current checked state before input and change", (t) => {
    runRmlUiFixture(t, "ui-checkbox");
});
