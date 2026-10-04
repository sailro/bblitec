import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runRmlUiFixture,
} from "./native-fixture.js";

const deferredCapabilities = "runtime-throw" as const;
const realm = `setTimeout(()=>globalThis.close(),0);`;
const runtime = `
#include <bblite/pal_application_errors.hpp>
namespace bbl {
void on_visibility_change(Engine& engine, std::size_t identity, js::Callback<void(bool)> callback, bool once) {
    engine.visibility_change_callbacks.add(identity, std::move(callback), once);
}
}
namespace bbl::pal {
ApplicationErrors* errors = nullptr;
Engine& window_document_engine() { static Engine engine; return engine; }
void window_on_application_error(bool rejection, std::uint64_t identity, ApplicationErrors::Callback callback, bool once) {
    errors->add(rejection, identity, std::move(callback), once);
}
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    ApplicationErrors handlers(loop);
    errors = &handlers;
    loop.run([&] { initialize(realm); });
    errors = nullptr;
    return 0;
}
}
`;

test("empty nominal Abort storage needs no successful producer or capability site", () => {
    const source = `const signals:Array<AbortSignal>=[];const controllers:Array<AbortController>=[];if(signals.length+controllers.length!==0)throw new Error("empty storage");`;
    const result = compileSource(source, { deferredCapabilities });
    assert.equal(result.manifest.deferredCapabilities, undefined);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(
        tools,
        "deferred-dom-lifetimes/nominal-storage",
        result.cpp,
        { expectedOutput: "" },
    );
});

test("Abort nominal results preserve later sites and callback diagnostics after a throwing constructor", () => {
    const source =
        realm +
        `
        let caught=0;
        try {
            const controller=new AbortController();
            const signal=controller.signal;
            signal.throwIfAborted();
            if(signal.aborted)throw new Error("state");
            controller.abort("reason");
            window.addEventListener("blur",()=>{atob("lazy");},{signal});
        } catch(error) {
            if(!error.message.includes("dom:AbortController.constructor"))throw new Error("capability");
            ++caught;
        }
        if(caught!==1)throw new Error("constructor completion");
    `;
    assert.throws(() => compileSource(source), /Unsupported constructor/);
    const result = compileSource(source, { deferredCapabilities });
    assert.deepEqual(
        result.manifest.deferredCapabilities?.map((site) => site.id),
        [
            "dom:AbortController.constructor",
            "dom:AbortController.signal",
            "dom:AbortSignal.throwIfAborted",
            "dom:AbortSignal.aborted",
            "dom:AbortController.abort",
            "dom:atob",
            "dom:EventTarget.addEventListener.signal",
        ],
    );
    assert.throws(
        () =>
            compileSource(
                source.replace(
                    'atob("lazy")',
                    "new FinalizationRegistry(() => {})",
                ),
                {
                    deferredCapabilities,
                },
            ),
        /Unsupported constructor/,
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(
        tools,
        "deferred-dom-lifetimes/abort",
        result.cpp + runtime,
        {
            defines: ["BBLITE_WORKERS=1", "BBLITE_HAS_UI=1"],
            expectedOutput: "",
            timeoutMs: 10000,
        },
    );
});

test("signal dictionaries preserve optional receivers, eager options and lazy ordinary listeners", () => {
    const result = compileSource(
        realm +
            `
        let order="";let hits=0;
        function flag(label:string):boolean {order+=label;return false;}
        const listener=()=>{++hits;};
        const targets:Array<Window|null>=[null,window];
        for(let i=0;i<targets.length;++i) targets[i]?.addEventListener("blur",listener,{
            capture:flag("a"),signal:undefined,passive:flag("b"),extra:flag("c")
        });
        if(order!=="abc"||hits!==0)throw new Error("argument or lazy order");
        window.dispatchEvent(new Event("blur"));
        if(hits!==1)throw new Error("ordinary listener");
        window.removeEventListener("blur",listener);
        window.dispatchEvent(new Event("blur"));
        if(hits!==1)throw new Error("listener removal");
        document.addEventListener("visibilitychange",()=>{++hits;},{signal:undefined,once:flag("d")});
        window.addEventListener("error",()=>{++hits;},{signal:undefined,once:flag("e")});
        if(order!=="abcde"||hits!==1)throw new Error("service listener options");
        function listenOptional(signal:AbortSignal|undefined):void {
            window.addEventListener("focus",listener,{...(signal?{signal}:{}),once:true});
        }
        const optionalSignals:Array<AbortSignal|undefined>=[undefined];
        for(const signal of optionalSignals)listenOptional(signal);
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("focus"));
        if(hits!==2)throw new Error("conditional signal spread");
    `,
        { deferredCapabilities },
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(
        tools,
        "deferred-dom-lifetimes/absent-signal",
        result.cpp + runtime,
        {
            defines: ["BBLITE_WORKERS=1", "BBLITE_HAS_UI=1"],
            expectedOutput: "",
            timeoutMs: 10000,
        },
    );
});

test("tabIndex bridge failures evaluate receiver and RHS once without changing attributes", (t) => {
    const directory = resolve("artifacts/deferred-dom-lifetimes");
    mkdirSync(directory, { recursive: true });
    const source =
        realm +
        `
        let order="";let caught=0;
        const panel=document.createElement("button");
        function selected():HTMLButtonElement {order+="r";return panel;}
        function index():number {order+="v";return -1;}
        try {selected().tabIndex=index();}catch{++caught;}
        try {const value=selected().tabIndex;if(value>0)throw new Error("unexpected");}catch{++caught;}
        if(order!=="rvr"||caught!==2)throw new Error("property effects");
        if(panel.getAttribute("tabindex")!==null)throw new Error("deferred write changed state");
    `;
    assert.equal(
        compileSource(source).manifest.deferredCapabilities,
        undefined,
    );
    const result = compileSource(source, { deferredCapabilities });
    assert.deepEqual(
        result.manifest.deferredCapabilities?.map((site) => site.operation),
        ["write", "read"],
    );
    writeFileSync(resolve(directory, "program.hpp"), result.cpp);
    assert.ok(optionalNativeFixtureTools(), "Native fixture compiler required");
    assert.ok(
        existsSync(
            resolve(
                process.env.BBLITE_RMLUI_DIR ?? "artifacts/tools/rmlui",
                "lib/rmlui.lib",
            ),
        ),
        "Pinned RmlUi library required",
    );
    runRmlUiFixture(t, "deferred-dom-lifetimes", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});
