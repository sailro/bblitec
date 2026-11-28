import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import ts from "typescript";
import { withBrowserPage } from "../src/browser-harness.js";
import { compileSource } from "../src/compiler.js";
import { stringLiteral } from "../src/cpp-literals.js";
import { htmlPageServer } from "./html-page-server.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/ui-markup-operands");
const publicDir = join(directory, "public");
const cards = ["a", "b", "c"] as const;

// Cards whose innerHTML joins fixed fragments around several runtime
// operands: a stored icon whose img src is a packaged image the URL
// inference finds, escaped text, and conditional fragments (a class among
// literals included).
const program = `
const BASE = import.meta.env.BASE_URL;
const appUrl = (path: string): string => BASE + path.replace(/^\\/+/, "");
type Shade = "red" | "green";
const ICON: Record<Shade, string> = { red: "/assets/ui/red.png", green: "/assets/ui/green.png" };
function iconPath(shade: Shade): string { return ICON[shade]; }
interface Card { id: string; shade: Shade; locked: boolean; loud: boolean; note: string }
function render(list: readonly Card[]): void {
    for (const card of list) {
        const lock = card.locked ? "Locked: " + card.note : "";
        const iconHtml = \`<div class="icon"><img src="\${appUrl(iconPath(card.shade))}" alt=""></div>\`;
        const button = document.createElement("button");
        button.id = card.id;
        button.innerHTML =
            iconHtml +
            \`<div class="name">\${card.shade}</div>\` +
            \`<div class="note">\${card.note}</div>\` +
            (lock ? \`<div class="lock\${card.loud ? " lock--loud" : ""}">\${lock}</div>\` : "");
        document.body.appendChild(button);
    }
}
const now = performance.now();
render([
    { id: "a", shade: now >= 0 ? "green" : "red", locked: now >= 0, loud: now >= 0, note: "1 < 2 & 3 " + String(now >= 0) },
    { id: "b", shade: now < 0 ? "green" : "red", locked: now >= 0, loud: now < 0, note: "plain" },
    { id: "c", shade: now < 0 ? "green" : "red", locked: now < 0, loud: false, note: "open" },
]);
globalThis.close();
`;

function writeImages(): void {
    mkdirSync(join(publicDir, "assets/ui"), { recursive: true });
    for (const name of ["red", "green", "blue"]) {
        const raster = new PNG({ width: 4, height: 4 });
        writeFileSync(
            join(publicDir, `assets/ui/${name}.png`),
            PNG.sync.write(raster),
        );
    }
}

const compile = (source: string) => {
    writeImages();
    return compileSource(source, {
        fileName: join(directory, "entry.ts"),
        publicDir,
    });
};

test("innerHTML fragments around several runtime operands build Chromium's tree", async (t) => {
    const result = compile(program);
    const outputs = result.manifest.assets.map((asset) => asset.output);
    for (const name of ["red", "green"])
        assert.ok(outputs.includes(`assets/ui/${name}.png`), name);
    assert.ok(!outputs.includes("assets/ui/blue.png"));
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    // The same program in Chromium, its base URL the root.
    const script = ts
        .transpileModule(program, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        })
        .outputText.replace("import.meta.env.BASE_URL", '"/"')
        .replace("globalThis.close();", "");
    const trees = await withBrowserPage(
        htmlPageServer("<!doctype html><body></body>"),
        {
            serverName: "markup operands",
            headless: true,
            viewport: { width: 640, height: 480 },
        },
        async (page, origin) => {
            await page.goto(origin);
            await page.addScriptTag({ content: script, type: "module" });
            return page.evaluate((ids) => {
                const serialize = (node: Node): string => {
                    if (node.nodeType === Node.TEXT_NODE)
                        return node.textContent ?? "";
                    const element = node as Element;
                    const tag = element.tagName.toLowerCase();
                    const classes = element.className
                        .split(/\s+/)
                        .filter(Boolean)
                        .join(" ");
                    const src = element.getAttribute("src");
                    return `<${tag}${classes ? ` class="${classes}"` : ""}${src !== null ? ` src="${src}"` : ""}>${[...element.childNodes].map(serialize).join("")}</${tag}>`;
                };
                return ids.map((id) =>
                    [...document.getElementById(id)!.childNodes]
                        .map(serialize)
                        .join(""),
                );
            }, cards);
        },
    );
    writeFileSync(
        join(directory, "browser.hpp"),
        `#pragma once
#include <array>
#include <string_view>
inline constexpr std::array<std::pair<std::string_view, std::string_view>, ${cards.length}> browser_trees{{
${cards.map((id, index) => `{${stringLiteral(id)}, ${stringLiteral(trees[index]!)}}`).join(",\n")}
}};
`,
    );
    runRmlUiFixture(t, "ui-markup-operands", {
        imageDecoder: true,
        includeDirectories: [directory],
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("an innerHTML img src takes one runtime operand as a whole", () => {
    const markup = (src: string) => `
        const BASE = import.meta.env.BASE_URL;
        const appUrl = (path: string): string => BASE + path.replace(/^\\/+/, "");
        const shade = performance.now() > 1 ? "red" : "green";
        const root = document.createElement("div");
        root.innerHTML = \`<img src="${src}" alt="">\`;
        document.body.append(root);`;
    assert.match(
        compile(markup("${appUrl(`/assets/ui/${shade}.png`)}")).cpp,
        /<img src=\\"", bbl::ui_escape_rml\(/,
    );
    assert.throws(
        () => compile(markup("/assets/ui/${shade}.png")),
        /img src that is static or one runtime operand as a whole/,
    );
    assert.throws(
        () => compile(markup("${String(performance.now())}")),
        /img src write requires sources generation can package/,
    );
});
