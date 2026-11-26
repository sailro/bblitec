import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runNativeFixtureCompiler,
} from "./native-fixture.js";
import { checkKeyboardWindowProgram } from "./self-checking-program.js";

const nativeTools = optionalNativeFixtureTools();
for (const workers of [false, true])
    test(
        `DOM phases and listener ownership with workers=${workers}`,
        { skip: !nativeTools },
        () => {
            const output = resolve(
                `artifacts/dom-event-check-${workers ? "workers" : "scene"}`,
            );
            mkdirSync(output, { recursive: true });
            const executable = join(output, "dom-event-check.exe");
            runNativeFixtureCompiler(nativeTools!, [
                ...(workers ? ["/DBBLITE_WORKERS=1"] : []),
                `/Fo:${output}\\`,
                `/Fe:${executable}`,
                "test/fixtures/js-callback/dom-event-check.cpp",
            ]);
            assert.match(
                execFileSync(executable, [], { encoding: "utf8" }),
                /dom-event-check: ok/,
            );
        },
    );

test(
    "retained callback snapshots preserve mutable state and survive self-disposal",
    {
        skip: !nativeTools,
    },
    () => {
        const output = resolve("artifacts/retained-callback-check");
        mkdirSync(output, { recursive: true });
        const executable = join(output, "retained-callback-check.exe");
        runNativeFixtureCompiler(nativeTools!, [
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "test/fixtures/js-callback/retained-callback-check.cpp",
        ]);
        assert.match(
            execFileSync(executable, [], { encoding: "utf8" }),
            /retained-callback-check: ok/,
        );
    },
);

const platformPreamble = `
    import { createEngine } from "@babylonjs/lite";
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    await createEngine(canvas);
`;

