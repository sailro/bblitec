import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    buildNativeFixture,
    optionalNativeFixtureTools,
} from "./native-fixture.js";

for (const variant of [
    "direct",
    "factory",
    "alias",
    "helper",
    "conditional",
] as const) {
    test(`Window module startup preserves ${variant} entry execution and Worker ownership`, (t) => {
        const directory = resolve(`artifacts/worker-startup-${variant}`);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            resolve(directory, "worker.ts"),
            `self.addEventListener("message", () => {
                self.postMessage(42);
                self.close();
            });`,
        );
        const constructor = `new Worker(new URL("./worker.ts", import.meta.url), {type: "module"})`;
        const source = `
            function makeWorker() { return ${constructor}; }
            const worker = ${variant === "factory" ? "makeWorker()" : constructor};
            let state = 0;
            worker.addEventListener("message", (event: MessageEvent<number>) => {
                if (event.data !== 42 || state !== 3) throw new Error("module completion");
                globalThis.close();
            });
            state = 1;
            async function main(): Promise<void> {
                ${
                    variant === "conditional"
                        ? 'throw new Error("unreached entry");'
                        : `
                if (state !== 1) throw new Error("module prefix");
                await Promise.resolve();
                if (state !== 2) throw new Error("module suffix");
                state = 3;
                worker.postMessage(1);`
                }
            }
            ${variant === "alias" ? "const entry = main; void entry();" : variant === "helper" ? "function boot() { void main(); } boot();" : variant === "conditional" ? "if (false) void main();" : "void main();"}
            state = 2;
            ${variant === "conditional" ? "state = 3; worker.postMessage(1);" : ""}
        `;
        const result = compileSource(source, {
            fileName: resolve(directory, "entry.ts"),
        });
        assert.ok(result.manifest.features.includes("platform:workers"));
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        for (const [path, cpp] of result.cppFiles) {
            const full = resolve(directory, path);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, cpp);
        }
        const executable = resolve(directory, "check.exe");
        buildNativeFixture(
            tools,
            result.manifest.sourceUnits.map(({ path }) =>
                resolve(directory, path),
            ),
            executable,
            [
                "/nologo",
                "/std:c++20",
                "/EHsc",
                "/W4",
                "/WX",
                "/MD",
                "/DBBLITE_WORKERS=1",
                `/I${resolve("native/include")}`,
            ],
        );
        assert.equal(
            execFileSync(executable, {
                encoding: "utf8",
                timeout: 10000,
                stdio: "pipe",
            }),
            "",
        );
    });
}
