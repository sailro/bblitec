import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const windowRuntime = `
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

test("nested structural host records and explicit unknown-field views retain Window storage", () => {
    const source = `
        setTimeout(()=>globalThis.close(),0);
        type Host={caption?:string;apply?:(value:number)=>number};
        function install(options:{nested:{host:Host}}, add:number):void {
            options.nested.host.caption="ready";
            options.nested.host.apply=(value:number)=>value+add;
        }
        const host=window as Window&Host;
        const options={nested:{host}};
        install(options,3);
        const first=host.apply;
        install(options,5);
        if(host.caption!=="ready"||first?.(2)!==5||host.apply?.(2)!==7)throw new Error("host ownership");
        delete options.nested.host.apply;
        if(host.apply!==undefined||first?.(3)!==6)throw new Error("host deletion");
        const unknownHost=window as unknown as Record<string,unknown>;
        const absent=unknownHost.metadata as {version?:string}|undefined;
        if(absent!==undefined)throw new Error("unwritten field");
        (window as Window&{metadata?:{version?:string}}).metadata={version:"current"};
        const stored=unknownHost.metadata as {version?:string}|undefined;
        if(stored?.version!=="current")throw new Error("view identity");
    `;
    const result = compileSource(source);
    assert.equal(result.manifest.deferredCapabilities, undefined);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(
        tools,
        "window-properties/nested-host",
        result.cpp + windowRuntime,
        {
            flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_HAS_UI=1"],
            expectedOutput: "",
            timeoutMs: 10000,
        },
    );
});

test("Window admission preserves imported static factories, inherited members and structural host receivers", (t) => {
    const directory = resolve("artifacts/window-static-dispatch");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "factory.ts"),
        `
        export class Factory {
            static readonly initial = 3;
            static current = 4;
            static create(value: number): {value: number} { return {value}; }
            static async load(value: number): Promise<{value: number}> { return Factory.create(value); }
        }
    `,
    );
    const result = compileSource(
        `
        import {Factory as Source} from "./factory.js";
        class Derived extends Source {}
        type Host = {caption?: string; read?: (value: number) => number};
        class Access {
            static host(): Window & Host { return window as Window & Host; }
        }
        function install(host: Host): void {
            host.caption = "ready";
            host.read = (value: number) => value + 3;
        }
        setTimeout(() => { globalThis.close(); }, 0);
        const item = await Source.load(Source.initial);
        if (item.value !== 3 || Derived.create(5).value !== 5) throw new Error("static factory");
        Source.current = 6;
        if (Derived.current !== 6) throw new Error("inherited static field");
        const host = window as Window & Host;
        install(host);
        if (Access.host().caption !== "ready" || host.read?.(4) !== 7)
            throw new Error("structural Window receiver");
    `,
        { fileName: resolve(directory, "entry.ts") },
    );
    assert.ok(result.manifest.features.includes("platform:workers"));
    assert.match(result.cpp, /dom_window_property/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "window-static-dispatch",
        result.cpp + windowRuntime,
        {
            flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_HAS_UI=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});

test("Window extension admission leaves native resource property chains to their owner", () => {
    const result = compileSource(`
        import { createEngine, createSceneContext } from "@babylonjs/lite";
        setTimeout(() => { globalThis.close(); }, 0);
        const engine = await createEngine(document.createElement("canvas"));
        const scene = createSceneContext(engine);
        scene.imageProcessing.exposure = 1.25;
        scene.imageProcessing.contrast = 0.75;
        scene.imageProcessing.toneMappingEnabled = false;
        const host = window as Window & {caption?: string};
        host.caption = "ready";
    `);
    assert.ok(result.manifest.features.includes("platform:workers"));
    assert.match(result.cpp, /\.environment\.exposure = 1\.25f;/);
    assert.match(result.cpp, /\.environment\.contrast = 0\.75f;/);
    assert.match(result.cpp, /\.environment\.tone_mapping_enabled = false;/);
    assert.match(result.cpp, /dom_window_property/);
});

test("Window extension callbacks retain identity and captures through replacement and deletion", (t) => {
    const directory = resolve("artifacts/window-properties-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const metadata = globalThis as typeof globalThis & {info?: {value: number; label?: string}};
        delete metadata.info;
        metadata.info = {value: 1};
        metadata.info = {value: 2, label: "next"};
        if (metadata.info.label !== "next") throw new Error("declared layout before read");
        const target = globalThis as typeof globalThis & {snapshot?: () => number};
        const absentCall = target.snapshot?.();
        if (absentCall !== undefined) throw new Error("unassigned optional call");
        if (target.snapshot !== undefined) throw new Error("unassigned callback");
        const infoTarget = globalThis as typeof globalThis & {identity?: {version?: string; revision?: string}};
        const initial = infoTarget.identity;
        if ((initial?.version ?? "unknown") !== "unknown") throw new Error("unassigned record");
        const observations: Array<() => string> = [];
        observations.push(() => infoTarget.identity?.version ?? "unknown");
        infoTarget.identity = {version: "one"};
        if (observations[0]!() !== "one") throw new Error("deferred extension read");
        const oldIdentity = infoTarget.identity;
        infoTarget.identity = {version: "two", revision: "abc"};
        if (oldIdentity?.version !== "one" || observations[0]!() !== "two") throw new Error("record snapshot");
        delete infoTarget.identity;
        if (observations[0]!() !== "unknown") throw new Error("removed record");
        let count = 1;
        const snapshot = () => count;
        target.snapshot = snapshot;
        const stored = target.snapshot;
        if (stored !== snapshot) throw new Error("callback identity");
        count = 2;
        if (stored!() !== 2) throw new Error("retained capture");
        delete target.snapshot;
        if (target.snapshot !== undefined) throw new Error("deleted extension");
        target.snapshot = () => 3;
        if (target.snapshot!() !== 3 || stored!() !== 2) throw new Error("replacement ownership");
        delete target.snapshot;
        const cleanups: Array<() => void> = [];
        const objectTarget = globalThis as typeof globalThis & {objectSnapshot?: () => unknown};
        async function install(value: number) {
            const snapshot = () => ({value});
            objectTarget.objectSnapshot = snapshot;
            cleanups.push(() => {
                if (objectTarget.objectSnapshot === snapshot) delete objectTarget.objectSnapshot;
            });
        }
        await install(4);
        await install(5);
        cleanups[0]!();
        if (objectTarget.objectSnapshot === undefined) throw new Error("old cleanup removed replacement");
        cleanups[1]!();
        if (objectTarget.objectSnapshot !== undefined) throw new Error("owned cleanup retained snapshot");
        globalThis.close();
    `,
        { fileName: resolve(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "window-properties-check",
        result.cpp + windowRuntime,
        {
            flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_HAS_UI=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});

test("Window extension records refuse borrowed dispatch events", () => {
    const directory = resolve("artifacts/window-properties-borrowed");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    assert.throws(
        () =>
            compileSource(
                `
                const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
                worker.terminate();
                const target = window as Window & {record?: {event: KeyboardEvent}};
                const before = target.record;
                window.addEventListener("keydown", event => { target.record = {event}; });
            `,
                { fileName: resolve(directory, "entry.ts") },
            ),
        /borrowed.*event|event.*dispatch/i,
    );
});