test("shares a dispatched mouse event across synchronous registry callbacks", (t) => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        type MouseName = "down" | "up";
        interface MousePayload {
            readonly domEvent: MouseEvent;
            readonly x: number;
            consumed: boolean;
        }

        class MouseRegistry {
            private readonly handlers =
                new Map<MouseName, Set<(payload: MousePayload) => void>>();

            on(name: MouseName, handler: (payload: MousePayload) => void): void {
                let set = this.handlers.get(name);
                if (!set) {
                    set = new Set();
                    this.handlers.set(name, set);
                }
                set.add(handler);
            }

            off(name: MouseName, handler: (payload: MousePayload) => void): void {
                this.handlers.get(name)?.delete(handler);
            }

            dispatch(name: MouseName, event: MouseEvent): void {
                const payload: MousePayload = {
                    domEvent: event,
                    x: event.clientX,
                    consumed: false,
                };
                const set = this.handlers.get(name);
                if (set) {
                    for (const handler of set) {
                        handler(payload);
                        if (payload.consumed) break;
                    }
                }
                if (event.clientX >= 0 && !payload.consumed)
                    throw new Error("registry handlers must share their payload");
            }
        }

        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        await createEngine(canvas);
        const registry = new MouseRegistry();
        const consume = (payload: MousePayload): void => {
            const x = payload.domEvent.clientX;
            if (x >= 0) {
                payload.domEvent.preventDefault();
                payload.consumed = true;
            }
        };
        registry.on("down", consume);
        registry.off("up", consume);
        registry.off("down", consume);
        canvas.addEventListener("mousedown", (event) => {
            registry.on("down", consume);
            registry.dispatch("down", event);
        });
    `);

    assert.match(
        result.cpp,
        /bbl::js::EventRef<const bbl::PlatformMouseEvent> domEvent;/,
    );
    assert.match(
        result.cpp,
        /MousePayloadData\{bbl::js::EventRef<const bbl::PlatformMouseEvent>\(/,
    );
    assert.match(
        result.cpp,
        /using MousePayload = bbl::js::Ref<MousePayloadData>;/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Callback<void\(bblscene::MousePayload\)>/,
    );
    assert.match(
        result.cpp,
        /->domEvent\.get\(\)\.mouse_payload\(\)\.client_x/,
    );
    assert.match(result.cpp, /->domEvent\.get\(\)\.prevent_default\(\)/);
    assert.match(result.cpp, /->consumed = true/);
    assert.match(result.cpp, /if \(v_[^)]+->consumed\)/);
    assert.match(result.cpp, /if \(v_[^.]+\.has_value\(\)\) \{/);

    const identities = [
        ...result.cpp.matchAll(
            /bbl::js::Callback<void\(bblscene::MousePayload\)> \w+\{(\d+)u,/g,
        ),
    ].map((match) => match[1]);
    // One shared body per registry method materializes the callback, and
    // every materialization keeps the function's one identity.
    assert.ok(identities.length >= 2);
    assert.equal(new Set(identities).size, 1);

    if (!nativeTools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        nativeTools,
        "event-mouse-registry",
        `
#define main generated_main
${result.cpp}
#undef main
#include <cassert>
namespace { std::shared_ptr<bbl::DomInput> registry_input; }
namespace bbl {
Engine create_engine(EngineOptions) {
    Engine engine;
    engine.dom_input = std::make_shared<DomInput>();
    registry_input = engine.dom_input;
    return engine;
}
}
int main() {
    assert(generated_main() == 0);
    for (double x : {12.0, -1.0, 34.0}) {
        auto event = bbl::dom_event(bbl::PlatformMouseEvent{.client_x=x}, "mousedown",
            {bbl::DomEventTarget::canvas()});
        registry_input->pointer.dispatch(event);
        assert(event.is_default_prevented() == (x >= 0));
    }
    registry_input.reset();
}
`,
    );
});

test("lowers Map.get optional Set.delete for found and missing entries", () => {
    const result = compileSource(`
        const groups = new Map<string, Set<number>>();
        const values = new Set<number>();
        values.add(4);
        groups.set("found", values);
        groups.set("empty", new Set<number>());
        const found = groups.get("found")?.delete(4);
        const missing = groups.get("missing")?.delete(4);
        const presentFalse = groups.get("empty")?.delete(4);
        const score =
            (found ? 1 : 0) +
            (missing === undefined ? 1 : 0) +
            (!presentFalse && presentFalse !== undefined ? 1 : 0);
        const unused = score + values.size;
    `);

    assert.equal(
        (result.cpp.match(/auto v_bblite_optional_chain_\d+ =/g) ?? []).length,
        3,
    );
    assert.equal((result.cpp.match(/\)\.erase\(4\.0\)/g) ?? []).length, 3);
    assert.match(result.cpp, /bbl::js::Nullable<bool>/);
    assert.match(result.cpp, /nullable_truthy\(v_presentFalse\)/);

    const runtime = readFileSync("native/include/bblite/js_data.hpp", "utf8");
    assert.match(runtime, /!std::is_same_v<std::remove_cvref_t<U>, Nullable>/);

    assert.doesNotThrow(() =>
        compileSource(`
                const groups = new Map<string, Set<number>>();
                groups.get("missing")?.clear();
            `),
    );
});

test("owns an optional Map Set before delete-argument side effects", () => {
    const result = compileSource(`
        const erased = new Map<string, Set<number>>();
        const erasedOriginal = new Set<number>([1]);
        erased.set("entry", erasedOriginal);
        function eraseArgument(): number {
            erased.delete("entry");
            return 1;
        }
        erased.get("entry")?.delete(eraseArgument());

        const cleared = new Map<string, Set<number>>();
        const clearedOriginal = new Set<number>([2]);
        cleared.set("entry", clearedOriginal);
        function clearArgument(): number {
            cleared.clear();
            return 2;
        }
        cleared.get("entry")?.delete(clearArgument());

        const replaced = new Map<string, Set<number>>();
        const replacedOriginal = new Set<number>([3]);
        const replacement = new Set<number>([3]);
        replaced.set("entry", replacedOriginal);
        function replaceArgument(): number {
            replaced.set("entry", replacement);
            return 3;
        }
        replaced.get("entry")?.delete(replaceArgument());

        if (
            erasedOriginal.size !== 0 ||
            clearedOriginal.size !== 0 ||
            replacedOriginal.size !== 0 ||
            replacement.size !== 1
        ) {
            throw new Error("optional Set.delete did not retain its receiver");
        }
    `);

    assert.equal(
        (result.cpp.match(/auto v_bblite_optional_chain_\d+ =/g) ?? []).length,
        3,
    );
    for (const owner of ["v_erased", "v_cleared", "v_replaced"]) {
        assert.match(
            result.cpp,
            new RegExp(
                `auto (v_bblite_optional_chain_\\d+) = ${owner}\\.get_owned\\("entry"\\);[\\s\\S]*?if \\(.*\\1\\.has_value\\(\\)[^\\n]+\\n[^\\n]+const double (v_bblite_shared_result_\\d+) = bbl::js::make_closure\\(bblscene::bbl_environment_\\w+\\{${owner}[,}][^\\n]+\\n[^\\n]+\\(\\*\\1\\)\\.erase\\(\\2\\)`,
            ),
        );
    }
});

test("keeps optional delete argument mutations path-dependent in manifests", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createPbrMaterial,
            createSphere,
        } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const first = createBox(engine);
            const second = createSphere(engine, {});
            const material = createPbrMaterial({});
            const selected = new Map<string, typeof first>();
            selected.set("mesh", first);
            const guards = new Map<string, Set<number>>();
            function replace(): number {
                selected.set("mesh", second);
                return 1;
            }
            guards.get("missing")?.delete(replace());
            const mesh = selected.get("mesh");
            if (mesh) mesh.material = material;
        }
    `);

    assert.deepEqual(
        result.manifest.scenePbrMaterials[0]?.sceneMeshIndices,
        [],
    );
    assert.equal(result.manifest.scenePbrMaterials[0]?.unknownSceneMesh, true);
    assert.doesNotMatch(
        JSON.stringify(result.manifest.scenePbrMaterials[0]),
        /"sceneMeshIndices":\[1\]/,
    );
});

