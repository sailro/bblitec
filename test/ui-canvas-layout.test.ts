import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { withBrowserPage } from "../src/browser-harness.js";
import { doubleLiteral, stringLiteral } from "../src/cpp-literals.js";
import { htmlPageServer } from "./html-page-server.js";
import { runRmlUiFixture } from "./native-fixture.js";

interface CanvasState {
    style: string;
    width?: number;
    height?: number;
}

interface CanvasCase {
    name: string;
    parent: string;
    states: readonly CanvasState[];
}

const fixed = "width:240px;height:160px;";
const cases: readonly CanvasCase[] = [
    {
        name: "inline-explicit",
        parent: fixed,
        states: [{ style: "width:40px;height:40px;" }],
    },
    {
        name: "inline-block-explicit",
        parent: fixed,
        states: [{ style: "display:inline-block;width:80px;height:40px;" }],
    },
    {
        name: "block-explicit",
        parent: fixed,
        states: [{ style: "display:block;width:80px;height:40px;" }],
    },
    { name: "inline-natural", parent: fixed, states: [{ style: "" }] },
    {
        name: "inline-custom-backing",
        parent: fixed,
        states: [{ style: "", width: 120, height: 60 }],
    },
    {
        name: "auto-height",
        parent: fixed,
        states: [{ style: "width:80px;height:auto;" }],
    },
    {
        name: "auto-width",
        parent: fixed,
        states: [{ style: "width:auto;height:30px;" }],
    },
    {
        name: "percentages",
        parent: fixed,
        states: [{ style: "width:50%;height:25%;" }],
    },
    {
        name: "percentage-auto-height",
        parent: fixed,
        states: [{ style: "width:50%;height:auto;" }],
    },
    {
        name: "auto-width-percentage-height",
        parent: fixed,
        states: [{ style: "width:auto;height:25%;" }],
    },
    {
        name: "zero-backing-explicit",
        parent: fixed,
        states: [{ style: "width:40px;height:40px;", width: 0, height: 0 }],
    },
    {
        name: "zero-width-auto",
        parent: fixed,
        states: [{ style: "", width: 0, height: 100 }],
    },
    {
        name: "zero-height-auto",
        parent: fixed,
        states: [{ style: "", width: 100, height: 0 }],
    },
    {
        name: "zero-backing-auto",
        parent: fixed,
        states: [{ style: "", width: 0, height: 0 }],
    },
    {
        name: "zero-width-css-width",
        parent: fixed,
        states: [{ style: "width:80px;height:auto;", width: 0, height: 100 }],
    },
    {
        name: "zero-height-css-height",
        parent: fixed,
        states: [{ style: "width:auto;height:40px;", width: 100, height: 0 }],
    },
    ...(
        [
            ["inline-block", "display:inline-block;"],
            ["float", "float:left;"],
            ["absolute", "position:absolute;left:0;top:0;"],
            ["inline-flex", "display:inline-flex;"],
        ] as const
    ).flatMap(([name, parent]): CanvasCase[] => [
        {
            name: `shrink-${name}-explicit`,
            parent,
            states: [{ style: "display:block;width:80px;height:40px;" }],
        },
        {
            name: `shrink-${name}-natural`,
            parent,
            states: [{ style: "display:block;", width: 120, height: 60 }],
        },
    ]),
    {
        name: "shrink-percentage-child",
        parent: "display:inline-block;",
        states: [{ style: "display:block;width:50%;height:40px;" }],
    },
    {
        name: "shrink-zero-backing",
        parent: "display:inline-block;",
        states: [
            {
                style: "display:block;width:40px;height:40px;",
                width: 0,
                height: 0,
            },
        ],
    },
    {
        name: "shrink-content-box-edges",
        parent: "display:inline-block;padding:5px;border:2px solid;",
        states: [
            {
                style: "display:block;width:80px;height:40px;padding:3px;border:1px solid;",
            },
        ],
    },
    {
        name: "shrink-border-box",
        parent: "display:inline-block;",
        states: [
            {
                style: "display:block;box-sizing:border-box;width:80px;height:40px;padding:3px;border:1px solid;",
            },
        ],
    },
    {
        name: "shrink-max-width",
        parent: "display:inline-block;",
        states: [
            { style: "display:block;width:160px;max-width:80px;height:40px;" },
        ],
    },
    {
        name: "live-explicit-auto-zero",
        parent: "display:inline-block;",
        states: [
            {
                style: "display:block;width:80px;height:40px;",
                width: 120,
                height: 60,
            },
            { style: "display:block;" },
            { style: "display:block;", width: 0, height: 0 },
            { style: "display:block;width:40px;height:40px;" },
        ],
    },
    {
        name: "live-inline-backing",
        parent: fixed,
        states: [
            { style: "", width: 120, height: 60 },
            { style: "", width: 240 },
            { style: "width:50%;height:auto;", height: 120 },
            { style: "width:40px;height:40px;" },
        ],
    },
];

