import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("Window object URLs retain the document owner across engine creation and deferred downloads", (t) => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        function download(text: string): void {
            const anchor = document.createElement("a");
            const url = URL.createObjectURL(new Blob([text], {type: "text/plain"}));
            anchor.href = url;
            anchor.download = "result.txt";
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
        }
        async function main(): Promise<void> {
            const first = URL.createObjectURL(new Blob(["before"]));
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            const engine = await createEngine(new OffscreenCanvas(1, 1));
            const second = URL.createObjectURL(new Blob(["after"]));
            if (first === second) throw new Error("URL identity");
            download("retained");
            setTimeout(() => {
                URL.revokeObjectURL(first);
                URL.revokeObjectURL(first);
                URL.revokeObjectURL(second);
                globalThis.close();
            }, 0);
        }
        void main();
    `);
    assert.ok(result.manifest.features.includes("platform:window"));
    assert.ok(result.manifest.features.includes("browser:file"));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "browser-file-realm",
        readFileSync("test/fixtures/js-file/browser-file-realm.cpp", "utf8") +
            result.cpp,
        {
            defines: [
                "BBLITE_WORKERS=1",
                "BBLITE_HAS_UI=1",
                "BBLITE_HAS_BROWSER_FILE=1",
            ],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});
