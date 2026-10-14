import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runRmlUiFixture,
    windowApplicationHost,
} from "./native-fixture.js";

const deferredCapabilities = "runtime-throw" as const;

/** An application realm on the native event loop, without a display. */
const realmHost = `
namespace bbl::pal {
Engine& window_document_engine() { static Engine engine; return engine; }
}
${windowApplicationHost()}
`;

/** The application's shapes: an idle feature probe, a stored alias, confirmations and fullscreen. */
const applicationShapes = `
const browserIdle = (work: (remainingMs: number) => void, urgent: boolean): void => {
    if (typeof requestIdleCallback === "function") {
        requestIdleCallback((deadline) => work(deadline.timeRemaining()), urgent ? { timeout: 100 } : undefined);
    } else {
        setTimeout(() => work(urgent ? 0 : Number.POSITIVE_INFINITY), urgent ? 0 : 100);
    }
};
let saved = 0;
const idleSave = (): void => {
    const ric = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) {
        ric(() => { saved++; }, { timeout: 2000 });
    } else {
        saved++;
    }
};
browserIdle((remaining) => { if (remaining < 0) idleSave(); }, Math.random() < 0.5);
const rules = [{ do: { action: "move" } }];
const remove = document.createElement("button");
document.body.append(remove);
remove.onclick = (): void => { if (confirm(\`Delete rule \${1} (\${rules[0]!.do.action})?\`)) rules.splice(0, 1); };
const input = document.createElement("input");
input.type = "checkbox";
document.body.append(input);
input.checked = !!document.fullscreenElement;
input.addEventListener("change", () => {
    if (input.checked) {
        void document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
        void document.exitFullscreen?.().catch(() => {});
    }
});
document.addEventListener("fullscreenchange", () => {
    input.checked = !!document.fullscreenElement;
});
`;

