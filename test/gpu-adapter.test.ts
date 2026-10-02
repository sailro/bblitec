import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const inspectSource = `
interface Info { readonly vendor?: string; readonly description?: string; }
interface Source { requestAdapter(options?: GPURequestAdapterOptions): Promise<{readonly info?: Info} | null>; }
function vendor(info: Info | null | undefined): string {
    const name = info?.vendor;
    return typeof name === "string" ? name.trim().toLowerCase() : "";
}
function same(left: Info | null | undefined, right: Info | null | undefined): boolean { return left === right; }
async function inspect(gpu: Source | undefined = typeof navigator === "undefined" ? undefined : navigator.gpu): Promise<string> {
    if (!gpu) return "absent";
    try { const adapter = await gpu.requestAdapter({powerPreference:"high-performance"}); return vendor(adapter?.info); }
    catch { return "unavailable"; }
}
`;

const adapterSource = `${inspectSource}
async function main(): Promise<void> {
    const gpu = window.navigator.gpu;
    let evaluations = 0;
    function options(): GPURequestAdapterOptions { ++evaluations; return {powerPreference:"high-performance"}; }
    let synchronous = true;
    let reactions = 0;
    const pending = gpu.requestAdapter(options());
    const reaction = pending.then(adapter => {
        if (synchronous || !adapter) throw new Error("request timing");
        ++reactions;
    });
    synchronous = false;
    const adapter = await pending;
    await reaction;
    if (!adapter || evaluations !== 1 || reactions !== 1) throw new Error("request result");
    const alias = await pending;
    const other = await globalThis.navigator.gpu.requestAdapter();
    if (!other) throw new Error("second adapter request");
    if (adapter !== alias || adapter === other || adapter.info !== adapter.info || adapter.info === other.info)
        throw new Error("adapter identity");
    const info = adapter.info;
    if (!same(info, adapter.info) || same(info, other.info) || same(info, null)) throw new Error("structural view identity");
    const kept: GPUAdapterInfo[] = [info];
    await Promise.resolve();
    if (kept[0] !== info || typeof info.vendor !== "string" || typeof info.architecture !== "string" ||
        typeof info.device !== "string" || typeof info.description !== "string") throw new Error("info storage");
    if (vendor(info) !== info.vendor.trim().toLowerCase() || await inspect() !== vendor(info))
        throw new Error("structural metadata view");
    const withIgnored = await gpu.requestAdapter({powerPreference:"high-performance", ignored: ++evaluations});
    if (!withIgnored || evaluations !== 2) throw new Error("ignored dictionary argument evaluation");
    let rejected = 0;
    try { await gpu.requestAdapter({powerPreference:"low-power"}); } catch { ++rejected; }
    try { await gpu.requestAdapter({forceFallbackAdapter:true}); } catch { ++rejected; }
    try { await gpu.requestAdapter({featureLevel:"compatibility"}); } catch { ++rejected; }
    try { await gpu.requestAdapter({xrCompatible:true}); } catch { ++rejected; }
    try { await gpu.requestAdapter({powerPreference:""}); } catch { ++rejected; }
    if (rejected !== 5) throw new Error("unsupported selection policy");
    globalThis.close();
}
void main();
`;

