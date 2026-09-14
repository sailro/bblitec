import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("application errors dispatch before engine creation with native cancellation and rejection timing", t => {
    const directory = resolve("artifacts/application-errors");
    mkdirSync(directory, {recursive:true});
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const source = `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        let predicateCalls = 0;
        function counted(value:boolean):boolean { predicateCalls++; return value; }
        function hostFeature():boolean {
            const agent = navigator.userAgent;
            const extension = (globalThis as {optionalHost?: {enabled?:boolean}}).optionalHost;
            if (extension?.enabled === true) return true;
            return /^optional-shell\\//i.test(agent);
        }
        function unavailableOperation():void { eval("unsupported runtime script"); }
        function initializeFeature():void { if (!hostFeature()) return; unavailableOperation(); }
        interface Service { initialize():void; change(value:boolean):boolean; }
        const services:Service[] = [{
            initialize:initializeFeature,
            change:(value:boolean):boolean => { if (!hostFeature()) return counted(value); unavailableOperation(); return true; },
        }];
        services[0]!.initialize();
        if (services[0]!.change(false) || predicateCalls !== 1) throw new Error("predicate effects and stored return");
        let dynamicPredicateCalls = 0;
        function dynamicPredicate():boolean { dynamicPredicateCalls++; return dynamicPredicateCalls > 1; }
        if (dynamicPredicate() || dynamicPredicateCalls !== 1) throw new Error("declined predicate effects");
        if (!dynamicPredicate() || dynamicPredicateCalls !== 2) throw new Error("dynamic predicate result");
        const pattern = /a/g;
        if (!pattern.test("a") || pattern.test("a")) throw new Error("stored regex state");
        function documentAvailable(host: {document: Document | null}): boolean {
            return !!host.document && host.document === document;
        }
        if (!documentAvailable({document}) || documentAvailable({document:null})) throw new Error("document dependency");
        if (document !== globalThis.document || (document as unknown) === window) throw new Error("document identity");
        interface HostBridge { isDesktop: boolean; close(): void; }
        function hostAvailable(bridge: HostBridge | undefined): boolean {
            return bridge?.isDesktop === true;
        }
        const bridge = (globalThis as {externalHost?: HostBridge}).externalHost;
        if (hostAvailable(bridge)) throw new Error("absent host extension");
        if (!hostAvailable({isDesktop:true, close:():void => {}})) throw new Error("present host extension");
        let bridgeReads = 0;
        function readBridge(): {isDesktop:boolean} | undefined {
            bridgeReads++;
            return bridgeReads === 1 ? {isDesktop:true} : undefined;
        }
        if (readBridge()?.isDesktop !== true || bridgeReads !== 1) throw new Error("optional receiver evaluated once");
        let errors = 0;
        let recovered = 0;
        function onError(event: ErrorEvent): void {
            const target = event.target as unknown;
            if (!!target && target !== window && typeof (target as {tagName?: unknown}).tagName === "string") throw new Error("resource target");
            if (event.target !== window || event.message !== "failure" || !(event.error instanceof Error)) throw new Error("event payload");
            if (event.error.message !== "failure") throw new Error("error message");
            event.preventDefault();
            if (!event.defaultPrevented) throw new Error("cancellation");
            errors++;
        }
        interface Registry { identity<T>(value:T): T; onError(event: ErrorEvent): void; }
        const registry: Registry = { identity: <T>(value:T):T => value, onError: () => {} };
        registry.onError = onError;
        window.addEventListener("error", registry.onError);
        window.removeEventListener("error", registry.onError);
        window.addEventListener("error", registry.onError, {once:true});
        registry.onError = (_event: ErrorEvent): void => { throw new Error("replaced handler must not change registration"); };
        window.removeEventListener("error", registry.onError);
        window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
            if (errors !== 1 || recovered !== 1 || event.reason.message !== "rejected") throw new Error("rejection payload");
            event.preventDefault();
            globalThis.close();
        });
        queueMicrotask(() => { throw new Error("failure"); });
        async function reject(message: string): Promise<void> { throw new Error(message); }
        reject("handled").catch(() => {});
        const pending = reject("handled in microtask");
        queueMicrotask(() => { pending.catch(() => { recovered++; }); });
        reject("rejected");
    `;
    const entry = resolve(directory, "entry.ts");
    writeFileSync(entry, source);
    const result = compileSource(source, {fileName:entry});
    assert.ok(result.manifest.features.includes("platform:window"));
    assert.match(result.cpp, /window_on_application_error/);
    const escaping = source.replace('errors++;', 'setTimeout(() => { if (event.message) globalThis.close(); }, 0); errors++;');
    assert.throws(() => compileSource(escaping, {fileName:entry}), /escaping callback cannot capture platform event|borrowed platform event cannot escape/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    writeFileSync(resolve(directory, "program.hpp"), result.cpp);
    const cpp = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(cpp, `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <bblite/pal_application_errors.hpp>
        #include <sstream>
        #include <cassert>
        namespace bbl::pal {
            Engine document;
            ApplicationErrors* errors = nullptr;
            Engine& window_document_engine() { return document; }
            const void* window_document_identity() { static const bool identity = true; return &identity; }
            void window_on_application_error(bool rejection, std::uint64_t id, ApplicationErrors::Callback callback, bool once) { errors->add(rejection, id, std::move(callback), once); }
            void window_off_application_error(bool rejection, std::uint64_t id) { errors->remove(rejection, id); }
            int run_window_application(WorkerEntry initialize, EngineOptions) {
                const js::RealmScope scope;
                EventLoop loop;
                WorkerRealm realm(loop);
                ApplicationErrors handlers(loop);
                errors = &handlers;
                loop.set_timeout([&] { std::cerr << "application did not finish"; loop.close(); }, 100);
                loop.run([&] { initialize(realm); });
                errors = nullptr;
                return 0;
            }
        }
        int main() {
            std::ostringstream reports;
            auto* original = std::cerr.rdbuf(reports.rdbuf());
            const int result = generated_main();
            std::cerr.rdbuf(original);
            assert(result == 0);
            if (!reports.str().empty()) { std::cerr << reports.str(); return 1; }
            {
                const bbl::js::RealmScope scope;
                bbl::pal::EventLoop loop;
                bbl::pal::ApplicationErrors handlers(loop);
                int calls = 0;
                handlers.add(false, 1, [&](bbl::pal::ApplicationErrorEvent& event) {
                    ++calls;
                    event.prevent_default();
                    throw std::runtime_error("listener failure");
                }, true);
                std::cerr.rdbuf(reports.rdbuf());
                loop.run([&] {
                    loop.post([] { throw std::runtime_error("second error"); });
                    loop.post([&] { loop.close(); });
                    throw std::runtime_error("first error");
                });
                std::cerr.rdbuf(original);
                assert(calls == 1);
                assert(reports.str() == "Uncaught application error: listener failure\\nUncaught application error: second error\\n");
            }
        }
    `);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/DBBLITE_WORKERS=1", "/DBBLITE_OFFSCREEN_SURFACES=1", "/DBBLITE_HAS_UI=1",
        "/I", "native/include", `/Fo:${directory}/`, `/Fe:${executable}`, cpp]);
    execFileSync(executable, {stdio:"pipe", timeout:10000});
});
