import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const deferredCapabilities = "runtime-throw" as const;
const runtime = `
namespace bbl::pal {
Engine& window_document_engine() { static Engine engine; return engine; }
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
}
`;

test("URI component encoding preserves coercion, UTF-16 and evaluation order", () => {
    const source = String.raw`
        const values = ["azAZ09-_.!~*'()", " ;/?:@&=+$,#%", "é水😀", "\ud83d", "\ude00"];
        const expected = ["azAZ09-_.!~*'()", "%20%3B%2F%3F%3A%40%26%3D%2B%24%2C%23%25", "%C3%A9%E6%B0%B4%F0%9F%98%80"];
        let index = 0;
        while (index < 3) {
            const want = expected[index]!;
            if (encodeURIComponent(values[index++]!) !== want) throw new Error('encoding');
        }
        if (encodeURIComponent(values[3]! + values[4]!) !== '%F0%9F%98%80') throw new Error('surrogate pair');
        let caught = 0;
        for (const text of [values[3]!, values[4]!, values[3]! + 'x']) {
            try { encodeURIComponent(text); } catch(error) {
                if (error.name !== 'URIError') throw error;
                caught++;
            }
        }
        if (index !== 3 || caught !== 3 || encodeURIComponent(true) !== 'true' || encodeURIComponent(-12.5) !== '-12.5') throw new Error('effects');
        if (new URLSearchParams('x=hello world').toString() !== 'x=hello+world') throw new Error('form encoding');
    `;
    const result = compileSource(source);
    assert.equal(result.manifest.deferredCapabilities, undefined);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "platform-boundaries/uri", result.cpp, {
        expectedOutput: "",
    });
});

test("idle aliases preserve owned callbacks and throw after argument evaluation", () => {
    const source = `
        let effects=0; let callbacks=0; let caught=0;
        const idle = (window as {requestIdleCallback?: (cb:()=>void, options?:{timeout:number})=>number}).requestIdleCallback;
        if (idle) {
            try { idle(()=>{ callbacks++; }, {timeout:++effects}); } catch(error) {
                if (!error.message.includes('dom:Window.requestIdleCallback')) throw error;
                caught++;
            }
        }
        const request=window.requestIdleCallback;
        try { request(deadline=>{callbacks++; if(deadline.didTimeout) deadline.timeRemaining();}); } catch { caught++; }
        const cancel=window.cancelIdleCallback;
        try { cancel(++effects); } catch(error) {
            if (!error.message.includes('dom:Window.cancelIdleCallback')) throw error;
            caught++;
        }
        if(effects!==2 || callbacks!==0 || caught!==3) throw new Error('idle boundary');
        setTimeout(()=>globalThis.close(),0);
    `;
    assert.throws(
        () => compileSource(source),
        /Browser-dependent condition cannot be determined/,
    );
    const result = compileSource(source, { deferredCapabilities });
    const ids = result.manifest.deferredCapabilities!.map((site) => site.id);
    assert.ok(ids.includes("dom:Window.requestIdleCallback"));
    assert.ok(ids.includes("dom:IdleDeadline.didTimeout"));
    assert.ok(ids.includes("dom:IdleDeadline.timeRemaining"));
    assert.throws(
        () =>
            compileSource(
                `
        const readers: Array<(host: EventTarget & {requestIdleCallback?:()=>number})=>void> = [host=>{const idle=host.requestIdleCallback; if(idle)idle();}];
        readers[0]!(document);
        setTimeout(()=>globalThis.close(),0);
    `,
                { deferredCapabilities },
            ),
        /requires a proven Window receiver/,
    );
    assert.throws(
        () =>
            compileSource(
                source.replace(
                    "callbacks++; if",
                    "new FinalizationRegistry(()=>{}); callbacks++; if",
                ),
                { deferredCapabilities },
            ),
        /Unsupported constructor/,
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "platform-boundaries/idle",
        result.cpp + runtime,
        { defines: ["BBLITE_WORKERS=1"], expectedOutput: "" },
    );
});

