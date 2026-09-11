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

test("stored async callbacks own suspended state and return retained promises", t => {
    const directory = resolve("artifacts/stored-async-callbacks");
    mkdirSync(directory, {recursive:true});
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const source = `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        let completed = 0;
        let resumed = 0;
        function finish():void { if (++completed === 3) globalThis.close(); }
        function make(offset:number): (input:number) => Promise<number> {
            return async (input:number, options = {delta:input}):Promise<number> => {
                await Promise.resolve();
                resumed++;
                if (input < 0) return offset;
                return offset + options.delta;
            };
        }
        const callbacks: ((input:number) => Promise<number>)[] = [make(10)];
        const pending:Promise<number>[] = [callbacks[0]!(3), callbacks[0]!(-1)];
        callbacks.length = 0;
        if (resumed !== 0) throw new Error("await ran synchronously");
        pending[0]!.then(value => { if(value !== 13) throw new Error("suspended captures and defaults"); finish(); });
        pending[1]!.then(value => { if(value !== 10) throw new Error("early async return"); finish(); });
        const failures: (() => Promise<void>)[] = [async ():Promise<void> => {
            await Promise.resolve();
            throw new Error("expected failure");
        }];
        failures[0]!().catch(error => { if (!String(error).includes("expected failure")) throw new Error("lost rejection"); finish(); });
    `;
    const entry = resolve(directory, "entry.ts");
    writeFileSync(entry, source);
    const result = compileSource(source, {fileName:entry});
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const cpp = resolve(directory, "main.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/MD", "/DBBLITE_WORKERS=1",
        `/I${resolve("native/include")}`, cpp, `/Fo${directory}/`, `/Fe${executable}`]);
    assert.equal(execFileSync(executable, {encoding:"utf8", timeout:10000, stdio:"pipe"}), "");
});

test("worker-free output does not select realm services", () => {
    const result = compileSource("let total = 1; total += 2;");
    assert.ok(!result.manifest.features.includes("platform:workers"));
    assert.doesNotMatch(result.cpp, /WorkerRealm|pal_worker|EventLoop/);
});

test("Window metrics select the native host without static host markup", () => {
    const directory = resolve("artifacts/worker-window-metrics");
    mkdirSync(directory, { recursive: true });
    const entry = resolve(directory, "entry.ts"), worker = resolve(directory, "worker.ts");
    writeFileSync(worker, "self.close();");
    const source = `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        const density = window.devicePixelRatio;
        if (!(density > 0)) throw new Error("pixel density");
        if (!(window.innerWidth > 0) || !(window.innerHeight > 0)) throw new Error("viewport");
        const display = window.screen;
        if (display !== screen || !(screen.width > 0) || !(screen.height > 0) ||
            !(display.availWidth > 0) || !(display.availHeight > 0) || display.colorDepth !== display.pixelDepth) throw new Error("screen");
        if (!window.isSecureContext) throw new Error("native context");
        worker.terminate();
        globalThis.close();
    `;
    writeFileSync(entry, source);
    const result = compileSource(source, {fileName:entry});
    assert.ok(result.manifest.features.includes("platform:window"));
    assert.ok(result.manifest.features.includes("ui:rml"));
    assert.match(result.cpp, /run_window_application/);
    assert.match(result.cpp, /window_device_pixel_ratio/);
    assert.match(result.cpp, /window_viewport_size\(\).width/);
    assert.match(result.cpp, /window_viewport_size\(\).height/);
    assert.match(result.cpp, /window_screen_metrics\(\).available_width/);
    assert.match(result.cpp, /window_screen_identity\(\)/);
    writeFileSync(worker, "const density = window.devicePixelRatio; if (density > 0) self.close();");
    assert.throws(() => compileSource(source, {fileName:entry}), /Window API requires an application realm/);
});

test("Window document queries preserve nullable results and stylesheet helpers", () => {
    const directory = resolve("artifacts/window-queries");
    mkdirSync(directory, {recursive:true});
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const source = `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        function palette(id:string):HTMLStyleElement {
            let sheet = document.getElementById(id) as HTMLStyleElement | null;
            if (sheet === null) {
                sheet = document.createElement("style");
                sheet.id = id;
                document.head.appendChild(sheet);
            }
            sheet.textContent = ".panel { color: red; }";
            return sheet;
        }
        const first = palette("palette"), second = palette("palette");
        if (first !== second) throw new Error("document lookup identity");
        first.remove();
        if (document.getElementById("palette") !== null) throw new Error("removed element lookup");
        globalThis.close();
    `;
    const entry = resolve(directory, "entry.ts");
    writeFileSync(entry, source);
    const result = compileSource(source, {fileName:entry});
    assert.match(result.cpp, /ui_find_element_by_id/);
    assert.match(result.cpp, /ui_add_class_style/);
    assert.ok(result.manifest.features.includes("platform:window"));
});

test("Window clipboard aliases return promises and reload reaches the host", () => {
    const directory = resolve("artifacts/window-services");
    mkdirSync(directory, {recursive:true});
    const entry = resolve(directory, "entry.ts"), worker = resolve(directory, "worker.ts");
    writeFileSync(worker, "self.close();");
    const source = `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
        async function copy():Promise<void> {
            await clipboard?.writeText("sample 🌍");
            location.reload();
        }
        copy();
    `;
    writeFileSync(entry, source);
    const result = compileSource(source, {fileName:entry});
    assert.ok(result.manifest.features.includes("platform:window"));
    assert.match(result.cpp, /co_await bbl::pal::window_clipboard_write/);
    assert.match(result.cpp, /bbl::pal::window_location_reload\(\)/);
    writeFileSync(worker, 'location.reload();');
    assert.throws(() => compileSource(source, {fileName:entry}), /Window API requires an application realm/);
});

test("worker messages preserve compound union tags and inactive payloads", (t) => {
    const directory = resolve("artifacts/worker-compound-tags");
    mkdirSync(directory, { recursive: true });
    const entry = resolve(directory, "entry.ts");
    writeFileSync(resolve(directory, "types.ts"), `
export type Result = {ok: true; value: number} | {ok: false; reason: "invalid"} | {ok: false; reason: "blocked"; key: string};
`);
    writeFileSync(resolve(directory, "echo.ts"), `
import type {Result} from "./types";
self.addEventListener("message", (event: MessageEvent<Result>) => self.postMessage(event.data));
`);
    const source = `
import type {Result} from "./types";
const worker = new Worker(new URL("./echo.ts", import.meta.url), {type: "module"});
let received = 0;
worker.addEventListener("message", (event: MessageEvent<Result>) => {
    const result = event.data;
    if (result.ok) { if (result.value !== 7) throw new Error("success payload"); }
    else if (result.reason === "blocked") { if (result.key !== "entry") throw new Error("blocked payload"); }
    else if (result.reason !== "invalid") throw new Error("invalid tag");
    received++;
    if (received === 3) globalThis.close();
});
worker.postMessage({ok: false, reason: "invalid"});
worker.postMessage({ok: false, reason: "blocked", key: "entry"});
worker.postMessage({ok: true, value: 7});
`;
    writeFileSync(entry, source);
    const result = compileSource(source, {fileName: entry});
    const cpp = resolve(directory, "main.cpp");
    writeFileSync(cpp, result.cpp);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Requires the Windows native fixture compiler."); return; }
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/MD", "/DBBLITE_WORKERS=1",
        `/I${resolve("native/include")}`, cpp, `/Fo${directory}/`, `/Fe${executable}`]);
    execFileSync(executable, {timeout: 10000, stdio: "pipe"});
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
