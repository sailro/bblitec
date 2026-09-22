import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import type { NativeHostUiElement } from "../src/compiler/types.js";
import { readNativeHostUi } from "../src/native-host-ui.js";

test("Ocean host retains the authored canvas, page styles and inline badge content", () => {
    const page = readFileSync(
        "corpus/babylon-lite/lab/lite/demo-ocean.html",
        "utf8",
    );
    const host = readNativeHostUi("ui/ocean-host.json");
    const elements: NativeHostUiElement[] = [];
    const visit = (element: NativeHostUiElement): void => {
        elements.push(element);
        element.children?.forEach(visit);
    };
    host.elements.forEach(visit);
    const authoredIds = [
        ...page.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"/g),
    ].map((match) => [match[2], match[1]]);
    assert.deepEqual(
        elements
            .filter((element) => element.attributes?.id)
            .map((element) => [element.attributes!.id, element.tag]),
        authoredIds,
    );
    const compact = (css: string): string => css.replace(/\s+/g, "");
    const pageStyle = page.match(/html,\s*body\s*\{([^}]+)\}/)?.[1];
    const canvasStyle = page.match(/canvas\s*\{([^}]+)\}/)?.[1];
    assert.ok(pageStyle && canvasStyle);
    for (const [selector, expected] of [
        ["html", pageStyle],
        ["body", pageStyle],
        ["canvas", canvasStyle],
    ]) {
        const rule = host.styleRules?.find(
            (candidate) => candidate.primary === selector,
        );
        assert.ok(rule, `Missing authored ${selector} style`);
        assert.equal(compact(rule.style), compact(expected!));
    }
    const badge = elements.find(
        (element) => element.attributes?.class === "badge",
    );
    const caption = badge?.children?.[1];
    assert.equal(caption?.tag, "span");
    assert.equal(caption.text, "Three cascades · clipmap · buoyancy · ");
    assert.equal(caption.children?.length, 1);
    assert.equal(caption.children?.[0]?.tag, "a");
    assert.ok(
        elements.some(
            (element) =>
                element.tag === "style" &&
                compact(element.text ?? "") ===
                    "@keyframesspin{to{transform:rotate(360deg);}}",
        ),
    );
});

test("Ocean Window bootstrap attaches its canvas before the first source lookup", () => {
    const directory = resolve("artifacts/test-ocean-host");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `import {createEngine} from "@babylonjs/lite";
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const canvas = document.getElementById("renderCanvas")!;
        const engine = await createEngine(canvas);
        canvas.dataset.ready = "true";`,
        {
            fileName: resolve(directory, "entry.ts"),
            nativeHostUi: readNativeHostUi("ui/ocean-host.json"),
        },
    );
    assert.ok(result.manifest.features.includes("platform:window"));
    const created = result.cpp.match(
        /const auto (\w+) = bbl::ui_create_element\(bbl::pal::window_document_engine\(\), "canvas"\);/,
    );
    assert.ok(created);
    const attached = result.cpp.indexOf(
        `bbl::ui_append_to_root(bbl::pal::window_document_engine(), ${created[1]});`,
    );
    const lookup = result.cpp.search(
        /bbl::ui_(?:find|get)_element_by_id\(bbl::pal::window_document_engine\(\), "renderCanvas"\)/,
    );
    assert.ok(
        attached >= 0 && lookup > attached,
        "The authored canvas must be attached before Ocean dereferences its lookup",
    );
    assert.ok(result.cpp.indexOf('"id", "renderCanvas"') < attached);
    assert.ok(
        result.cpp.indexOf("bbl::pal::update_window_document();", attached) <
            lookup,
    );
});