test("erases never and void callback payloads without runtime placeholders", () => {
    const result = compileSource(`
        interface Events {
            started: void;
            stopped: void;
        }

        class EventEmitter<EventMap> {
            private readonly handlers =
                new Map<keyof EventMap, Set<(payload: never) => void>>();

            on<K extends keyof EventMap>(
                event: K,
                handler: (payload: EventMap[K]) => void,
            ): void {
                let set = this.handlers.get(event);
                if (!set) {
                    set = new Set();
                    this.handlers.set(event, set);
                }
                set.add(handler as (payload: never) => void);
            }

            off<K extends keyof EventMap>(
                event: K,
                handler: (payload: EventMap[K]) => void,
            ): void {
                this.handlers.get(event)?.delete(
                    handler as (payload: never) => void,
                );
            }

            emit<K extends keyof EventMap>(
                event: K,
                payload: EventMap[K],
            ): void {
                const set = this.handlers.get(event);
                if (set) {
                    for (const handler of set) {
                        handler(payload as never);
                    }
                }
            }
        }

        const events = new EventEmitter<Events>();
        let count = 0;
        const handler = (): void => { count += 1; };
        events.on("started", handler);
        events.on("started", handler);
        events.emit("started", undefined as void);
        events.off("started", handler);
        events.emit("started", undefined as void);
        const unused = count;
    `);

    assert.match(result.cpp, /bbl::js::Set<bbl::js::Callback<void\(\)>>/);
    assert.doesNotMatch(result.cpp, /Callback<void\(void\)>/);
    assert.doesNotMatch(result.cpp, /arg_\d+[^)]*void/);
    assert.match(result.cpp, /\(\);/);
});

