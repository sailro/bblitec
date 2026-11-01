import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    hostPageCompileOptions,
    hostPageDocumentAsset,
    hostPageServedFile,
    readHostPage,
} from "../src/host-page.js";

test("a page's URLs resolve against the page; its entry module's directory is the public root", () => {
    const page = {
        path: "corpus/babylon-lite/lab/lite/demo-playroom.html",
        root: "corpus/babylon-lite/lab",
        entry: "corpus/babylon-lite/lab/lite/src/demos/playroom.ts",
    };
    const host = readHostPage(page);
    assert.equal(host.entryUrl, "/lite/bundle/demos/playroom.js");
    for (const url of [
        "./bundle/demos/playroom/ui/kick.png",
        "/lite/bundle/demos/playroom/ui/kick.png",
    ])
        assert.equal(hostPageDocumentAsset(host, url), "/playroom/ui/kick.png");
    // A file the site root serves is that file.
    assert.equal(
        hostPageDocumentAsset(host, "demo-ocean.html"),
        resolve("corpus/babylon-lite/lab/lite/demo-ocean.html"),
    );
    assert.equal(
        hostPageDocumentAsset(host, "/textures/sky.png"),
        "/textures/sky.png",
    );
    for (const url of ["https://example.com/a.png", "data:image/png;base64,"])
        assert.equal(hostPageDocumentAsset(host, url), url);
});

test("encoded page and module directories preserve literal URL punctuation", () => {
    const root = resolve("artifacts/host-page-encoded");
    const directory = join(root, "page #% space");
    const module = join(directory, "module #%");
    mkdirSync(module, { recursive: true });
    writeFileSync(join(module, "entry #%.ts"), "globalThis.close();");
    const path = join(directory, "page #%.html");
    const src = "./module%20%23%25/entry%20%23%25.ts?ignored=1#fragment";
    writeFileSync(
        path,
        `<!doctype html><html><head><title>URLs</title></head><body>
        <script type="module" src="${src}"></script></body></html>`,
    );
    const page = readHostPage({ path, root });
    assert.equal(page.entry, join(module, "entry #%.ts"));
    assert.equal(
        page.entryUrl,
        "/page%20%23%25%20space/module%20%23%25/entry%20%23%25.ts",
    );
    assert.equal(hostPageServedFile(page, page.entryUrl), page.entry);
    assert.equal(
        hostPageDocumentAsset(
            page,
            "./module%20%23%25/asset%20%23%3F%25.png?query#hash",
        ),
        "/asset #?%.png",
    );
});

test("a classic script writes an anchor's href through a lookup and reads the runtime query", () => {
    const directory = resolve("artifacts/host-page-documents");
    mkdirSync(directory, { recursive: true });
    const entry = "globalThis.close();";
    writeFileSync(join(directory, "entry.ts"), entry);
    const path = join(directory, "page.html");
    writeFileSync(
        path,
        `<!doctype html>
        <html><head><title>Links</title></head><body>
        <a id="link" href="./first.html">first</a>
        <script>(function () {
            document.getElementById("link").href = "./second.html" + location.search;
        })();</script>
        <script type="module" src="/entry.ts"></script>
        </body></html>`,
    );
    const { cpp } = compileSource(
        entry,
        hostPageCompileOptions(readHostPage({ path })),
    );
    // The lookup's tag is the document's at run time: an anchor takes the
    // attribute, another element would refuse its expando property.
    assert.match(
        cpp,
        /bbl::ui_set_declared_attribute\([^;]*\{"a", "area"\}, "href", "href", /,
    );
    assert.match(cpp, /"\.\/second\.html"/);
    assert.doesNotMatch(cpp, /"\.\/second\.html\?/);
});

test("a page's select holds only its options", () => {
    const directory = resolve("artifacts/host-page-documents");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "entry.ts"), "globalThis.close();");
    const path = join(directory, "select.html");
    const write = (options: string) =>
        writeFileSync(
            path,
            `<!doctype html><html><head><title>Select</title></head><body>
            <select id="quality">${options}</select>
            <script type="module" src="/entry.ts"></script></body></html>`,
        );
    write(`
        <option value="low">Low</option>
        <option value="high">High</option>
    `);
    const select = readHostPage({ path }).hostUi?.elements.find(
        (node) => node.tag === "select",
    );
    assert.deepEqual(
        select?.tag === "select"
            ? select.children?.map((node) => node.tag)
            : undefined,
        ["option", "option"],
    );
    write(`<option>Low</option> or <option>High</option>`);
    assert.throws(
        () => readHostPage({ path }),
        /<select> has text inside <select>; it holds only options\./,
    );
});

test("border-image URLs resolve against the document rather than its module", () => {
    const directory = resolve("artifacts/host-page-border-image");
    mkdirSync(join(directory, "modules"), { recursive: true });
    const entry = `const marker = document.createElement("div");
        document.body.appendChild(marker);
        globalThis.close();`;
    writeFileSync(join(directory, "modules/entry.ts"), entry);
    copyFileSync(
        "corpus/babylon-lite/lab/public/playroom/ui/kick.png",
        join(directory, "frame #.png"),
    );
    const path = join(directory, "page.html");
    writeFileSync(
        path,
        `<!doctype html><html><head><title>Border</title>
        <style>.frame { border-image: url('./frame%20%23.png') 2 / 2px; }</style>
        </head><body><div class="frame"></div>
        <script type="module" src="./modules/entry.ts"></script></body></html>`,
    );
    const result = compileSource(
        entry,
        hostPageCompileOptions(readHostPage({ path })),
    );
    assert.equal(result.manifest.assets[0]?.source, "../frame #.png");
});

test("anchor href checks share known, incompatible and unknown tag answers", () => {
    const { cpp } = compileSource(`
        interface Links { item: HTMLAnchorElement }
        const link = document.createElement("a");
        document.body.appendChild(link);
        const links: Links = {item: link};
        links.item.href = "./next.html";
        globalThis.close();
    `);
    assert.match(cpp, /ui_set_attribute\([^;]*"href", "\.\/next\.html"\)/);
    assert.throws(
        () =>
            compileSource(`
        const wrong = document.createElement("div");
        document.body.appendChild(wrong);
        wrong.href = "./next.html";
    `),
        /UI href requires a <a> or <area> element/,
    );
});