test("session storage has no successful provider and retains method bodies", () => {
    const source = `
        let caught=0; let effects=0;
        try {
            if(typeof sessionStorage!=='undefined') {
                const storage=sessionStorage;
                storage.setItem('key',String(++effects));
                const value=storage.getItem('key');
                storage.removeItem('key');
                if(value!==null) effects++;
            }
        } catch(error) {
            if(!error.message.includes('dom:Window.sessionStorage')) throw error;
            caught++;
        }
        if(caught!==1 || effects!==0) throw new Error('storage provider');
    `;
    assert.throws(() => compileSource(source), /sessionStorage/);
    const result = compileSource(source, { deferredCapabilities });
    assert.ok(
        result.manifest.deferredCapabilities!.some(
            (site) => site.id === "dom:Window.sessionStorage",
        ),
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "platform-boundaries/storage",
        result.cpp +
            `
namespace bbl::pal {
std::optional<std::string> read_local_storage(const std::string&) { throw std::runtime_error("unexpected storage access"); }
void write_local_storage(const std::string&,const std::string&) { throw std::runtime_error("unexpected storage access"); }
void remove_local_storage(const std::string&) { throw std::runtime_error("unexpected storage access"); }
}
`,
        { expectedOutput: "" },
    );
});

test("surface pixel ratio boundaries retain owner and RHS effects", () => {
    const source = `
        import {createEngine} from '@babylonjs/lite';
        const engine=await createEngine(document.getElementById('renderCanvas') as HTMLCanvasElement);
        let effects=0; let caught=0;
        function owner(){effects++; return engine;}
        try { owner().maxDevicePixelRatio=++effects; } catch(error) {
            if(!error.message.includes('babylon:SurfaceContext.maxDevicePixelRatio')) throw error;
            caught++;
        }
        try { if(owner().maxDevicePixelRatio>0) effects++; } catch {caught++;}
        if(caught!==2 || effects!==3) throw new Error('surface boundary');
    `;
    const result = compileSource(source, { deferredCapabilities });
    assert.deepEqual(
        result.manifest.deferredCapabilities!.map((site) => site.operation),
        ["write", "read"],
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "platform-boundaries/surface",
        result.cpp +
            `namespace bbl { Engine create_engine(EngineOptions) { return {}; } }`,
        { expectedOutput: "" },
    );
});

test("application recovery keeps callback bodies and defers only the missing realm contract", () => {
    const source = `
        import {createEngine,enableDeviceLostSceneRecovery,forceWebGpuDeviceLossForTesting} from '@babylonjs/lite';
        const engine=await createEngine(new OffscreenCanvas(1,1));
        await new Promise<void>(resolve=>setTimeout(resolve,0));
        let caught=0; let callbacks=0;
        try {
            const registration=enableDeviceLostSceneRecovery(engine, {
                onRecovered:()=>{callbacks++;},
                onRecoveryFailed:error=>{if(error.message) callbacks++;},
            });
            registration.disable();
        } catch(error) {
            if(!error.message.includes('babylon:enableDeviceLostSceneRecovery.application')) throw error;
            caught++;
        }
        try { forceWebGpuDeviceLossForTesting(engine); } catch { caught++; }
        if(caught!==2 || callbacks!==0) throw new Error('recovery boundary');
        setTimeout(()=>globalThis.close(),0);
    `;
    const result = compileSource(source, { deferredCapabilities });
    assert.ok(!result.manifest.features.includes("engine:device-recovery"));
    assert.throws(
        () =>
            compileSource(
                source.replace(
                    "callbacks++;},",
                    "new FinalizationRegistry(()=>{}); callbacks++;},",
                ),
                { deferredCapabilities },
            ),
        /Unsupported constructor/,
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "platform-boundaries/recovery",
        `#include <bblite/pal_async_engine.hpp>
namespace bbl::pal {
std::shared_ptr<Engine> create_realm_engine(EngineOptions, const std::shared_ptr<OffscreenCanvas>&) { return std::make_shared<Engine>(); }
}
` +
            result.cpp +
            runtime +
            `
namespace bbl {
void disable_device_recovery(const std::shared_ptr<DeviceRecoveryRegistration>&) { throw std::runtime_error("unexpected recovery"); }
}
`,
        {
            defines: ["BBLITE_WORKERS=1", "BBLITE_OFFSCREEN_SURFACES=1"],
            expectedOutput: "",
        },
    );
});
