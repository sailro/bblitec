import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { discoverWindowsBuildTools } from "../src/development-tools.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("module Worker compilation retains per-instance module state and cloned messages", (t) => {
    const directory = resolve("artifacts/worker-compilation-check");
    mkdirSync(directory, { recursive: true });
    const entry = resolve(directory, "entry.ts");
    const worker = resolve(directory, "counter.ts");
    const helper = resolve(directory, "state.ts");
    writeFileSync(helper, `let count = 0;
export function increment(value: number): number { count += value; return count; }
`);
    writeFileSync(worker, `import { increment } from "./state";
function main() { throw new Error("Module helper named main must not run automatically"); }
async function update(amount: number): Promise<number> {
    const value = increment(amount);
    const settled = { value: 0 };
    queueMicrotask(() => { settled.value = value; });
    await Promise.resolve(0);
    return settled.value;
}
self.addEventListener("message", (event: MessageEvent<{ amount: number }>) => {
    void update(event.data.amount).then((value) => {
        queueMicrotask(() => self.postMessage(value));
    }).catch((error: unknown) => { throw new Error(String(error)); });
});
`);
    const source = `const first = new globalThis.Worker(new URL("./counter.ts", import.meta.url), { "type": "module" });
const second = new window.Worker(new window.URL("./counter.ts", import.meta.url), { type: "module" });
let received = 0;
let firstCount = 0;
let secondCount = 0;
first.addEventListener("message", (event: MessageEvent<number>) => {
    firstCount += 2;
    if (event.data !== firstCount) throw new Error("First instance state or clone snapshot is wrong");
    received++;
    if (received === 4) globalThis.close();
});
second.addEventListener("message", (event: MessageEvent<number>) => {
    secondCount += 2;
    if (event.data !== secondCount) throw new Error("Second instance state or clone snapshot is wrong");
    received++;
    if (received === 4) globalThis.close();
});
const message = { amount: 2 };
first.postMessage(message);
second.postMessage(message);
first.postMessage(message);
second.postMessage(message);
message.amount = 100;
`;
    writeFileSync(entry, source);
    const result = compileSource(source, { fileName: entry });
    assert.ok(result.manifest.features.includes("platform:workers"));
    assert.ok(result.manifest.inputs.some(file => file.endsWith("counter.ts")));
    assert.ok(result.manifest.inputs.some(file => file.endsWith("state.ts")));
    assert.equal((result.cpp.match(/void initialize\(\[\[maybe_unused\]\]/g) ?? []).length, 1);
    const cpp = resolve(directory, "main.cpp");
    writeFileSync(cpp, result.cpp);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Requires the Windows native fixture compiler."); return; }
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/MD", "/DBBLITE_WORKERS=1",
        `/I${resolve("native/include")}`, cpp, `/Fo${directory}/`, `/Fe${executable}`,
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8", timeout: 10000, stdio: "pipe" }), "");
    // Nested callbacks in a worker coroutine must emit complete virtual bodies
    // under clang-cl as well as MSVC.
    let clang;
    try { clang = discoverWindowsBuildTools("clangcl"); }
    catch { return; }
    runNativeFixtureCompiler(clang, [
        "/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/MD", "/DBBLITE_WORKERS=1",
        `/I${resolve("native/include")}`, cpp, `/Fo${directory}/`, `/Fe${executable}`,
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8", timeout: 10000, stdio: "pipe" }), "");
});

test("worker-free output does not select realm services", () => {
    const result = compileSource("let total = 1; total += 2;");
    assert.ok(!result.manifest.features.includes("platform:workers"));
    assert.doesNotMatch(result.cpp, /WorkerRealm|pal_worker|EventLoop/);
});

test("compiled workers transfer canvas ownership through discriminated messages", (t) => {
    const directory = resolve("artifacts/worker-canvas-compilation-check");
    mkdirSync(directory, { recursive: true });
    const entry = resolve(directory, "entry.ts");
    writeFileSync(resolve(directory, "canvas.ts"), `
type Incoming = { type: "init"; canvas: OffscreenCanvas; alias: OffscreenCanvas } | { type: "resize"; width: number };
let output: OffscreenCanvas | null = null;
self.addEventListener("message", (event: MessageEvent<Incoming>) => {
    const message = event.data;
    if (message.type === "init") {
        if (message.canvas !== message.alias) throw new Error("Canvas alias was lost");
        output = message.canvas;
    } else if (output) {
        output.width = message.width;
        self.postMessage({ canvas: output }, [output]);
        if (output.width !== 0) throw new Error("Worker canvas was not detached");
    }
});
`);
    const source = `
const worker = new Worker(new URL("./canvas.ts", import.meta.url), { type: "module" });
const canvas = new OffscreenCanvas(40, 30);
worker.addEventListener("message", (event: MessageEvent<{ canvas: OffscreenCanvas }>) => {
    if (event.data.canvas.width !== 80 || event.data.canvas.height !== 30) throw new Error("Canvas round trip lost dimensions");
    globalThis.close();
});
worker.postMessage({ type: "init", canvas, alias: canvas }, [canvas]);
if (canvas.width !== 0) throw new Error("Main canvas was not detached");
worker.postMessage({ type: "resize", width: 80 });
`;
    writeFileSync(entry, source);
    const result = compileSource(source, { fileName: entry });
    const cpp = resolve(directory, "main.cpp");
    writeFileSync(cpp, result.cpp);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Requires the Windows native fixture compiler."); return; }
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/MD", "/DBBLITE_WORKERS=1",
        `/I${resolve("native/include")}`, cpp, `/Fo${directory}/`, `/Fe${executable}`,
    ]);
    execFileSync(executable, { timeout: 10000, stdio: "pipe" });
});
