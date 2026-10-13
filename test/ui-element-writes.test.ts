import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compileSource } from "../src/compiler.js";
import type { NativeHostUi } from "../src/compiler/types.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/ui-element-writes");

/** A Window program, its elements created by helpers so storage carries no tag. */
const program = (body: string): string => `
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
    worker.terminate();
    function output(id: string): HTMLOutputElement {
        const element = document.createElement("output");
        element.id = id;
        document.body.append(element);
        return element;
    }
    function input(id: string): HTMLInputElement {
        const element = document.createElement("input");
        element.id = id;
        document.body.append(element);
        return element;
    }
    ${body}
    globalThis.close();
`;

const compile = (body: string, nativeHostUi?: NativeHostUi) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    return compileSource(program(body), {
        fileName: join(directory, "entry.ts"),
        ...(nativeHostUi ? { nativeHostUi } : {}),
    });
};

test("writes through stored retained elements lower inside runtime iteration", (t) => {
    const result = compile(`
        const pose = [output("x"), output("y")];
        const fail = (): void => {
            for (const field of pose) {
                field.value = "Unavailable";
                field.title = "pose";
            }
        };
        fail();
        const counters = [output("a"), output("b")];
        counters.forEach((field, index) => {
            field.value = String(index);
        });
        const indexed = [output("i0"), output("i1")];
        for (let index = 0; index < indexed.length; index++)
            indexed[index]!.value = "slot " + index;
        const fill = (field: HTMLOutputElement | HTMLInputElement): void => {
            field.value = "mixed";
        };
        fill(output("m0"));
        fill(input("m1"));
    `);
    // Each loop body keeps its write; none erases as browser instrumentation.
    for (const written of ['"Unavailable"', '"slot 1"', '"mixed"'])
        assert.match(
            result.cpp,
            new RegExp(`bbl::ui_set_form_value\\([^;]*${written}`),
            written,
        );
    assert.match(result.cpp, /bbl::ui_set_attribute\([^;]*"title", "pose"\);/);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-element-writes", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});

test("unrepresented retained element writes refuse instead of erasing", () => {
    for (const [body, pattern] of [
        [
            `const stored = [output("s")]; for (const field of stored) field.scrollTop = 5;`,
            /Retained element property 'scrollTop' assignment is not lowered natively/,
        ],
        [
            `const field = output("s"); field.scrollTop += 5;`,
            /Compound assignment to retained element property 'scrollTop' is not lowered natively/,
        ],
        [
            `const canvas = document.createElement("canvas"); canvas.tabIndex = 1;`,
            /Retained element property 'tabIndex' assignment is not lowered natively/,
        ],
    ] as const)
        assert.throws(() => compile(body), pattern, body);
});

test("with retained UI, writes through unprojected DOM elements refuse instead of erasing", () => {
    const retained = `document.body.append(document.createElement("div"));`;
    const page = `const page = document.scrollingElement as HTMLElement;`;
    for (const write of [
        "page.scrollTop = 4;",
        "if (page) page.scrollTop = 4;",
        "page.dataset.mark = 'x';",
        "Object.assign(page.style, { color: 'red' });",
    ])
        assert.throws(
            () => compile(`${retained} ${page} ${write}`),
            /A write through a DOM element that the retained UI does not represent cannot be erased in a program with retained UI/,
            write,
        );
    // Without retained UI the page's browser instrumentation still erases.
    assert.doesNotMatch(compile(`${page} page.scrollTop = 4;`).cpp, /scroll/i);
});

test("inert canvas focus order and packaged image sources lower explicitly", () => {
    const canvas = compile(
        `const canvas = document.createElement("canvas"); canvas.tabIndex = 0; document.body.append(canvas);`,
    );
    assert.doesNotMatch(canvas.cpp, /tabIndex|tab_index/);
    const texture = new PNG({ width: 2, height: 2 });
    texture.data.fill(255);
    writeFileSync(join(directory, "tile.png"), PNG.sync.write(texture));
    const fixed = compile(
        `const image = document.createElement("img"); image.src = "tile.png"; document.body.append(image);`,
    );
    assert.match(
        fixed.cpp,
        /bbl::ui_set_attribute\([^;]*"src", "tile\.png"\);/,
    );
    assert.ok(
        fixed.manifest.assets.some((asset) => asset.output === "tile.png"),
    );
    // A host image's data attributes name both sources: both are packaged
    // and the write selects between them at run time.
    writeFileSync(join(directory, "tall.png"), PNG.sync.write(texture));
    const host: NativeHostUi = {
        sourcePath: "ui/art-host.json",
        elements: [
            {
                tag: "img",
                attributes: {
                    id: "art",
                    src: "tile.png",
                    "data-landscape-src": "tile.png",
                    "data-portrait-src": "tall.png",
                },
            },
        ],
    };
    const select = `const art = document.getElementById("art") as HTMLImageElement;
        art.src = window.innerWidth < window.innerHeight ? art.dataset.portraitSrc! : art.dataset.landscapeSrc!;`;
    const selected = compile(select, host);
    for (const output of ["tile.png", "tall.png"])
        assert.ok(
            selected.manifest.assets.some((asset) => asset.output === output),
            output,
        );
    assert.match(
        selected.cpp,
        /bbl::ui_set_attribute\([^;]*"src", (?!")[^;]*data-portrait-src/,
    );
    const refusal = /An img src write requires sources generation can package/;
    assert.throws(
        () =>
            compile(
                `${select} (document.getElementById("art") as HTMLImageElement).dataset.portraitSrc = "other.png";`,
                host,
            ),
        refusal,
    );
    assert.throws(
        () =>
            compile(
                `const image = document.createElement("img");
                image.dataset.next = "tile.png";
                image.src = image.dataset.next!;`,
            ),
        refusal,
    );
});

test("host data attribute image sources select at run time natively", (t) => {
    const imageDirectory = resolve("artifacts/ui-image-source");
    mkdirSync(imageDirectory, { recursive: true });
    writeFileSync(join(imageDirectory, "worker.ts"), "self.close();");
    const texture = new PNG({ width: 2, height: 2 });
    texture.data.fill(255);
    for (const name of ["tile.png", "tall.png"])
        writeFileSync(join(imageDirectory, name), PNG.sync.write(texture));
    const image = (id: string) => ({
        tag: "img",
        attributes: {
            id,
            src: "tile.png",
            "data-landscape-src": "tile.png",
            "data-portrait-src": "tall.png",
        },
    });
    const result = compileSource(
        program(`
        const art = document.getElementById("art") as HTMLImageElement;
        const other = document.getElementById("other") as HTMLImageElement;
        const portrait = window.innerWidth < window.innerHeight;
        art.src = portrait ? art.dataset.portraitSrc! : art.dataset.landscapeSrc!;
        other.src = portrait ? other.dataset.landscapeSrc! : other.dataset.portraitSrc!;
    `),
        {
            fileName: join(imageDirectory, "entry.ts"),
            nativeHostUi: {
                sourcePath: "ui/image-host.json",
                elements: [image("art"), image("other")],
            },
        },
    );
    writeFileSync(join(imageDirectory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-image-source", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
        imageDecoder: true,
    });
});