test("idle callbacks, message boxes and fullscreen lower natively in both modes", () => {
    for (const options of [{}, { deferredCapabilities }]) {
        const result = compileSource(applicationShapes, options);
        assert.equal(result.manifest.deferredCapabilities, undefined);
        for (const feature of [
            "platform:idle-callbacks",
            "platform:window",
            "ui:rml",
        ])
            assert.ok(result.manifest.features.includes(feature), feature);
        assert.match(result.cpp, /#include <bblite\/pal_idle_callbacks\.hpp>/);
        assert.equal(
            result.cpp.match(/#include <bblite\/pal_idle_callbacks\.hpp>/g)
                ?.length,
            1,
        );
        assert.match(result.cpp, /bbl::pal::request_idle_callback\(/);
        assert.match(result.cpp, /->time_remaining\(\)/);
        assert.match(result.cpp, /bbl::pal::window_message_box\(true, /);
        assert.match(result.cpp, /bbl::pal::window_request_fullscreen\(/);
        assert.match(result.cpp, /bbl::pal::window_exit_fullscreen\(\)/);
        assert.match(result.cpp, /bbl::pal::window_fullscreen_element\(\)/);
        assert.match(result.cpp, /bbl::pal::window_on_fullscreen_change\(/);
        assert.doesNotMatch(result.cpp, /deferred_capability|Deferred/);
    }
});

test("Window services refuse other realms, receivers and signatures precisely", () => {
    const directory = resolve("artifacts/window-services/refusals");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "worker.ts"),
        `requestIdleCallback(() => {}); self.close();`,
    );
    assert.throws(
        () =>
            compileSource(
                `const worker = new Worker(new URL("./worker.ts", import.meta.url), {type: "module"}); worker.terminate();`,
                { fileName: join(directory, "entry.ts") },
            ),
        /This Window API requires an application realm/,
    );
    assert.throws(
        () =>
            compileSource(`
        const readers: Array<(host: EventTarget & {requestIdleCallback?: () => number}) => void> = [host => { const idle = host.requestIdleCallback; if (idle) idle(); }];
        readers[0]!(document);
    `),
        /requires a proven Window receiver/,
    );
    assert.throws(
        () =>
            compileSource(`
        const idle = (window as {requestIdleCallback?: (cb: (deadline: {timeRemaining(): number}) => void) => number}).requestIdleCallback;
        if (idle) idle(deadline => { deadline.timeRemaining(); });
    `),
        /requestIdleCallback value takes a callback of an IdleDeadline or of nothing/,
    );
    assert.throws(
        () =>
            compileSource(
                `const page: Document = document; void page.exitFullscreen();`,
            ),
        /exitFullscreen is admitted on the Window application's document/,
    );
    // prompt has no faithful SDL form: it stays a strict refusal and a deferred site.
    assert.throws(() => compileSource(`prompt("name");`));
    assert.deepEqual(
        compileSource(`try { prompt("name"); } catch {}`, {
            deferredCapabilities,
        }).manifest.deferredCapabilities?.map((site) => site.id),
        ["dom:prompt"],
    );
});

test("idle callbacks run in idle periods in order, time out, cancel and keep aliases", () => {
    const result = compileSource(`
        const order: string[] = [];
        const fail = (message: string): never => { throw new Error(message); };
        const browserIdle = (work: (remainingMs: number) => void, urgent: boolean): void => {
            if (typeof requestIdleCallback === "function") {
                requestIdleCallback((deadline) => work(deadline.timeRemaining()), urgent ? { timeout: 100 } : undefined);
            } else {
                setTimeout(() => work(urgent ? 0 : Number.POSITIVE_INFINITY), urgent ? 0 : 100);
            }
        };
        function finish(): void {
            const expected = "sync,timer,idle1:false,micro1,idle2,idle3,nested,timeout:true:0,alias,prebake:true";
            if (order.join(",") !== expected) fail("order " + order.join(","));
            globalThis.close();
        }
        function timedOut(): void {
            requestIdleCallback((deadline) => {
                order.push("timeout:" + deadline.didTimeout + ":" + deadline.timeRemaining());
                const ric = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
                if (ric) ric(() => {
                    order.push("alias");
                    browserIdle((remaining) => {
                        order.push("prebake:" + (remaining > 0 && remaining <= 50));
                        finish();
                    }, Math.random() < 2);
                }, { timeout: 2000 });
                else fail("alias");
            }, { timeout: 1 });
            // The task outlasts the timeout, so the timed-out call precedes any idle period.
            let spin = 0;
            for (let step = 0; step < 50000000; step++) spin = (spin + step) % 7;
            if (spin < 0) fail("spin");
        }
        const first = requestIdleCallback((deadline) => {
            order.push("idle1:" + deadline.didTimeout);
            const left = deadline.timeRemaining();
            if (!(left > 0 && left <= 50)) fail("deadline " + left);
            queueMicrotask(() => order.push("micro1"));
        });
        const cancelled = window.requestIdleCallback(() => order.push("cancelled"));
        const second = requestIdleCallback(() => {
            order.push("idle2");
            requestIdleCallback(() => { order.push("nested"); timedOut(); });
        });
        const third = requestIdleCallback(() => order.push("idle3"), { timeout: 1000 });
        const cancel = window.cancelIdleCallback;
        const dropped = requestIdleCallback(() => order.push("dropped"));
        cancel(dropped);
        setTimeout(() => order.push("timer"), 0);
        cancelIdleCallback(cancelled);
        cancelIdleCallback(12345);
        if (first !== 1 || cancelled !== 2 || second !== 3 || third !== 4 || dropped !== 5) fail("handles");
        order.push("sync");
    `);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "The native fixture compiler is required.");
    runGeneratedProgram(tools, "window-services/idle", result.cpp + realmHost, {
        flags: ["/DBBLITE_WORKERS=1"],
        expectedOutput: "",
        timeoutMs: 60000,
    });
});

test("idle deadlines end at the next predicted frame while a repaint is pending", () => {
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "The native fixture compiler is required.");
    runGeneratedProgram(
        tools,
        "window-services/idle-frames",
        `
        #include <bblite/pal_event_loop.hpp>
        #include <cassert>
        #include <thread>
        using namespace bbl::pal;
        int main() {
            using namespace std::chrono_literals;
            EventLoop loop;
            int frames = 0;
            EventLoop::AnimationCallback frame = [&](double) {
                if (++frames < 6) loop.request_animation_frame(frame);
            };
            loop.request_animation_frame(frame);
            // Display ticks 8 ms apart establish the frame interval.
            for (int tick = 0; tick < 4; ++tick) {
                loop.inbox()->animation_frame(EventLoop::Clock::now());
                while (loop.poll()) {
                }
                std::this_thread::sleep_for(8ms);
            }
            double during = -1, after = -1;
            loop.request_idle_callback([&](const IdleDeadline& deadline) {
                assert(!deadline.did_timeout);
                during = deadline.time_remaining();
            }, 0);
            while (during < 0)
                assert(loop.poll());
            // The display interval (8 ms ticks, coarser with a coarse sleep) bounds the period.
            assert(during > 0 && during <= 34);
            // Without a pending repaint the idle period lasts up to 50 ms.
            while (frames < 6) {
                loop.inbox()->animation_frame(EventLoop::Clock::now());
                while (loop.poll()) {
                }
            }
            loop.request_idle_callback([&](const IdleDeadline& deadline) {
                after = deadline.time_remaining();
            }, 0);
            while (after < 0)
                assert(loop.poll());
            assert(after > 40 && after <= 50);
            // A timed-out call has no time remaining.
            bool timed_out = false;
            const auto handle = loop.request_idle_callback([&](const IdleDeadline& deadline) {
                timed_out = deadline.did_timeout && deadline.time_remaining() == 0;
            }, 1);
            loop.post([] { std::this_thread::sleep_for(5ms); });
            assert(loop.poll());
            assert(loop.poll() && timed_out);
            loop.cancel_idle_callback(handle);
            return 0;
        }
    `,
        { expectedOutput: "", timeoutMs: 60000 },
    );
});

test("the Window host shows message boxes and runs page fullscreen on its window", (t) => {
    const output = resolve("artifacts/window-services");
    mkdirSync(output, { recursive: true });
    const result = compileSource(
        `
        const fail = (message: string): never => { throw new Error(message); };
        const log: string[] = [];
        alert("plain");
        if (!confirm("yes: proceed?")) fail("accepted confirmation");
        if (confirm("no: stop?")) fail("cancelled confirmation");
        if (confirm()) fail("closed confirmation");
        alert(5);
        alert(undefined);
        if (confirm(undefined)) fail("undefined confirmation");
        if (!confirm("switch: environment")) fail("switch");
        if (!confirm("environment accept")) fail("environment accept");
        if (confirm("environment dismiss")) fail("environment dismiss");
        const root = document.documentElement;
        const listener = (): void => { log.push("change:" + (document.fullscreenElement === root)); };
        document.addEventListener("fullscreenchange", listener);
        const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
        async function fullscreen(): Promise<void> {
            if (document.fullscreenElement !== null) fail("initial fullscreen element");
            await root.requestFullscreen();
            log.push("resolved:" + (document.fullscreenElement === root));
            await tick();
            await root.requestFullscreen();
            await tick();
            alert("escape");
            for (let tries = 0; document.fullscreenElement !== null; tries++) {
                if (tries > 2000) fail("Escape kept fullscreen");
                await new Promise<void>((resolve) => setTimeout(resolve, 1));
            }
            await root.requestFullscreen();
            await tick();
            await document.exitFullscreen();
            log.push("exited:" + (document.fullscreenElement === null));
            await tick();
            try { await document.exitFullscreen(); fail("exit outside fullscreen"); } catch (error) { log.push("exit:" + error.name); }
            const panel = document.createElement("div");
            document.body.append(panel);
            try { await panel.requestFullscreen(); fail("element fullscreen"); } catch (error) { log.push("element:" + error.name); }
            document.removeEventListener("fullscreenchange", listener);
            await root.requestFullscreen();
            await document.exitFullscreen();
            await tick();
            if (!confirm("fail-next")) fail("refusal");
            try { await root.requestFullscreen(); fail("refused fullscreen"); } catch (error) { log.push("refused:" + error.name + ":" + (document.fullscreenElement === null)); }
            await tick();
            const expected = "resolved:true,change:true,change:false,change:true,exited:true,change:false,exit:TypeError,element:NotSupportedError,refused:TypeError:true";
            if (log.join(",") !== expected || deleted !== 1) fail("fullscreen sequence " + log.join(","));
            alert("done");
            globalThis.close();
        }
        const rule = { do: { action: "move" } };
        const index = 0;
        let deleted = 0;
        const button = document.createElement("button");
        button.textContent = "Delete";
        button.style.cssText = "position:absolute;left:20px;top:20px;width:80px;height:30px;";
        document.body.append(button);
        // A listener's confirmation waits on the display inside its input transaction.
        button.addEventListener("click", () => {
            if (confirm(\`Delete rule \${index + 1} (\${rule.do.action})?\`)) deleted++;
            void fullscreen();
        });
        requestIdleCallback((deadline) => {
            const left = deadline.timeRemaining();
            if (deadline.didTimeout || !(left > 0 && left <= 50)) fail("idle deadline " + left);
            alert("click");
        });
    `,
        {
            fileName: join(output, "entry.ts"),
            title: "Window services fixture",
        },
    );
    writeFileSync(join(output, "program.hpp"), result.cpp);
    emitUpstreamGenerated(output, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "window-services", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_HAS_PBR_RENDERER: 0,
            BBLITE_HAS_SDL_GPU: 1,
            BBLITE_HAS_DAWN: 0,
        },
        includeDirectories: [join(output, "upstream/include")],
    });
});
