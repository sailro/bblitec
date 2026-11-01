import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource, surveySource } from "../src/compiler.js";
import { nativeHostUiElements, type HostPage } from "../src/compiler/types.js";
import {
    hostPageCompileOptions,
    hostPageFromDocument,
    readHostPage,
} from "../src/host-page.js";
import { hostUiOptions } from "./host-page-fixture.js";
import type { HostPageElement, HostPageNode } from "../src/host-page-parser.js";

const fixture = "examples/regression-host-page/page.html";
const xhtml = "http://www.w3.org/1999/xhtml";
// Chromium parses the fixture once for every test.
const host = readHostPage({ path: fixture });
const entrySource = readFileSync(host.entry, "utf8");

function element(
    tag: string,
    attributes?: Record<string, string>,
    children: HostPageNode[] = [],
    namespace = xhtml,
): HostPageElement {
    return {
        tag,
        namespace,
        ...(attributes ? { attributes } : {}),
        ...(children.length > 0 ? { children } : {}),
    };
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
            root: element("html", undefined, [
                element("head", undefined, head),
                element("body", undefined, body),
            ]),
        },
        { path: fixture, html: "" },
    );
}

const entryScript = element("script", { type: "module", src: "/src/main.ts" });

test("an HTML page names its entry and its markup is the host model", () => {
    assert.equal(
        host.entry,
        resolve("examples/regression-host-page/src/main.ts"),
    );
    assert.equal(host.title, "Host page");
    assert.deepEqual(host.hostUi?.htmlAttributes, { lang: "en" });
    const [sheet, ...otherSheets] = host.hostUi?.styleSheets ?? [];
    assert.deepEqual(otherSheets, []);
    assert.match(sheet?.text ?? "", /button\[aria-pressed="true"\]/);
    // The sheet text starts on the line after its <style> tag.
    const pageLines = readFileSync(fixture, "utf8").split(/\r?\n/);
    assert.equal(
        sheet?.line,
        pageLines.findIndex((line) => line.includes("<style>")) + 1,
    );
    // Chromium's parser decodes entities and keeps mixed inline content in
    // document order.
    const paragraph = [
        ...nativeHostUiElements(host.hostUi?.elements ?? []),
    ].find((node) => node.tag === "p");
    assert.deepEqual(paragraph?.children, [
        { text: "The " },
        { tag: "b", children: [{ text: "page" }] },
        { text: " markup & styles host the program." },
    ]);
    // The inline module script is a loader whose lines are the page's own.
    assert.equal(host.loader?.specifier, "/src/main.ts");
    const importLine = (text: string) =>
        text.split(/\r?\n/).findIndex((line) => line.includes("await import"));
    assert.equal(
        importLine(host.loader?.source ?? ""),
        importLine(pageLines.join("\n")),
    );
});

