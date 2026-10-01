import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource, surveySource } from "../src/compiler.js";
import type { NativeHostUiNode } from "../src/compiler/types.js";
import {
    hostPageCompileOptions,
    hostPageFromDocument,
    readHostPage,
    type HostPageElement,
    type HostPageNode,
} from "../src/host-page.js";

const fixture = "test/fixtures/host-page/page.html";
const xhtml = "http://www.w3.org/1999/xhtml";

function element(
    tag: string,
    attributes: [string, string][] = [],
    children: HostPageNode[] = [],
    namespace = xhtml,
): HostPageElement {
    return { kind: "element", tag, namespace, attributes, children };
}

/** A page whose module script loads the fixture's entry. */
function page(
    head: HostPageNode[],
    body: HostPageNode[],
    compatMode = "CSS1Compat",
) {
    return hostPageFromDocument(
        {
            compatMode,
            root: element(
                "html",
                [],
                [element("head", [], head), element("body", [], body)],
            ),
        },
        { path: fixture, html: "" },
    );
}

const entryScript = element("script", [
    ["type", "module"],
    ["src", "/src/main.ts"],
]);

function findElement(
    nodes: readonly NativeHostUiNode[],
    tag: string,
): NativeHostUiNode | undefined {
    for (const node of nodes) {
        if (node.tag === undefined) continue;
        if (node.tag === tag) return node;
        const found = findElement(node.children ?? [], tag);
        if (found) return found;
    }
    return undefined;
}

test("an HTML page names its entry and its markup is the host model", () => {
    const host = readHostPage(fixture);
    assert.equal(host.entry, resolve("test/fixtures/host-page/src/main.ts"));
    assert.equal(host.title, "Host page fixture");
    assert.deepEqual(host.hostUi.htmlAttributes, { lang: "en" });
    const [sheet, ...otherSheets] = host.hostUi.styleSheets ?? [];
    assert.deepEqual(otherSheets, []);
    assert.match(sheet ?? "", /button\[aria-pressed="true"\]/);
    // Chromium's parser decodes entities and keeps mixed inline content in
    // document order.
    const paragraph = findElement(host.hostUi.elements, "p");
    assert.ok(paragraph?.tag !== undefined);
    assert.deepEqual(paragraph.children, [
        { text: "The " },
        { tag: "b", children: [{ text: "page" }] },
        { text: " markup & styles host the program." },
    ]);
    // The inline module script is a loader whose lines are the page's own.
    const loader = host.loader;
    assert.equal(loader?.specifier, "/src/main.ts");
    const importLine = (text: string) =>
        text.split(/\r?\n/).findIndex((line) => line.includes("await import"));
    assert.equal(
        importLine(loader.source),
        importLine(readFileSync(fixture, "utf8")),
    );
});

test("a page-hosted Canvas2D program compiles against the page's markup", () => {
    const host = readHostPage(fixture);
    const options = hostPageCompileOptions(host);
    const source = readFileSync(host.entry, "utf8");
    // Every lookup finds page markup: null guards fold, the query spreads,
    // the canvas draws and animation frames run without an engine.
    assert.deepEqual(surveySource(source, options).report.refusals, []);
    const { cpp } = compileSource(source, options);
    assert.match(cpp, /bbl::ui_document_root\([^;]*UiDocumentPart::Head\)/);
    assert.match(cpp, /bbl::ui_canvas_set_width\([^;]*320\.0\)/);
    assert.match(cpp, /bbl::ui_canvas_stroke_rect\(/);
    assert.match(cpp, /bbl::ui_append_text\([^;]*" markup & styles host/);
    assert.match(cpp, /request_animation_frame/);
    assert.doesNotMatch(cpp, /Serve this page/);
});

test("the page's loader runs before its entry and must end with the import", () => {
    const host = readHostPage(fixture);
    const options = hostPageCompileOptions(host);
    const source = readFileSync(host.entry, "utf8");
    const loader = (text: string) => ({
        ...options,
        hostPage: {
            ...options.hostPage,
            loader: { ...host.loader!, source: text },
        },
    });
    assert.throws(
        () =>
            compileSource(
                source,
                loader('await import("/src/main.ts");\nconsole.log("after");'),
            ),
        /after its entry import/,
    );
    assert.throws(
        () =>
            compileSource(
                source,
                loader(
                    'if (Math.random() > 0.5) { await import("/src/main.ts"); }',
                ),
            ),
        /condition generation does not decide/,
    );
});

test("markup the host model cannot represent refuses, naming the page", () => {
    const refusals: [() => unknown, RegExp][] = [
        [() => page([], [entryScript], "BackCompat"), /quirks mode/],
        [() => page([], [element("script"), entryScript]), /classic <script>/],
        [
            () =>
                page(
                    [],
                    [element("button", [["onclick", "go()"]]), entryScript],
                ),
            /inline event handler/,
        ],
        [
            () =>
                page(
                    [],
                    [
                        element("svg", [], [], "http://www.w3.org/2000/svg"),
                        entryScript,
                    ],
                ),
            /foreign/,
        ],
        [
            () =>
                page(
                    [
                        element("link", [
                            ["rel", "stylesheet"],
                            ["href", "a.css"],
                        ]),
                    ],
                    [entryScript],
                ),
            /head element <link rel="stylesheet" href="a.css">/,
        ],
        [() => page([], [entryScript, entryScript]), /several module scripts/],
        [
            () =>
                page(
                    [],
                    [
                        element(
                            "script",
                            [["type", "module"]],
                            [{ kind: "text", text: 'import("lib");' }],
                        ),
                    ],
                ),
            /bare specifier 'lib'/,
        ],
        [() => page([], []), /no module script/],
    ];
    for (const [read, message] of refusals)
        assert.throws(read, (error: Error) => {
            assert.match(error.message, message);
            assert.match(error.message, /^Host page 'test\/fixtures/);
            return true;
        });
});
