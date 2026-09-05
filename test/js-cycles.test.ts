import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("generated records describe their current owning fields", () => {
    const result = compileSource(`
        interface Link { next: Link | null; value: number; }
        function build(): void {
            const link: Link = { next: null, value: 1 };
            link.next = link;
        }
        build();
    `);
    assert.match(result.cpp, /friend void gc_trace_edges\(/);
    assert.match(result.cpp, /visitor\(record.next\);/);
});

const tools = optionalNativeFixtureTools();
function checkGeneratedCycles(label: string, sourceText: string, minimumClosures = 1, supportCpp = ""): void {
    const result = compileSource(sourceText);
    assert.ok((result.cpp.match(/bbl::js::make_closure\(/g)?.length ?? 0) >= minimumClosures,
        `${label} must exercise stored native closures`);
    const output = resolve(`artifacts/js-cycles-generated/${label}`);
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    writeFileSync(source, `#define main generated_main\n${result.cpp}\n#undef main\n${supportCpp}\n
        int main() {
            const auto initial = bbl::js::managed_node_count();
            for (int i = 0; i < 100; ++i) {
                if (generated_main() != 0) return 1;
                bbl::js::collect_cycles();
                if (bbl::js::managed_node_count() != initial) return 2;
            }
            return 0;
        }
    `);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", source,
    ]);
    execFileSync(executable);
}

test("generated record callbacks expose live capture cells to cycle collection", { skip: !tools }, () => {
    checkGeneratedCycles("self-record", `
        interface Link { next: Link | null; value: number; action: () => void; }
        function build(): void {
            const link: Link = { next: null, value: 1, action: () => { link.value += 1; } };
            link.next = link;
            link.action();
            if (link.value !== 2) throw new Error("callback capture lost identity");
        }
        build();
    `);
});

test("generated sibling closures share replaced cells and collect mutual graphs", { skip: !tools }, () => {
    checkGeneratedCycles("shared-cell", `
        interface Link { next: Link | null; value: number; }
        interface Pair { replace(): void; read(): number; }
        function pair(): Pair {
            let current: Link = { next: null, value: 1 };
            current.next = current;
            return {
                replace(): void { current = { next: null, value: 7 }; current.next = current; },
                read(): number { return current.value; }
            };
        }
        const callbacks: Pair = pair();
        if (callbacks.read() !== 1) throw new Error("initial capture");
        callbacks.replace();
        if (callbacks.read() !== 7) throw new Error("replaced capture");
    `, 2);
});

test("generated nested closures capture their own invocation locals", { skip: !tools }, () => {
    checkGeneratedCycles("nested", `
        interface Link { next: Link | null; value: number; }
        const callbacks = new Set<() => void>();
        const factories = new Set<() => void>();
        factories.add(() => {
            const link: Link = { next: null, value: 2 };
            link.next = link;
            callbacks.add(() => {
                link.value += 1;
                if (link.value !== 3) throw new Error("nested capture");
            });
        });
        for (const factory of factories) factory();
        factories.clear();
        for (const callback of callbacks) callback();
    `);
});

test("generated class closures retain field storage after this lookup", { skip: !tools }, () => {
    checkGeneratedCycles("class", `
        class Counter {
            value = 1;
            install(callbacks: Set<() => void>): void {
                callbacks.add(() => { this.value += 1; });
            }
        }
        const counter = new Counter();
        const callbacks = new Set<() => void>();
        counter.install(callbacks);
        for (const callback of callbacks) callback();
        if (counter.value !== 2) throw new Error("class capture");
    `);
});

test("returned class field homes remain visible to later stored callbacks", { skip: !tools }, () => {
    checkGeneratedCycles("returned-class", `
        class Counter {
            values: number[] = [3];
            index = 0;
            read(): number { return this.values[this.index]!; }
            step(): void { this.index++; }
        }
        function build(): Counter { const counter = new Counter(); counter.values.push(7); return counter; }
        const counter = build();
        const callbacks = new Set<() => void>();
        callbacks.add(() => {
            if (counter.read() !== 3) throw new Error("returned initial field");
            counter.step();
            if (counter.read() !== 7) throw new Error("returned updated field");
        });
        for (const callback of callbacks) callback();
    `);
});

test("generated recursive stored callbacks retain outward calls without retaining the cycle", { skip: !tools }, () => {
    checkGeneratedCycles("recursive", `
        interface Link { next: Link | null; value: number; }
        interface Runner { run(depth: number): number; }
        function build(): Runner {
            const link: Link = { next: null, value: 0 };
            link.next = link;
            const run = (depth: number): number => {
                link.value += 1;
                return depth > 0 ? run(depth - 1) : link.value;
            };
            return { run };
        }
        const runner: Runner = build();
        if (runner.run(4) !== 5) throw new Error("recursive result");
    `);
});

test("generated mutually recursive functions keep each invocation's parameters local", { skip: !tools }, () => {
    checkGeneratedCycles("mutual-recursion", `
        function check(): void {
            let visits = 0;
            function even(value: number): boolean { visits++; return value === 0 || odd(value - 1); }
            function odd(value: number): boolean { visits++; return value !== 0 && even(value - 1); }
            if (!even(8) || odd(8) || visits !== 18) throw new Error("mutual recursion");
        }
        check();
    `, 2);
});

test("generated timers retain recursive cells and observe later timer-ID assignments", { skip: !tools }, () => {
    checkGeneratedCycles("timers", `
        import { createEngine, startEngine } from "@babylonjs/lite";
        interface Link { next: Link | null; value: number; }
        function schedule(): void {
            const link: Link = { next: null, value: 0 };
            link.next = link;
            const tick = (): void => {
                link.value++;
                if (link.value < 5) setTimeout(tick, 10);
            };
            tick();
        }
        async function main(): Promise<void> {
            const engine = await createEngine({});
            schedule();
            let ticks = 0;
            let timer: number | undefined;
            timer = setInterval(() => {
                ticks++;
                if (ticks >= 3 && timer !== undefined) clearInterval(timer);
            }, 10);
            await startEngine(engine);
        }
        main();
    `, 3, `
        // A controlled scheduler isolates generated capture semantics from GPU startup.
        namespace bbl {
            static std::deque<std::function<void()>> pending;
            static std::function<void()> interval;
            Engine create_engine(EngineOptions) { return {}; }
            double set_timeout(Engine&, std::function<void()> callback, double) {
                pending.push_back(std::move(callback));
                return 1;
            }
            double set_interval(Engine&, std::function<void()> callback, double) {
                interval = std::move(callback);
                return 2;
            }
            void clear_interval(Engine&, double id) {
                if (id != 2) throw std::runtime_error("wrong interval ID");
                interval = {};
            }
            void start_engine(Engine&) {
                int timeout_calls = 0;
                int interval_calls = 0;
                for (int frame = 0; frame < 10; ++frame) {
                    js::collect_cycles();
                    if (!pending.empty()) {
                        auto callback = std::move(pending.front());
                        pending.pop_front();
                        callback();
                        ++timeout_calls;
                    }
                    if (auto callback = interval) { callback(); ++interval_calls; }
                }
                if (timeout_calls != 4 || interval_calls != 3 || !pending.empty() || interval)
                    throw std::runtime_error("timer lifetime or cancellation");
            }
        }
    `);
});

test("cycle collection preserves live aliases and releases unreachable container graphs", { skip: !tools }, () => {
    const output = resolve("artifacts/js-cycles-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "js-cycles-check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include",
        "test/fixtures/js-cycles-check.cpp",
    ]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /js-cycles-check: ok/);
});