test("evaluates erased void callback defaults before the callback body", () => {
    const result = compileSource(`
        const callbacks = new Set<(payload: void) => void>();
        const marks = new Set<number>();
        function markDefault(): void {
            marks.add(1);
        }
        const handler = (payload: void = markDefault()): void => {
            marks.add(2);
        };
        callbacks.add(handler);
        for (const callback of callbacks) {
            callback(undefined);
        }
        if (marks.size !== 2) {
            throw new Error("void callback default was not evaluated");
        }
    `);

    const defaultMark = result.cpp.indexOf("v_marks.add(1.0)");
    const bodyMark = result.cpp.indexOf("v_marks.add(2.0)");
    assert.ok(defaultMark >= 0);
    assert.ok(bodyMark > defaultMark);
    assert.match(
        result.cpp,
        /Callback<void\(\)> \w+\{\d+u, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{v_marks\}, bblscene::\w+/,
    );
});

test("distinguishes callback expressions in static and runtime loops", (t) => {
    const result = compileSource(`
        const callbacks = new Set<() => void>();
        const seen = new Set<number>();
        for (const value of [1, 2]) {
            callbacks.add((): void => {
                seen.add(value);
            });
        }
        for (const callback of callbacks) {
            callback();
        }
        if (callbacks.size !== 2 || seen.size !== 2) {
            throw new Error("callback evaluations lost identity");
        }
    `);
    assert.equal(
        result.cpp.match(
            /Callback<void\(\)> \w+\{bbl::js::next_callback_identity\(\),/g,
        )?.length,
        1,
    );
    assert.match(
        result.cpp,
        /for \(auto&& (\w+) : v_callbacks\) \{\s*static_cast<void>\(\1\);\s*const auto (\w+) = bbl::js::snapshot_callback\(\1\);\s*\2\(\);/,
    );

    const runtime = compileSource(`
        const callbacks = new Set<() => void>();
        const values: number[] = [];
        if (Math.random() > 0.5) values.push(1);
        for (const value of values) {
            callbacks.add((): void => {
                const used = value;
            });
        }
    `);
    assert.match(
        runtime.cpp,
        /Callback<void\(\)> \w+\{bbl::js::next_callback_identity\(\),/,
    );

    const named = compileSource(`
        const callbacks = new Set<() => void>();
        const values: number[] = [];
        if (Math.random() > 0.5) values.push(1);
        function callback(): void {}
        for (const value of values) {
            callbacks.add(callback);
        }
    `);
    assert.equal(
        (named.cpp.match(/bbl::js::Callback<void\(\)> \w+\{\d+u,/g) ?? [])
            .length,
        1,
    );
    if (!nativeTools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(nativeTools, "callback-loop-identities", result.cpp);
});

test("keeps keyboard and base Event references in records", () => {
    const keyboard = compileSource(`
        ${platformPreamble}
        interface KeyPayload {
            event: KeyboardEvent;
            consumed: boolean;
        }
        window.addEventListener("keydown", (event) => {
            const payload: KeyPayload = { event, consumed: false };
            const code = payload.event.code;
            payload.event.preventDefault();
            payload.consumed = code === "Space";
        });
    `);
    assert.match(
        keyboard.cpp,
        /bbl::js::EventRef<const bbl::PlatformKeyboardEvent> event;/,
    );
    assert.match(keyboard.cpp, /->event\.get\(\)\.code/);
    assert.match(keyboard.cpp, /->event\.get\(\)\.prevent_default\(\)/);

    const base = compileSource(`
        ${platformPreamble}
        interface BasePayload {
            event: Event;
            consumed: boolean;
        }
        canvas.addEventListener("mousedown", (event) => {
            const payload: BasePayload = { event, consumed: false };
            payload.event.preventDefault();
            payload.consumed = true;
        });
    `);
    assert.match(base.cpp, /bbl::js::BaseEventRef event;/);
    assert.match(base.cpp, /->event\.get\(\)\.prevent_default\(\)/);
});

test("inlined class parameters pass owned event references", () => {
    for (const eventType of ["MouseEvent", "KeyboardEvent", "Event"]) {
        const target = eventType === "KeyboardEvent" ? "window" : "canvas";
        const eventName =
            eventType === "KeyboardEvent" ? "keydown" : "mousedown";
        const result = compileSource(`
            ${platformPreamble}
            class Handler {
                private readonly handlers = new Set<(event: ${eventType}) => void>();
                on(callback: (event: ${eventType}) => void): void { this.handlers.add(callback); }
                consume(event: ${eventType}): void {
                    for (const callback of this.handlers) callback(event);
                }
            }
            const handler = new Handler();
            handler.on(event => event.preventDefault());
            ${target}.addEventListener("${eventName}", (event) => handler.consume(event));
        `);
        // The caller names the reference; the shared method takes it by
        // value and reads the event from its own parameter.
        assert.match(
            result.cpp,
            /const auto (\w+event_argument\w*) = bbl::js::(?:EventRef<[^>]+>|BaseEventRef)\([^;]+;\s*(?:static_cast<void>\()?bbl::js::make_closure\([^\n]*\(bbl::js::(?:EventRef<[^>]+>|BaseEventRef)\(\1\.get\(\)\)\)\)?;/,
        );
        assert.match(
            result.cpp,
            /\[\[maybe_unused\]\] const auto& \w+ = bbl::js::snapshot_value\(fn\d+_recursive_arg_0\.get\(\)\);/,
        );
        // A reference into a temporary wrapper would dangle.
        assert.doesNotMatch(
            result.cpp,
            /const auto& \w+ = bbl::js::(?:EventRef<[^>]+>|BaseEventRef)\([^;]+\.get\(\);/,
        );
    }
});

test("a dispatched event kept anywhere is the same event once the dispatch ends", async (t) => {
    // Each store and each closure keeping the event runs natively and as
    // JavaScript: what it keeps is the dispatched event, its reads see the
    // dispatch's final state, and a later preventDefault cancels it.
    await checkKeyboardWindowProgram(
        t,
        "callback-registry/escaping-event-stores",
        `
        queueMicrotask(() => {});
        interface Payload { domEvent: KeyboardEvent; consumed: boolean; }
        interface Holder { saved: Payload | null; }
        interface Envelope { nested: { payload: Payload }; }
        class Keeper {
            static last: KeyboardEvent | null = null;
            private saved: Payload | null = null;
            keep(payload: Payload): void { this.saved = payload; }
            kept(): Payload | null { return this.saved; }
        }
        const keeper = new Keeper();
        const array: Payload[] = [];
        const set = new Set<Payload>();
        const map = new Map<string, Payload>();
        const source: number[] = [1];
        let mapped: Payload[] = [];
        const holder: Holder = { saved: null };
        const assigned: Holder = { saved: null };
        const property: { last: KeyboardEvent | null } = { last: null };
        let saved: KeyboardEvent | null = null;
        let nullish: KeyboardEvent | null = null;
        let or: KeyboardEvent | null = null;
        let and: KeyboardEvent | null = null;
        let destructured: KeyboardEvent | null = null;
        let other = 0;
        let picked: KeyboardEvent | null = null;
        const elements: KeyboardEvent[] = [];
        const unshifted: KeyboardEvent[] = [];
        const spliced: KeyboardEvent[] = [];
        const filled: KeyboardEvent[] = [];
        const weak = new WeakSet<Event>();
        const weakKeys = new WeakMap<Event, number>();
        const keys = new Map<KeyboardEvent, number>();
        const record: Record<string, KeyboardEvent> = {};
        const envelopes: Envelope[] = [];
        let constructed = new WeakSet<Event>();
        let tupled = new WeakSet<Event>();
        const later = new Set<() => void>();
        let late = (): void => {};
        let rebound = (): KeyboardEvent | null => null;
        window.addEventListener("keydown", (event) => {
            const payload: Payload = { domEvent: event, consumed: false };
            function capture(): void { payload.domEvent.preventDefault(); }
            function hop(): void { capture(); }
            function first(recurse: boolean): void { if (recurse) second(false); }
            function second(recurse: boolean): void {
                if (recurse) first(false);
                payload.domEvent.preventDefault();
            }
            switch (event.key) {
                case "store": {
                    array.push(payload);
                    set.add(payload);
                    map.set("event", payload);
                    mapped = source.map(() => payload);
                    keeper.keep(payload);
                    holder.saved = payload;
                    Object.assign(assigned, { saved: payload });
                    const alias = property;
                    alias.last = event;
                    saved = event;
                    nullish ??= event;
                    or ||= event;
                    and ??= event;
                    and &&= event;
                    [destructured, other] = [event, 1];
                    ({ picked } = { picked: event });
                    elements[0] = event;
                    unshifted.unshift(event);
                    spliced.splice(0, 0, event);
                    filled.push(event);
                    filled.fill(event);
                    weak.add(event);
                    weakKeys.set(event, 1);
                    keys.set(event, 2);
                    record["latest"] = event;
                    Keeper.last = event;
                    const envelope: Envelope = { nested: { payload } };
                    envelopes.push(envelope);
                    constructed = new WeakSet<Event>([event]);
                    const events = [event] as const;
                    tupled = new WeakSet<Event>(events);
                    let local = event;
                    local = event;
                    rebound = () => local;
                    break;
                }
                case "timer":
                    setTimeout(() => payload.domEvent.preventDefault(), 0);
                    break;
                case "listener":
                    window.addEventListener("keyup", () => { payload.domEvent.preventDefault(); });
                    break;
                case "stored": {
                    const run = (): void => { payload.domEvent.preventDefault(); };
                    later.add(run);
                    break;
                }
                case "value":
                    later.add(capture);
                    break;
                case "call": {
                    const run = (): void => capture();
                    later.add(run);
                    break;
                }
                case "arrow": {
                    const run = (): void => { payload.domEvent.preventDefault(); };
                    window.addEventListener("keyup", run);
                    break;
                }
                case "late":
                    late = () => { event.preventDefault(); };
                    break;
                case "one":
                    window.addEventListener("keyup", () => { capture(); });
                    break;
                case "hop":
                    window.addEventListener("keyup", () => { hop(); });
                    break;
                case "cycle":
                    window.addEventListener("keyup", () => { first(true); });
                    break;
            }
        });
        function dispatch(key: string): KeyboardEvent {
            const event = new KeyboardEvent("keydown", { key, code: "Key" + key, cancelable: true });
            window.dispatchEvent(event);
            return event;
        }
        const stored = dispatch("store");
        const cancelled = ["timer", "listener", "stored", "value", "call", "arrow", "late", "one", "hop", "cycle"].map(dispatch);
        setTimeout(() => {
            const failures: string[] = [];
            function check(label: string, ok: boolean): void {
                if (!ok) failures.push(label);
            }
            check("array", array[0]!.domEvent === stored);
            check("set", Array.from(set)[0]!.domEvent === stored);
            check("map", map.get("event")!.domEvent === stored);
            check("array-map", mapped[0]!.domEvent === stored);
            check("class-field", keeper.kept()!.domEvent === stored);
            check("record-field", holder.saved!.domEvent === stored);
            check("object-assign", assigned.saved!.domEvent === stored);
            check("property-alias", property.last === stored);
            check("module-let", saved === stored);
            check("nullish", nullish === stored);
            check("or", or === stored);
            check("and", and === stored);
            check("array-destructuring", destructured === stored && other === 1);
            check("object-destructuring", picked === stored);
            check("element", elements[0] === stored);
            check("unshift", unshifted[0] === stored);
            check("splice", spliced[0] === stored);
            check("fill", filled[0] === stored);
            check("weakset", weak.has(stored));
            check("weakmap-key", weakKeys.get(stored) === 1);
            check("map-key", keys.get(stored) === 2);
            check("record-entry", record["latest"] === stored);
            check("static-field", Keeper.last === stored);
            check("nested-record-array", envelopes[0]!.nested.payload.domEvent === stored);
            check("weakset-constructor", constructed.has(stored));
            check("weakset-tuple-constructor", tupled.has(stored));
            check("rebound-local", rebound() === stored);
            // Reads see the dispatch's final state; a cancel through any copy
            // cancels the event every copy names.
            check("final-state", elements[0]!.code === "Keystore" && Keeper.last!.eventPhase === 0 && !saved!.defaultPrevented);
            holder.saved!.domEvent.preventDefault();
            check("later-cancel", stored.defaultPrevented && record["latest"]!.defaultPrevented && array[0]!.domEvent.defaultPrevented);
            for (const run of later) run();
            late();
            window.dispatchEvent(new KeyboardEvent("keyup", { key: "up", code: "KeyUp" }));
            cancelled.forEach((event, index) => check("cancel " + index, event.defaultPrevented));
            if (failures.length) throw new Error(failures.join());
            globalThis.close();
        }, 0);
    `,
    );
});

// The queued microtask takes the application realm.
test("a dispatched event is identical to its aliases and to the copies records keep of it", async (t) => {
    await checkKeyboardWindowProgram(
        t,
        "callback-registry/dispatched-event-identity",
        `
        queueMicrotask(() => {});
        const seen: string[] = [];
        window.addEventListener("keydown", (event) => {
            const alias = event;
            const wrapped = { event };
            seen.push(event.code + String(alias === event) + String(wrapped.event === alias) + String(wrapped.event !== event));
        });
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA" }));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB" }));
        setTimeout(() => {
            const expected = "KeyAtruetruefalse,KeyBtruetruefalse";
            if (seen.join() !== expected) throw new Error(seen.join());
            globalThis.close();
        }, 0);
    `,
    );
});

test("an escaping callback reads a dispatched event as JavaScript does once the dispatch ends", async (t) => {
    // A capture-phase handler defers its check past the dispatch, directly,
    // through a helper and through aliases and records of the event, and
    // keeps closures that cancel it later; a later handler of the same
    // dispatch cancels the first event.
    await checkKeyboardWindowProgram(
        t,
        "callback-registry/escaping-event-capture",
        `
        queueMicrotask(() => {});
        const seen: string[] = [];
        const later: Array<() => void> = [];
        let last = (): void => {};
        let isCaptured = (_other: KeyboardEvent): boolean => false;
        function schedule(callback: () => void): void {
            setTimeout(callback, 0);
        }
        window.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape") return;
                schedule(() => {
                    seen.push(event.code + (event.defaultPrevented ? " prevented" : " free"));
                });
                setTimeout(() => {
                    seen.push(
                        "phase " + event.eventPhase + " current " + String(event.currentTarget === null) +
                            " target " + String(event.target === window) + " path " + event.composedPath().length +
                            " " + event.type + (event.shiftKey ? " shift" : ""),
                    );
                }, 0);
                // Aliases and records of the event are the same event.
                const alias = event;
                const wrapped = { event, nested: [{ borrowed: event }] as const };
                const nested = wrapped.nested;
                setTimeout(() => {
                    const record = nested[0];
                    seen.push(
                        "alias " + alias.code + " " + String(wrapped.event === alias && record.borrowed === event) +
                            " " + String(wrapped.nested[0].borrowed.defaultPrevented),
                    );
                }, 0);
                const cancel = (): void => {
                    event.preventDefault();
                    seen.push("late " + String(event.defaultPrevented));
                };
                later.push(cancel);
                last = () => {
                    seen.push("last " + event.code + " " + String(event.defaultPrevented));
                };
                isCaptured = (other) => other === event;
            },
            { capture: true },
        );
        window.addEventListener("keydown", (event) => {
            seen.push("same " + String(isCaptured(event)));
            if (event.shiftKey) event.preventDefault();
        });
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", shiftKey: true, cancelable: true }));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", cancelable: true }));
        setTimeout(() => {
            for (const run of later) run();
            last();
            const expected = [
                "same true",
                "same true",
                "Escape prevented",
                "phase 0 current true target true path 0 keydown shift",
                "alias Escape true true",
                "Escape free",
                "phase 0 current true target true path 0 keydown",
                "alias Escape true false",
                "late true",
                "late true",
                "last Escape true",
            ].join();
            if (seen.join() !== expected) throw new Error(seen.join());
            globalThis.close();
        }, 0);
    `,
    );
});

test("a retained closure carries only the bindings its code reads", () => {
    // Closures that read only owned locals escape without the enclosing
    // listener's event, which is in scope.
    assert.doesNotThrow(() =>
        compileSource(`
            import { createEngine } from "@babylonjs/lite";
            const translated = new WeakSet<Event>();
            const listeners = new Set<() => void>();
            let lastLabel = "";
            function localize(apply: () => void): () => void {
                apply();
                listeners.add(apply);
                return () => listeners.delete(apply);
            }
            function createCaption(text: string): void {
                const caption = document.createElement("div");
                const render = (): void => {
                    caption.textContent = text;
                };
                localize(render);
                window.addEventListener("resize", render);
            }
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            await createEngine(canvas);
            canvas.addEventListener("mousedown", (event) => {
                if (translated.has(event)) return;
                const label = event.button === 0 ? "primary" : "other";
                const later = (): void => {
                    lastLabel = label;
                };
                listeners.add(later);
                createCaption(label);
            });
        `),
    );
});

test("refuses unrelated DOM records and unknown MouseEvent provenance", () => {
    for (const eventType of [
        "FocusEvent",
        "UIEvent",
        "FocusEvent & {label: string}",
        "AuthoredFocus",
        "Readonly<FocusEvent>",
        "Frozen<FocusEvent>",
        "Required<Partial<FocusEvent>>",
    ])
        assert.throws(
            () =>
                compileSource(`
                interface AuthoredFocus extends FocusEvent { label: string; }
                type Frozen<T> = {readonly [K in keyof T]: T[K]};
                interface FocusPayload {
                    event: ${eventType};
                    consumed: boolean;
                }
                const handlers =
                    new Set<(payload: FocusPayload) => void>();
                const unused = handlers.size;
            `),
            /requires concrete data type arguments|outside the supported native-data subset/,
        );

    assert.throws(
        () =>
            compileSource(`
                interface Payload {
                    event: MouseEvent;
                    consumed: boolean;
                }
                function consume(event: MouseEvent): void {
                    const payload: Payload = { event, consumed: false };
                    payload.event.preventDefault();
                }
                const fake = {} as MouseEvent;
                consume(fake);
            `),
        /A DOM mouse event must be a platform event of that type/,
    );
});

test("authored records named Event retain ordinary callback storage", (t) => {
    const result = compileSource(`
        export {};
        interface Event {value: number;}
        const snapshot: Pick<FocusEvent, "type"> = {type: "focus"};
        const partial: Partial<FocusEvent> = {type: "blur"};
        const handlers = new Set<(event: Event) => void>();
        let received = 0;
        handlers.add(event => { received += event.value; });
        for (const handler of handlers) handler({value: 7});
        if (received !== 7) throw new Error("authored event record");
        if (snapshot.type !== "focus" || partial.type !== "blur")
            throw new Error("event data snapshot");
    `);
    if (!nativeTools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(nativeTools, "authored-event-record", result.cpp, {
        expectedOutput: "",
    });
});
