import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { compileSource, CompileError } from "../src/compiler.js";
import type { NativeHostUi, NativeHostUiNode } from "../src/compiler/types.js";

const source = `import {createEngine,startEngine} from '@babylonjs/lite';
async function main() {const engine=await createEngine({});await startEngine(engine);}main();`;
/** A panel whose rows are fractional grids of a label, a range and a value. */
const host = (): NativeHostUi => {
    const row = (id: string): NativeHostUiNode => ({
        tag: "div",
        attributes: {
            class: "row",
            style: "display: grid; grid-template-columns: 70px 1fr 48px; align-items: center; gap: 8px;",
        },
        children: [
            { tag: "label", attributes: { for: id }, text: id },
            {
                tag: "input",
                attributes: {
                    id,
                    type: "range",
                    min: "0",
                    max: "1",
                    step: "0.01",
                    value: "1",
                    style: "width: 100%;",
                },
            },
            { tag: "span", attributes: { class: "val" }, text: "1.00" },
        ],
    });
    return {
        sourcePath: "test/ui-fractional-grid.test.ts",
        elements: [
            {
                tag: "div",
                attributes: { id: "panel", style: "display: flex; gap: 12px;" },
                children: [
                    {
                        tag: "textarea",
                        attributes: {
                            style: "width: 280px; height: 140px; padding: 6px; box-sizing: border-box;",
                        },
                        text: "text",
                    },
                    {
                        tag: "div",
                        attributes: {
                            style: "display: flex; flex-direction: column; width: 240px;",
                        },
                        children: [
                            row("opacity"),
                            row("red"),
                            {
                                tag: "div",
                                children: [
                                    {
                                        tag: "span",
                                        text: "Drag canvas to move",
                                    },
                                    { tag: "br" },
                                    {
                                        tag: "span",
                                        text: "Scroll wheel to scale",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    };
};

test("fractional host grids preserve explicit track order and form border-box sizing", () => {
    const result = compileSource(source, { nativeHostUi: host() });
    assert.match(result.cpp, /grid-template-columns:\s*70px 1fr 48px/);
    assert.match(result.cpp, /box-sizing:\s*border-box/);
    assert.match(result.cpp, /Drag canvas to move/);
    assert.match(result.cpp, /Scroll wheel to scale/);
    assert.match(
        readFileSync("native/src/pal_ui_defaults.hpp", "utf8"),
        /input\[type=range\]/,
    );
});

test("fractional host grids admit implicit rows and minimum tracks while refusing negative tracks", () => {
    for (const mutation of [
        "extra-child",
        "missing-child",
        "minmax",
        "negative",
        "rows",
    ]) {
        const ui = host();
        const element = (node: NativeHostUiNode | undefined) => {
            assert.ok(node?.tag !== undefined);
            return node;
        };
        const row = element(
            element(element(ui.elements[0]).children![1]).children![0],
        );
        if (mutation === "extra-child")
            row.children!.push({ tag: "span", text: "extra" });
        else if (mutation === "missing-child") row.children!.pop();
        else if (mutation === "minmax")
            row.attributes!.style = row.attributes!.style!.replace(
                "1fr",
                "minmax(0,1fr)",
            );
        else if (mutation === "negative")
            row.attributes!.style = row.attributes!.style!.replace(
                "1fr",
                "-1fr",
            );
        else row.attributes!.style += ";grid-template-rows:repeat(1,20px);";
        if (mutation === "negative")
            assert.throws(
                () => compileSource(source, { nativeHostUi: ui }),
                CompileError,
                mutation,
            );
        else
            assert.match(
                compileSource(source, { nativeHostUi: ui }).cpp,
                /grid-template-columns/,
            );
    }
});