test("native canvas sizing matches browser replaced and shrink-to-fit layout", async (t) => {
    const measured = await withBrowserPage(
        htmlPageServer(
            "<!doctype html><style>html,body{margin:0;padding:0}</style><body></body>",
        ),
        {
            serverName: "canvas layout",
            headless: true,
            viewport: { width: 640, height: 480 },
        },
        async (page, origin) => {
            await page.goto(origin);
            return page.evaluate(
                (rows) =>
                    rows.map((row) => {
                        const host = document.createElement("div");
                        host.style.cssText =
                            "position:relative;width:400px;height:300px;font-size:0;line-height:0;";
                        const parent = document.createElement("div");
                        parent.style.cssText = row.parent;
                        const canvas = document.createElement("canvas");
                        host.append(parent);
                        parent.append(canvas);
                        document.body.append(host);
                        const states = row.states.map((state) => {
                            canvas.style.cssText =
                                "vertical-align:top;" + state.style;
                            if (state.width !== undefined)
                                canvas.width = state.width;
                            if (state.height !== undefined)
                                canvas.height = state.height;
                            const outer = parent.getBoundingClientRect();
                            const inner = canvas.getBoundingClientRect();
                            return [
                                outer.width,
                                outer.height,
                                inner.left - outer.left,
                                inner.top - outer.top,
                                inner.width,
                                inner.height,
                            ];
                        });
                        host.remove();
                        return { name: row.name, states };
                    }),
                cases,
            );
        },
    );
    const directory = resolve("artifacts/ui-canvas-layout");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "browser.json"),
        JSON.stringify(measured, null, 2) + "\n",
    );
    const states = cases.flatMap((row, index) => {
        const reference = measured[index];
        assert.ok(reference);
        assert.equal(reference.name, row.name);
        return row.states.map((state, phase) => {
            const expected = reference.states[phase]!;
            assert.equal(expected.length, 6);
            assert.ok(expected.every(Number.isFinite));
            return `{${stringLiteral(row.name)}, ${phase === 0}, ${stringLiteral(row.parent)}, ${stringLiteral(state.style)}, ${state.width ?? -1}, ${state.height ?? -1}, {${expected.map(doubleLiteral).join(", ")}}}`;
        });
    });
    writeFileSync(
        join(directory, "cases.hpp"),
        `
#pragma once
#include <array>
#include <string_view>
struct CanvasLayoutCase {
    std::string_view name;
    bool first;
    std::string_view parent_style;
    std::string_view canvas_style;
    int backing_width;
    int backing_height;
    std::array<double, 6> expected;
};
inline const std::array<CanvasLayoutCase, ${states.length}> canvas_layout_cases{{
${states.join(",\n")}
}};
`,
    );
    runRmlUiFixture(t, "ui-canvas-layout", { includeDirectories: [directory] });
});