test("adapter requests preserve asynchronous settlement, info identity and structural helper views", (t) => {
    const result = compileSource(adapterSource);
    assert.ok(result.manifest.features.includes("platform:window"));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "gpu-adapter/semantics",
        result.cpp +
            `
namespace bbl::pal {
struct AdapterFixtureServices final : HostServices {
    const void* graphics_identity() const override { return this; }
    std::optional<GpuAdapterInfo> graphics_adapter_info() const override {
        return GpuAdapterInfo{"vendor-id", "architecture-id", "device-id", "Fixture device"};
    }
};
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop, "", std::make_shared<AdapterFixtureServices>());
    loop.run([&] { initialize(realm); });
    return 0;
}
}
`,
        {
            defines: ["BBLITE_WORKERS=1", "BBLITE_HAS_UI=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});

test("adapter host absence and metadata errors settle on the owner realm", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "gpu-adapter/host-boundaries",
        readFileSync("test/fixtures/gpu-adapter-host-check.cpp", "utf8"),
        { defines: ["BBLITE_WORKERS=1"], timeoutMs: 10000, expectedOutput: "" },
    );
});

for (const operation of [
    "await adapter.requestDevice()",
    "adapter.info.vendor = 'changed'",
    "adapter.info['vendor'] = 'changed'",
    "adapter.info = adapter.info",
    "JSON.stringify(adapter)",
    "JSON.stringify(adapter.info)",
    "Object.keys(adapter.info)",
])
    test(`GPU objects refuse unsupported operation: ${operation}`, () => {
        assert.throws(() =>
            compileSource(
                `async function main(){const adapter=await navigator.gpu.requestAdapter(); if(adapter){${operation};}}void main();`,
            ),
        );
    });

test("adapter options refuse accessor records", () => {
    assert.throws(
        () =>
            compileSource(
                `void navigator.gpu.requestAdapter({get powerPreference(){return "high-performance" as const;}});`,
            ),
        /plain data properties/,
    );
});

test("GPU adapter info refuses structured cloning into another realm", () => {
    const directory = resolve("artifacts/gpu-adapter/clone-boundary");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "worker.ts"),
        'self.addEventListener("message", (event: MessageEvent<number>) => self.postMessage(event.data));',
    );
    assert.throws(() =>
        compileSource(
            `
        async function main() {
            const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) worker.postMessage(adapter.info);
        }
        void main();
    `,
            { fileName: join(directory, "entry.ts") },
        ),
    );
});

for (const setup of [
    "const request = navigator.gpu.requestAdapter; void request();",
    "const object = { request: navigator.gpu.requestAdapter }; void object.request();",
])
    test(`GPU requests require the original receiver: ${setup}`, () => {
        assert.throws(() => compileSource(setup));
    });

for (const backend of ["sdl", "dawn"] as const)
    test(`${backend} queries the real selected GPU device before generated adapter requests`, (t) => {
        const tools = optionalNativeFixtureTools();
        const dawnRoot = resolve("artifacts/tools/dawn");
        if (
            !tools ||
            (backend === "dawn" &&
                !existsSync(join(dawnRoot, "lib/webgpu_dawn.lib")))
        ) {
            t.skip("Native backend fixture dependencies unavailable.");
            return;
        }
        const directory = resolve("artifacts/gpu-adapter", backend);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            join(directory, "program.hpp"),
            compileSource(adapterSource).cpp,
        );
        const exe = join(directory, "check.exe");
        runNativeFixtureCompiler(tools, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/MD",
            "/utf-8",
            "/DBBLITE_WORKERS=1",
            "/DBBLITE_HAS_UI=1",
            `/DADAPTER_${backend.toUpperCase()}=1`,
            "/Inative/include",
            "/Inative/src",
            `/I${directory}`,
            `/external:I${join(nativeFixtureVcpkgRoot, "include")}`,
            `/external:I${join(dawnRoot, "include")}`,
            "/external:W0",
            `/Fo:${directory}/`,
            `/Fe:${exe}`,
            "test/fixtures/gpu-adapter-device-check.cpp",
            "/link",
            backend === "sdl"
                ? join(nativeFixtureVcpkgRoot, "lib/SDL3.lib")
                : join(dawnRoot, "lib/webgpu_dawn.lib"),
        ]);
        assert.equal(
            execFileSync(exe, {
                encoding: "utf8",
                timeout: 30000,
                windowsHide: true,
                env: {
                    ...process.env,
                    PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${join(dawnRoot, "bin")};${process.env.PATH ?? ""}`,
                },
            }),
            "",
        );
    });
