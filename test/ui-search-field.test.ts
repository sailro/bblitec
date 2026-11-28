import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import type { Page } from "playwright-core";
import { withBrowserPage } from "../src/browser-harness.js";
import { compileSource } from "../src/compiler.js";
import { doubleLiteral, stringLiteral } from "../src/cpp-literals.js";
import { htmlPageServer } from "./html-page-server.js";
import { runRmlUiFixture } from "./native-fixture.js";

// Each field's box is explicit: the cancel button depends on the font size
// and the content box alone. The last case paints the dark image.
const cases: readonly string[] = [
    "font-size:13.333333px;width:177px;height:21px;padding:1px 2px;border:2px solid #767676",
    "font-size:20px;width:200px;height:23px;padding:0;border:0",
    "font-size:6px;width:81px;height:12px;padding:1px 2px;border:2px solid #767676",
    "font-size:40px;width:300px;height:51px;padding:1px 2px;border:2px solid #767676",
    "font-size:14px;width:150px;height:30px;padding:2px 6px;border:1px solid #888888",
    "font-size:12px;width:120px;height:15px;padding:4px;border:2px solid #000000;box-sizing:content-box",
    "font-size:9px;width:100px;height:20px;padding:0 5%;border:0;color-scheme:dark",
];
/** Each row's top: the fields stack 60px apart. */
const rowHeight = 60;

/** A field's state before the visibility check reads whether its button shows. */
interface VisibilityCase {
    name: string;
    value: string;
    focus: boolean;
    hover: boolean;
    disabled: boolean;
}
const visibility: readonly VisibilityCase[] = [
    {
        name: "empty-focused",
        value: "",
        focus: true,
        hover: false,
        disabled: false,
    },
    { name: "idle", value: "abc", focus: false, hover: false, disabled: false },
    {
        name: "focused",
        value: "abc",
        focus: true,
        hover: false,
        disabled: false,
    },
    {
        name: "hovered",
        value: "abc",
        focus: false,
        hover: true,
        disabled: false,
    },
    {
        name: "disabled-hovered",
        value: "abc",
        focus: false,
        hover: true,
        disabled: true,
    },
];

interface Measured {
    /** Per case: the field's border box and its cancel button's, from the field's row, and the width the text leaves to the button. */
    boxes: { field: number[]; button: number[]; reserve: number }[];
    /** Per case: the button's red channel over white, rows of its side. */
    pixels: number[][];
    /** The first case's button, pressed. */
    pressed: number[];
    shown: boolean[];
    events: Record<string, string>;
}

/** The light-on-white red channel of the square at `button`, rounded to the pixel grid as Chromium paints it. */
async function buttonPixels(page: Page, button: number[]): Promise<number[]> {
    const shot = PNG.sync.read(await page.screenshot());
    const left = Math.round(button[0]!),
        top = Math.round(button[1]!),
        side = Math.round(button[2]!);
    const values: number[] = [];
    for (let y = top; y < top + side; y++)
        for (let x = left; x < left + side; x++)
            values.push(shot.data[(y * shot.width + x) * 4]!);
    return values;
}

