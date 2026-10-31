import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { hostPageCompileOptions, readHostPage } from "../src/host-page.js";

test("Ocean Window bootstrap attaches its page canvas before the first source lookup", () => {
    const directory = resolve("artifacts/test-ocean-host");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const entry = `import {createEngine} from "@babylonjs/lite";
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const canvas = document.getElementById("renderCanvas")!;
        const engine = await createEngine(canvas);
        canvas.dataset.ready = "true";`;
    writeFileSync(resolve(directory, "entry.ts"), entry);
    const path = resolve(directory, "page.html");
    writeFileSync(
        path,
        `<!doctype html><html><head><title>Ocean</title></head><body>
        <canvas id="renderCanvas"></canvas>
        <script type="module" src="/entry.ts"></script></body></html>`,
    );
    const result = compileSource(
        entry,
        hostPageCompileOptions(readHostPage({ path })),
    );
    assert.ok(result.manifest.features.includes("platform:window"));
    const created = result.cpp.match(
        /const auto (\w+) = bbl::ui_create_element\(bbl::pal::window_document_engine\(\), "canvas"\);/,
    );
    assert.ok(created);
    const attached = result.cpp.search(
        new RegExp(
            String.raw`bbl::ui_append_(?:to_root|child)\(bbl::pal::window_document_engine\(\), (?:[^;]*, )?${created[1]}\);`,
        ),
    );
    const lookup = result.cpp.search(
        /bbl::ui_(?:find|get)_element_by_id\(bbl::pal::window_document_engine\(\), "renderCanvas"\)/,
    );
    assert.ok(
        attached >= 0 && lookup > attached,
        "The page canvas must be attached before Ocean dereferences its lookup",
    );
    assert.ok(result.cpp.indexOf('"id", "renderCanvas"') < attached);
    assert.ok(
        result.cpp.indexOf("bbl::pal::update_window_document();", attached) <
            lookup,
    );
});
