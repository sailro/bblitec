import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { hostPageCompileOptions, readHostPage } from "../src/host-page.js";
import { getScene } from "../src/scene-registry.js";

test("Trogir's page compiles beside the ids its application reads", () => {
    const { page: program } = getScene("trogir-streaming");
    assert.ok(program);
    const page = readHostPage(program);
    const application = readFileSync(page.entry, "utf8");
    const ids = new Set(
        [...application.matchAll(/(?:getElementById|output)\("([^"]+)"\)/g)]
            .map((match) => match[1]!)
            .filter((id) => id !== "id"),
    );
    const cpp = compileSource(
        `import { createEngine } from "@babylonjs/lite";
        await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);`,
        hostPageCompileOptions(page),
    ).cpp;
    for (const id of ids)
        assert.match(cpp, new RegExp(`"id", "${id}"`), `missing #${id}`);
    assert.match(cpp, /color-scheme: ?dark/);
    assert.match(cpp, /accent-color: ?#58c6ff/);
});
