import assert from "node:assert/strict";
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

test("finite unknown-array writes preserve scalar alternatives and aliases", () => {
    const result = compileSource(`
        const queue: unknown[] = [];
        const alias = queue;
        queue.push(3);
        alias.push("next");
        queue[2] = true;
        if (queue.length !== 3 || queue[0] !== 3 || queue[1] !== "next" || queue[2] !== true)
            throw new Error("finite scalar queue");
        const unrelated: unknown[] = [];
        unrelated.push(new Date(50));
        if (unrelated.length !== 1) throw new Error("distinct source slots");
    `);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(tools, "finite-array-storage/scalars", result.cpp);
});

test("host queues retain Arguments identities across concrete stored callback specializations", () => {
    const result = compileSource(`
        setTimeout(() => globalThis.close(), 0);
        type Host = { queue?: unknown[]; send?: (...values: unknown[]) => void };
        function install(options: {host: Host}): void {
            function send(...values: unknown[]): void {
                options.host.queue ??= [];
                const received = arguments;
                options.host.queue.push(received, received);
                if (received.length !== values.length || received.length < 2) throw new Error("argument count");
            }
            options.host.send = send;
            send("open", { label: "ready", active: true });
            send("clock", new Date(40));
            const update = (mode: "on" | "off"): void => send("policy", "update", {mode, label: "fixed"});
            send("policy", "initial", {mode: "off", label: "fixed"});
            update("on");
            send("configuration", "profile", {visible: false, shared: false, enabled: true, ready: true, title: "view", path: "local"});
            send("event", "begin", {version: "one", locale: "en", platform: "native", mode: "active"});
            send("event", "start", {version: "one", locale: "en", selection: "first", platform: "native", mode: "active"});
            send("event", "failure", {description: "neutral", fatal: true, version: "one", kind: "error", platform: "native", mode: "active"});
        }
        const host = window as Window & Host;
        install({host});
        host.send?.("number", 7);
        host.send?.("state", { count: 2 });
        const saved = host.queue;
        if (!saved || saved.length !== 20) throw new Error("queue length");
        if (saved[0] !== saved[1] || saved[2] !== saved[3] || saved[0] === saved[2])
            throw new Error("arguments identity");
        delete host.send;
        if (host.queue !== saved || saved.length !== 20) throw new Error("retained queue");
        globalThis.close();
    `);
    assert.equal(result.manifest.deferredCapabilities, undefined);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(
        tools,
        "finite-array-storage/host-arguments",
        result.cpp + windowRuntime,
        {
            defines: ["BBLITE_WORKERS=1", "BBLITE_HAS_UI=1"],
            expectedOutput: "",
            timeoutMs: 10000,
        },
    );
});

test("unknown host arrays without a source layout remain unsupported", () => {
    assert.throws(
        () =>
            compileSource(`
        setTimeout(() => globalThis.close(), 0);
        type Host = { queue?: unknown[] };
        const host = window as Window & Host;
        const entries = host.queue;
        if (entries) console.log(entries[0]);
        globalThis.close();
    `),
        /Unsupported data property 'queue' on event-target/,
    );
});
