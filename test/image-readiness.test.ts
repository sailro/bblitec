import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compileSource } from "../src/compiler.js";

test("image readiness compiles owned startup and packages both valid and broken images", () => {
    const directory = resolve("artifacts/image-readiness");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const pixel = new PNG({ width: 1, height: 1 });
    pixel.data.fill(255);
    writeFileSync(join(directory, "pixel.png"), PNG.sync.write(pixel));
    writeFileSync(join(directory, "broken.png"), "invalid image data");
    const fixture = readFileSync("test/fixtures/image-startup.ts", "utf8");
    const source =
        'const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();' +
        fixture +
        "(async()=>{await checkImageReadiness();globalThis.close();})();";
    const result = compileSource(source, {
        fileName: join(directory, "entry.ts"),
    });
    assert.ok(
        result.manifest.assets.some((asset) => asset.output === "pixel.png"),
    );
    assert.ok(
        result.manifest.assets.some((asset) => asset.output === "broken.png"),
    );
    writeFileSync(join(directory, "entry.ts"), source);
});
