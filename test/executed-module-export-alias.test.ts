import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { parseExecutedModuleSource } from "../src/executed-module-assets.js";
import { isRecord } from "../src/json-fields.js";

function isFactory(value: unknown): value is () => unknown {
    return typeof value === "function";
}

test("executed assets pair renamed and default exports with their defining module", async () => {
    const directory = resolve("artifacts/executed-module-export-alias");
    mkdirSync(directory, { recursive: true });
    const producer = `
        function privateFactory(): string { return "named atlas"; }
        export { privateFactory as publishedFactory };
        export default function defaultFactory(): string { return "default atlas"; }
    `;
    writeFileSync(join(directory, "producer.ts"), producer);
    writeFileSync(
        join(directory, "producer.mjs"),
        ts.transpileModule(producer, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ESNext,
            },
        }).outputText,
    );
    writeFileSync(
        join(directory, "first.ts"),
        'export { publishedFactory as forwarded, default as fallback } from "./producer.js";',
    );
    writeFileSync(
        join(directory, "second.ts"),
        'export { forwarded as chained, fallback as default } from "./first.js";',
    );
    const source = `
        import fallback, { chained as locallyRenamed } from "./second.js";
        import { createEngine, loadSpriteAtlas } from "babylon-lite";
        const engine = await createEngine({});
        await loadSpriteAtlas(engine, locallyRenamed(), { gridSize: [1, 1] });
        await loadSpriteAtlas(engine, fallback(), { gridSize: [1, 1] });
    `;
    const result = compileSource(source, {
        fileName: join(directory, "entry.ts"),
    });
    const references = result.manifest.assets.map((asset) =>
        parseExecutedModuleSource(asset.source, resolve(".")),
    );
    assert.equal(references.length, 2);
    const module: unknown = await import(
        pathToFileURL(join(directory, "producer.mjs")).href
    );
    assert.ok(isRecord(module));
    const values: unknown[] = [];
    for (const reference of references) {
        assert.ok(reference);
        assert.equal(reference.modulePath, join(directory, "producer.ts"));
        const factory = module[reference.exportName];
        assert.ok(isFactory(factory));
        values.push(factory());
    }
    assert.deepEqual(values, ["named atlas", "default atlas"]);
});
