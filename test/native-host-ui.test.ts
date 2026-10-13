import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeHostUiElements,
    readNativeHostUi,
} from "../src/native-host-ui.js";

const companion = (name: string, elements: unknown[]): string => {
    mkdirSync("artifacts/native-host-ui", { recursive: true });
    const path = `artifacts/native-host-ui/${name}.json`;
    writeFileSync(path, JSON.stringify({ elements }));
    return path;
};

test("host UI companions interleave text nodes with elements in document order", () => {
    const host = readNativeHostUi(
        companion("text-nodes", [
            {
                tag: "a",
                attributes: { class: "credit" },
                children: [{ tag: "b", text: "Title" }, { text: " by Author" }],
            },
            { text: "after" },
        ]),
    );
    const credit = host.elements[0];
    assert.ok(credit && credit.tag === "a");
    assert.deepEqual(credit.children, [
        { tag: "b", text: "Title" },
        { text: " by Author" },
    ]);
    assert.deepEqual(host.elements[1], { text: "after" });
    assert.deepEqual(
        [...nativeHostUiElements(host.elements)].map((element) => element.tag),
        ["a", "b"],
    );
    const cpp = compileSource(
        `import { createEngine } from "@babylonjs/lite";
        await createEngine({});`,
        { nativeHostUi: host },
    ).cpp;
    const bold = cpp.indexOf('"Title"');
    const tail = cpp.search(/bbl::ui_append_text\([^;]*" by Author"\);/);
    assert.ok(bold >= 0 && tail > bold, "text follows its preceding element");
    assert.match(cpp, /bbl::ui_append_text\([^,]+, \{\}, "after"\);/);
});

test("host UI text nodes refuse other keys and non-string text", () => {
    assert.throws(
        () =>
            readNativeHostUi(
                companion("text-extra", [{ text: "x", attributes: {} }]),
            ),
        /elements\[0\] \(a text node\): unknown key 'attributes'/,
    );
    assert.throws(
        () => readNativeHostUi(companion("text-number", [{ text: 1 }])),
        /elements\[0\] needs a string tag, or text alone/,
    );
});
