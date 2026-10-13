import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
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
bool window_on_application_error(bool rejection, std::uint64_t identity, ApplicationErrors::Callback callback, bool once, ListenerLeasePtr lease) {
    return errors->add(rejection, identity, std::move(callback), once, std::move(lease));
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

test("empty Abort storage needs no capability site", () => {
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
            flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_HAS_UI=1"],
            expectedOutput: "",
            timeoutMs: 10000,
        },
    );
});
