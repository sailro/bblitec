import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compileSource } from "../src/compiler.js";
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

const compile = (body: string) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    return compileSource(program(body), {
        fileName: join(directory, "entry.ts"),
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
    const named = compile(
        `const image = document.createElement("img");
        image.dataset.next = "tile.png";
        image.src = image.dataset.next!;
        document.body.append(image);`,
    );
    assert.doesNotMatch(named.cpp, /"src"/);
    const adaptation = named.manifest.adaptations?.find(
        (entry) => entry.id === "substituted-ui-runtime",
    );
    assert.match(
        adaptation?.nativeSemantics ?? "",
        /the reached img src write\(s\) with a value generation cannot name keep the element's current state/,
    );
});