async function measure(page: Page, origin: string): Promise<Measured> {
    await page.goto(origin);
    const cdp = await page.context().newCDPSession(page);
    // The cancel button lives in each field's user-agent shadow tree.
    const { root } = (await cdp.send("DOM.getDocument", {
        depth: -1,
        pierce: true,
    })) as { root: CdpNode };
    const buttons = new Map<string, number>();
    const walk = (node: CdpNode, host: string | undefined): void => {
        const attributes = node.attributes ?? [];
        const id = attributes[attributes.indexOf("id") + 1];
        if (node.nodeName === "INPUT") host = id;
        if (host && attributes.includes("-webkit-search-cancel-button"))
            buttons.set(host, node.nodeId);
        for (const child of [
            ...(node.children ?? []),
            ...(node.shadowRoots ?? []),
        ])
            walk(child, host);
    };
    walk(root, undefined);
    const quad = async (id: string): Promise<number[]> => {
        const { model } = (await cdp.send("DOM.getBoxModel", {
            nodeId: buttons.get(id)!,
        })) as { model: { border: number[] } };
        const border = model.border;
        return [
            border[0]!,
            border[1]!,
            border[2]! - border[0]!,
            border[5]! - border[1]!,
        ];
    };
    const boxes: Measured["boxes"] = [];
    const pixels: number[][] = [];
    for (let index = 0; index < cases.length; index++) {
        const id = `s${index}`;
        const field = await page.evaluate((id) => {
            const rect = document.getElementById(id)!.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
        }, id);
        // The decoration container is the field's content box; the editing viewport leaves the button's margin box.
        const reserve = await page.evaluate((id) => {
            const input = document.getElementById(id) as HTMLInputElement;
            const style = getComputedStyle(input);
            const content =
                input.getBoundingClientRect().width -
                [
                    style.paddingLeft,
                    style.paddingRight,
                    style.borderLeftWidth,
                    style.borderRightWidth,
                ].reduce((sum, value) => sum + parseFloat(value), 0);
            return content;
        }, id);
        const viewport = await cdp.send("DOM.getBoxModel", {
            nodeId: await editingViewport(cdp, root, id),
        });
        const button = await quad(id);
        await page.focus(`#${id}`);
        pixels.push(await buttonPixels(page, button));
        const top = index * rowHeight;
        boxes.push({
            field: [field[0]!, field[1]! - top, field[2]!, field[3]!],
            button: [button[0]!, button[1]! - top, button[2]!, button[3]!],
            reserve:
                reserve -
                (viewport.model.border[2]! - viewport.model.border[0]!),
        });
    }
    // Visibility: the first field in each state, the pointer parked off it unless hovering.
    const first = await quad("s0");
    const center = {
        x: first[0]! + first[2]! / 2,
        y: first[1]! + first[3]! / 2,
    };
    const shown: boolean[] = [];
    for (const state of visibility) {
        await page.evaluate((state) => {
            const input = document.getElementById("s0") as HTMLInputElement;
            input.value = state.value;
            input.disabled = state.disabled;
            (document.getElementById("other") as HTMLInputElement).focus();
            if (state.focus) input.focus();
        }, state);
        await page.mouse.move(
            state.hover ? center.x : 600,
            state.hover ? center.y : 470,
        );
        const values = await buttonPixels(page, first);
        shown.push(values.some((value) => value < 200));
    }
    // Pressed: the button under a held press (which focuses the field).
    await page.evaluate(() => {
        const input = document.getElementById("s0") as HTMLInputElement;
        input.disabled = false;
        input.value = "abc";
        (document.getElementById("other") as HTMLInputElement).focus();
    });
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    const pressed = await buttonPixels(page, first);
    await page.mouse.up();
    // Events: what a click and Escape fire, read through the field's value.
    await page.evaluate(() => {
        const input = document.getElementById("s0") as HTMLInputElement;
        const log: string[] = [];
        (window as unknown as { searchLog: string[] }).searchLog = log;
        for (const type of ["input", "change", "search"])
            input.addEventListener(type, () =>
                log.push(`${type}:${input.value};`),
            );
    });
    const take = () =>
        page.evaluate(() =>
            (window as unknown as { searchLog: string[] }).searchLog
                .splice(0)
                .join(""),
        );
    // Each step starts from a set value and focus, without the events reaching them.
    const reset = async (value: string, focus: boolean) => {
        await page.evaluate(
            ({ value, focus }) => {
                const input = document.getElementById("s0") as HTMLInputElement;
                input.value = value;
                (document.getElementById("other") as HTMLInputElement).focus();
                if (focus) input.focus();
            },
            { value, focus },
        );
        await take();
    };
    const events: Record<string, string> = {};
    await take();
    await reset("abc", false);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.up();
    events["click"] = await take();
    await reset("abc", true);
    await page.keyboard.press("Escape");
    events["escape"] = await take();
    await reset("", true);
    await page.keyboard.press("Escape");
    events["escape-empty"] = await take();
    await reset("", true);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.up();
    events["click-empty"] = await take();
    await reset("", true);
    await page.keyboard.type("q");
    await page.keyboard.press("Enter");
    // Enter's search is a task after the key's events.
    await page.waitForTimeout(50);
    events["enter"] = await take();
    return { boxes, pixels, pressed, shown, events };
}

interface CdpNode {
    nodeId: number;
    nodeName: string;
    attributes?: string[];
    children?: CdpNode[];
    shadowRoots?: CdpNode[];
}

