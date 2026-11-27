import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { withBrowserPage } from "../src/browser-harness.js";
import { compileSource } from "../src/compiler.js";
import { doubleLiteral, stringLiteral } from "../src/cpp-literals.js";
import { htmlPageServer } from "./html-page-server.js";
import { runRmlUiFixture } from "./native-fixture.js";

interface ContainCase {
    name: string;
    /** The contained box's `contain` value, empty for none. */
    contain: string;
}

// Each case: a positioned host, a box with `contain`, and in it an
// absolutely positioned child, a static child overflowing the box and a
// child under the box's background (z-index -1).
const cases: readonly ContainCase[] = [
    { name: "none", contain: "" },
    { name: "layout", contain: "layout" },
    { name: "paint", contain: "paint" },
    { name: "content", contain: "content" },
    { name: "style", contain: "style" },
    { name: "layout-paint-style", contain: "layout paint style" },
];
const hostStyle =
    "display:flow-root;position:relative;width:400px;height:120px;font-size:0;line-height:0;";
const boxStyle =
    "margin:20px 0 0 30px;width:100px;height:50px;padding:5px;border:2px solid black;background:white";
const absoluteStyle =
    "position:absolute;left:7px;top:9px;width:10px;height:10px";
const wideStyle = "width:200px;height:10px";
const underStyle = "position:relative;z-index:-1;width:20px;height:20px";

test("contain admits layout, paint and style containment and refuses size containment", () => {
    const sheet = (css: string) =>
        compileSource(
            `const sheet=document.createElement('style');sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);`,
        );
    assert.match(
        sheet("div{contain:layout paint style}").cpp,
        /contain:layout paint style/,
    );
    assert.match(sheet("div{contain:content}").cpp, /contain:content/);
    assert.match(sheet("div{contain:paint}").cpp, /contain:paint/);
    assert.match(sheet("div{contain:style}").cpp, /contain:style/);
    for (const value of [
        "size",
        "inline-size layout",
        "strict",
        "layout layout",
        "paint blink",
    ])
        assert.throws(
            () => sheet(`div{contain:${value}}`),
            /Retained UI style property 'contain' is not lowered/,
            value,
        );
});

test("native containment positions, clips and stacks as Chromium does", async (t) => {
    const measured = await withBrowserPage(
        htmlPageServer(
            "<!doctype html><style>html,body{margin:0;padding:0}</style><body></body>",
        ),
        {
            serverName: "containment",
            headless: true,
            viewport: { width: 640, height: 480 },
        },
        async (page, origin) => {
            await page.goto(origin);
            return page.evaluate(
                ({ list, host, box, absolute, wide, under }) =>
                    list.map((item) => {
                        const hostElement = document.createElement("div");
                        hostElement.setAttribute("style", host);
                        document.body.append(hostElement);
                        const boxElement = document.createElement("div");
                        boxElement.setAttribute(
                            "style",
                            `${item.contain ? `contain:${item.contain};` : ""}${box}`,
                        );
                        hostElement.append(boxElement);
                        const children = [absolute, wide, under].map(
                            (style) => {
                                const child = document.createElement("div");
                                child.setAttribute("style", style);
                                boxElement.append(child);
                                return child;
                            },
                        );
                        const hostRect = hostElement.getBoundingClientRect();
                        const rect = (element: Element) => {
                            const r = element.getBoundingClientRect();
                            return [
                                r.left - hostRect.left,
                                r.top - hostRect.top,
                                r.width,
                                r.height,
                            ];
                        };
                        const underRect = children[2]!.getBoundingClientRect();
                        const hit = document.elementFromPoint(
                            underRect.left + underRect.width / 2,
                            underRect.top + underRect.height / 2,
                        );
                        // Whether the wide child paints past the box: hit test just right of the box.
                        const boxRect = boxElement.getBoundingClientRect();
                        const outside = document.elementFromPoint(
                            boxRect.right + 4,
                            children[1]!.getBoundingClientRect().top + 5,
                        );
                        const result = {
                            rects: [rect(boxElement), ...children.map(rect)],
                            underHit: hit === children[2] ? 1 : 0,
                            wideHit: outside === children[1] ? 1 : 0,
                        };
                        hostElement.remove();
                        return result;
                    }),
                {
                    list: cases,
                    host: hostStyle,
                    box: boxStyle,
                    absolute: absoluteStyle,
                    wide: wideStyle,
                    under: underStyle,
                },
            );
        },
    );
    const directory = resolve("artifacts/ui-containment");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "browser.json"),
        JSON.stringify(measured, null, 2) + "\n",
    );
    writeFileSync(
        join(directory, "cases.hpp"),
        `
#pragma once
#include <array>
#include <string_view>
struct ContainCase {
    std::string_view name;
    std::string_view contain;
    std::array<std::array<double, 4>, 4> rects;
    int under_hit;
    int wide_hit;
};
inline constexpr std::string_view contain_host_style = ${stringLiteral(hostStyle)};
inline constexpr std::string_view contain_box_style = ${stringLiteral(boxStyle)};
inline constexpr std::array<std::string_view, 3> contain_child_styles{${[absoluteStyle, wideStyle, underStyle].map(stringLiteral).join(", ")}};
inline const std::array<ContainCase, ${cases.length}> contain_cases{{
${cases
    .map((item, index) => {
        const entry = measured[index]!;
        return `{${stringLiteral(item.name)}, ${stringLiteral(item.contain)}, {{${entry.rects.map((r) => `{${r.map(doubleLiteral).join(", ")}}`).join(", ")}}}, ${entry.underHit}, ${entry.wideHit}}`;
    })
    .join(",\n")}
}};
`,
    );
    runRmlUiFixture(t, "ui-containment", {
        includeDirectories: [directory],
        macros: { BBLITE_HAS_DOM_INPUT: 1 },
    });
});