test("a page-hosted Canvas2D program compiles against the page's markup", () => {
    const options = hostPageCompileOptions(host);
    // Every lookup finds page markup: null guards fold, the query spreads,
    // the canvas draws and animation frames run without an engine.
    assert.deepEqual(surveySource(entrySource, options).report.refusals, []);
    const { cpp } = compileSource(entrySource, options);
    assert.match(cpp, /bbl::ui_document_root\([^;]*UiDocumentPart::Head\)/);
    assert.match(cpp, /bbl::ui_canvas_set_width\([^;]*320\.0\)/);
    assert.match(cpp, /bbl::ui_canvas_stroke_rect\(/);
    assert.match(cpp, /bbl::ui_append_text\([^;]*" markup & styles host/);
    assert.match(cpp, /request_animation_frame/);
    assert.doesNotMatch(cpp, /Serve this page/);
    // The sheet's rules are lowered; without keyframes no text ships.
    assert.doesNotMatch(cpp, /ui_set_text\([^;]*aria-pressed/);
});

test("deferred host lookups attach their owner to the retained binding", () => {
    const model = page(
        [],
        [
            element("canvas", { id: "surface" }),
            element("textarea", { id: "input" }),
            entryScript,
        ],
    );
    const result = compileSource(
        `
        import { createEngine } from "@babylonjs/lite";
        const canvas = document.getElementById("surface") as HTMLCanvasElement;
        const textarea = document.getElementById("input") as HTMLTextAreaElement;
        async function run(): Promise<void> {
            const engine = await createEngine(canvas);
            if (textarea.value !== "") throw new Error("initial input");
            textarea.addEventListener("input", () => {
                if (textarea.value === "rejected") throw new Error("input callback");
            });
        }
        void run();
    `,
        hostPageCompileOptions(model),
    );
    const creation = /auto (\w+) = bbl::create_engine\(/.exec(result.cpp);
    assert.ok(creation);
    const selected = new RegExp(
        String.raw`const auto (\w+) = bbl::ui_get_element_by_id\(${creation[1]}, "input"\);`,
    ).exec(result.cpp);
    assert.ok(selected && creation.index < selected.index);
    const reads = [
        ...result.cpp.matchAll(/bbl::ui_get_form_value\((\w+), (\w+)\)/g),
    ];
    assert.equal(
        reads.length,
        2,
        "initial and retained callback reads both keep the host owner",
    );
    for (const read of reads) {
        assert.equal(read[1], creation[1]);
        assert.equal(read[2], selected[1]);
    }
    assert.match(result.cpp, /bbl::on_dom_pointer\(/);
});

test("the page's loader runs before its entry and must end with the import", () => {
    const withLoader = (source: string): HostPage => ({
        ...host,
        loader: {
            fileName: host.loader?.fileName ?? "",
            specifier: "/src/main.ts",
            source,
        },
    });
    for (const [source, message] of [
        [
            'await import("/src/main.ts");\nconsole.log("after");',
            /must be the last statement its script runs/,
        ],
        [
            'if (Math.random() > 0.5) { await import("/src/main.ts"); }',
            /condition generation does not decide/,
        ],
        [
            'const entry = await import("/src/main.ts");',
            /This await needs an asynchronous realm activation\./,
        ],
    ] as const)
        assert.throws(
            () =>
                compileSource(
                    entrySource,
                    hostPageCompileOptions(withLoader(source)),
                ),
            message,
        );
});

test("a page sheet's refusal names the line of its rule", () => {
    const styled: HostPage = {
        ...host,
        hostUi: {
            styleSheets: [
                {
                    text: "\nbody { margin: 0; }\np { float: inline-start; }\n",
                    line: 7,
                },
            ],
            elements: host.hostUi?.elements ?? [],
        },
    };
    assert.throws(
        () => compileSource(entrySource, hostPageCompileOptions(styled)),
        new RegExp(`${fixture}:9:1: .*'float'`),
    );
});

test("markup the host model cannot represent refuses, naming the page", () => {
    const refusals: [() => unknown, RegExp][] = [
        [() => page([], [entryScript], "BackCompat"), /quirks mode/],
        [
            () =>
                page(
                    [],
                    [element("script", { src: "external.js" }), entryScript],
                ),
            /classic <script src="external.js"> names no file/,
        ],
        [() => page([element("script")], [entryScript]), /in the head/],
        [
            () =>
                page(
                    [],
                    [
                        element("script", undefined, [
                            {
                                text: '(async () => { await import("./entry.js"); })();',
                            },
                        ]),
                        entryScript,
                    ],
                ),
            /module activation before parser/,
        ],
        [
            () =>
                page(
                    [],
                    [
                        element("script", undefined, [
                            { text: "var shared = 1;" },
                        ]),
                        entryScript,
                    ],
                ),
            /global declarations/,
        ],
        [
            () =>
                page(
                    [],
                    [
                        element("script"),
                        element("style", undefined, [
                            { text: "body { color: red; }" },
                        ]),
                        entryScript,
                    ],
                ),
            /ordered stylesheet/,
        ],
        [
            () =>
                page(
                    [],
                    [
                        element("script", { type: "application/json" }),
                        entryScript,
                    ],
                ),
            /not compiled/,
        ],
        [
            () =>
                page([], [element("button", { onclick: "go()" }), entryScript]),
            /inline event handler/,
        ],
        [
            () =>
                page(
                    [],
                    [
                        element(
                            "svg",
                            undefined,
                            [],
                            "http://www.w3.org/2000/svg",
                        ),
                        entryScript,
                    ],
                ),
            /foreign/,
        ],
        [
            () =>
                page(
                    [element("link", { rel: "stylesheet", href: "a.css" })],
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
                        element("script", { type: "module" }, [
                            { text: 'import("lib");' },
                        ]),
                    ],
                ),
            /bare specifier 'lib'/,
        ],
        [() => page([], []), /no module script/],
    ];
    for (const [read, message] of refusals)
        assert.throws(read, (error: Error) => {
            assert.match(error.message, message);
            assert.match(
                error.message,
                /^Host page 'examples\/regression-host-page/,
            );
            return true;
        });
    // A page with nothing but its language and entry has no host document.
    assert.equal(page([], [entryScript]).hostUi, undefined);
});

test("a fixed-scale viewport is inert and a zoomable one refuses", () => {
    const viewport = (content: string) =>
        page([element("meta", { name: "viewport", content })], [entryScript]);
    assert.equal(
        viewport(
            "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no",
        ).hostUi,
        undefined,
    );
    assert.throws(
        () => viewport("width=device-width, maximum-scale=5"),
        /head metadata <meta name="viewport"/,
    );
});

test("an external classic script runs the file the site serves at its URL", () => {
    const root = resolve("artifacts/test-host-page-classic-src");
    mkdirSync(join(root, "public"), { recursive: true });
    writeFileSync(join(root, "entry.ts"), "globalThis.close();");
    const script = "(function () { document.body.dataset.ready = 'true'; })();";
    writeFileSync(join(root, "public/loader.js"), script);
    writeFileSync(join(root, "public/shadowed.js"), script);
    writeFileSync(join(root, "shadowed.js"), "(function () {})();");
    const read = (src: string, attributes = "", publicDir = "public") => {
        const path = join(root, "page.html");
        writeFileSync(
            path,
            `<!doctype html><html><head><title>Classic src</title></head><body>
            <script src="${src}"${attributes}></script>
            <script type="module" src="/entry.ts"></script></body></html>`,
        );
        return readHostPage({
            path,
            ...(publicDir ? { publicDir: join(root, publicDir) } : {}),
        });
    };
    // The declared public directory serves at the site root ahead of the
    // root's own files, as Vite serves it; a static host serves the path
    // whatever the query or fragment.
    for (const [src, file] of [
        ["/loader.js", "public/loader.js"],
        ["loader.js", "public/loader.js"],
        ["/loader.js?v=1#top", "public/loader.js"],
        ["/shadowed.js", "public/shadowed.js"],
    ] as const) {
        const host = read(src);
        // The script is its file, which the program reads.
        assert.deepEqual(host.startup, [{ fileName: join(root, file) }]);
        const [element] = nativeHostUiElements(host.hostUi?.elements ?? []);
        assert.deepEqual(element, {
            tag: "script",
            attributes: { src },
            startupScript: join(root, file),
        });
        const result = compileSource(
            "globalThis.close();",
            hostPageCompileOptions(host),
        );
        assert.ok(result.manifest.inputs.some((input) => input.endsWith(file)));
        assert.match(result.cpp, /"data-ready"/);
    }
    for (const [src, attributes, publicDir, message] of [
        ["/missing.js", "", "public", /names no file its site serves/],
        ["/loader.js", "", "", /names no file its site serves/],
        ["https://example.com/loader.js", "", "public", /another origin/],
        ["/loader.js", " async", "public", /attribute 'async'/],
    ] as const)
        assert.throws(() => read(src, attributes, publicDir), message);
});

test("a module script loads the file its site serves at its URL, resolved against the page", () => {
    const root = resolve("artifacts/test-host-page-module-src");
    mkdirSync(join(root, "pages"), { recursive: true });
    mkdirSync(join(root, "public"), { recursive: true });
    writeFileSync(join(root, "pages/entry.ts"), "globalThis.close();");
    writeFileSync(join(root, "public/served.ts"), "globalThis.close();");
    const path = join(root, "pages/page.html");
    const read = (src: string) => {
        writeFileSync(
            path,
            `<!doctype html><html><head></head><body><script type="module" src="${src}"></script></body></html>`,
        );
        return readHostPage({
            path,
            root,
            publicDir: join(root, "public"),
        });
    };
    assert.equal(read("entry.ts").entry, join(root, "pages/entry.ts"));
    assert.equal(read("./entry.ts?v=1").entry, join(root, "pages/entry.ts"));
    assert.equal(read("/served.ts").entry, join(root, "public/served.ts"));
    assert.throws(() => read("/entry.ts"), /where its site serves no file/);
});

test("host page text nodes interleave with elements in document order", () => {
    const hostUi = {
        elements: [
            {
                tag: "a",
                attributes: { class: "credit" },
                children: [{ tag: "b", text: "Title" }, { text: " by Author" }],
            },
            { text: "after" },
        ],
    };
    assert.deepEqual(
        [...nativeHostUiElements(hostUi.elements)].map(
            (element) => element.tag,
        ),
        ["a", "b"],
    );
    const cpp = compileSource(
        `import { createEngine } from "@babylonjs/lite";
        await createEngine({});`,
        hostUiOptions(hostUi),
    ).cpp;
    const bold = cpp.indexOf('"Title"');
    const tail = cpp.search(/bbl::ui_append_text\([^;]*" by Author"\);/);
    assert.ok(bold >= 0 && tail > bold, "text follows its preceding element");
    assert.match(cpp, /bbl::ui_append_text\([^,]+, \{\}, "after"\);/);
});