async function editingViewport(
    _cdp: unknown,
    root: CdpNode,
    id: string,
): Promise<number> {
    let found: number | undefined;
    const walk = (node: CdpNode, host: string | undefined): void => {
        const attributes = node.attributes ?? [];
        const own = attributes[attributes.indexOf("id") + 1];
        if (node.nodeName === "INPUT") host = own;
        if (host === id && own === "editing-view-port") found = node.nodeId;
        for (const child of [
            ...(node.children ?? []),
            ...(node.shadowRoots ?? []),
        ])
            walk(child, host);
    };
    walk(root, undefined);
    if (found === undefined) throw new Error(`No editing viewport in #${id}`);
    return found;
}

test("search inputs are retained native controls with search listeners", () => {
    const result = compileSource(`import {createEngine} from '@babylonjs/lite';
        await createEngine({});
        const input = document.createElement('input');
        input.type = 'search';
        const label = document.createElement('span');
        input.addEventListener('search', () => { label.textContent = input.value; });
        document.body.append(input, label);
        const host = document.createElement('div');
        host.innerHTML = '<input type="search">';
        document.body.append(host);`);
    assert.match(result.cpp, /ui_set_attribute[^\n]+"type", "search"/);
    assert.match(result.cpp, /on_dom_pointer\([^;]+"search"/);
    assert.throws(
        () =>
            compileSource(
                `const host = document.createElement('div');host.innerHTML = '<form><input type="search"></form>';document.body.append(host);`,
            ),
        /a text, search or password <input>, whose Enter submits it/,
    );
    const check = spawnSync(
        process.execPath,
        ["tools/generate-search-cancel.mjs", "--check"],
        { encoding: "utf8" },
    );
    assert.equal(check.status, 0, check.stderr);
});

test("native search fields size, paint, show and clear their cancel button, and search on Enter, as Chromium does", async (t) => {
    const measured = await withBrowserPage(
        htmlPageServer(
            `<!doctype html><style>html,body{margin:0;padding:0}div{height:${rowHeight}px}input{background:white;color:white;caret-color:transparent;outline:none;font-family:Arial}</style><body>${cases
                .map(
                    (style, index) =>
                        `<div><input id=s${index} type=search value=abc style="${style}"></div>`,
                )
                .join("")}<input id=other></body>`,
        ),
        {
            serverName: "search field",
            headless: true,
            viewport: { width: 640, height: 480 },
        },
        measure,
    );
    const directory = resolve("artifacts/ui-search-field");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "browser.json"),
        JSON.stringify(measured, null, 2) + "\n",
    );
    const rect = (values: readonly number[]) =>
        `{${values.map(doubleLiteral).join(", ")}}`;
    const ints = (values: readonly number[]) => `{${values.join(", ")}}`;
    writeFileSync(
        join(directory, "cases.hpp"),
        `
#pragma once
#include <array>
#include <string_view>
#include <vector>
struct SearchCase {
    std::string_view style;
    std::array<double, 4> field;
    std::array<double, 4> button;
    double reserve;
    std::vector<int> pixels;
};
struct SearchVisibility {
    std::string_view name;
    std::string_view value;
    bool focus, hover, disabled, shown;
};
inline constexpr double search_row_height = ${rowHeight};
inline const std::array<SearchCase, ${cases.length}> search_cases{{
${cases
    .map((style, index) => {
        const box = measured.boxes[index]!;
        return `{${stringLiteral(style)}, ${rect(box.field)}, ${rect(box.button)}, ${doubleLiteral(box.reserve)}, ${ints(measured.pixels[index]!)}}`;
    })
    .join(",\n")}
}};
inline const std::vector<int> search_pressed_pixels${ints(measured.pressed)};
inline const std::array<SearchVisibility, ${visibility.length}> search_visibility{{
${visibility
    .map(
        (state, index) =>
            `{${stringLiteral(state.name)}, ${stringLiteral(state.value)}, ${state.focus}, ${state.hover}, ${state.disabled}, ${measured.shown[index]!}}`,
    )
    .join(",\n")}
}};
inline constexpr std::string_view search_click_events = ${stringLiteral(measured.events["click"]!)};
inline constexpr std::string_view search_escape_events = ${stringLiteral(measured.events["escape"]!)};
inline constexpr std::string_view search_escape_empty_events = ${stringLiteral(measured.events["escape-empty"]!)};
inline constexpr std::string_view search_click_empty_events = ${stringLiteral(measured.events["click-empty"]!)};
inline constexpr std::string_view search_enter_events = ${stringLiteral(measured.events["enter"]!)};
`,
    );
    runRmlUiFixture(t, "ui-search-field", {
        includeDirectories: [directory],
    });
});
