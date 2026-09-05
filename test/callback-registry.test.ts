import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { CompileError, compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools();
test("retained callback snapshots preserve mutable state and survive self-disposal", {
    skip: !nativeTools,
}, () => {
    const output = resolve("artifacts/retained-callback-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "retained-callback-check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include",
        "test/fixtures/js-callback/retained-callback-check.cpp",
    ]);
    assert.match(execFileSync(executable, [], { encoding: "utf8" }), /retained-callback-check: ok/);
});

const platformPreamble = `
    import { createEngine } from "@babylonjs/lite";
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    await createEngine(canvas);
`;

test("shares a borrowed mouse payload across synchronous registry callbacks", () => {
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
        /bbl::js::Borrowed<const bbl::PlatformMouseEvent> domEvent;/,
    );
    assert.match(
        result.cpp,
        /MousePayloadData\{bbl::js::Borrowed<const bbl::PlatformMouseEvent>\(/,
    );
    assert.match(result.cpp, /using MousePayload = bbl::js::Ref<MousePayloadData>;/);
    assert.match(
        result.cpp,
        /bbl::js::Callback<void\(bblscene::MousePayload\)>/,
    );
    assert.match(result.cpp, /->domEvent\.get\(\)\.client_x/);
    assert.match(result.cpp, /->domEvent\.get\(\)\.prevent_default\(\)/);
    assert.match(result.cpp, /->consumed = true/);
    assert.match(result.cpp, /if \(v_[^)]+->consumed\)/);
    assert.match(result.cpp, /if \(v_[^.]+\.has_value\(\)\) \{/);

    const identities = [
        ...result.cpp.matchAll(
            /bbl::js::Callback<void\(bblscene::MousePayload\)> \w+\{(\d+)u,/g,
        ),
    ].map((match) => match[1]);
    assert.ok(identities.length >= 4);
    assert.equal(new Set(identities).size, 1);
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
        (
            result.cpp.match(
                /bbl::js::Nullable<bbl::js::Set<double>> v_bblite_optional_set_\d+;/g,
            ) ?? []
        ).length,
        3,
    );
    assert.equal((result.cpp.match(/\.has_value\(\)\) \{/g) ?? []).length, 6);
    assert.equal((result.cpp.match(/\)\.erase\(4\.0\)/g) ?? []).length, 3);
    assert.match(result.cpp, /bbl::js::Nullable<bool> v_bblite_optional_delete_/);
    assert.match(
        result.cpp,
        /v_presentFalse\.has_value\(\) && \*v_presentFalse/,
    );

    const runtime = readFileSync("native/include/bblite/js_data.hpp", "utf8");
    assert.match(
        runtime,
        /!std::is_same_v<std::remove_cvref_t<U>, Nullable>/,
    );

    assert.throws(
        () =>
            compileSource(`
                const groups = new Map<string, Set<number>>();
                groups.get("missing")?.clear();
            `),
        /may be null|Optional data-method chaining supports only|Unsupported call target/,
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
        (
            result.cpp.match(
                /const auto v_bblite_optional_set_lookup_\d+ =/g,
            ) ?? []
        ).length,
        3,
    );
    assert.equal(
        (
            result.cpp.match(
                /v_bblite_optional_set_\d+ = \*v_bblite_optional_set_lookup_\d+;/g,
            ) ?? []
        ).length,
        3,
    );
    for (const effect of [
        /v_erased\.erase\("entry"\)/,
        /v_cleared\.clear\(\)/,
        /v_replaced\.set\("entry", v_replacement\)/,
    ]) {
        const match = effect.exec(result.cpp);
        assert.ok(match);
        const owned = result.cpp.lastIndexOf(
            " = *v_bblite_optional_set_lookup_",
            match.index,
        );
        const deleted = result.cpp.indexOf(
            ").erase(",
            match.index,
        );
        assert.ok(owned >= 0 && owned < match.index);
        assert.ok(deleted > match.index);
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
    assert.equal(
        result.manifest.scenePbrMaterials[0]?.unknownSceneMesh,
        true,
    );
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

    assert.match(
        result.cpp,
        /bbl::js::Set<bbl::js::Callback<void\(\)>>/,
    );
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

    const defaultMark = result.cpp.indexOf(
        "v_marks.add(1.0)",
    );
    const bodyMark = result.cpp.indexOf(
        "v_marks.add(2.0)",
    );
    assert.ok(defaultMark >= 0);
    assert.ok(bodyMark > defaultMark);
    assert.match(
        result.cpp,
        /Callback<void\(\)> \w+\{\d+u, \[=\]\(\) mutable -> void \{/,
    );
});

test("distinguishes callback expressions in static and runtime loops", () => {
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
    const identities = [
        ...result.cpp.matchAll(
            /bbl::js::Callback<void\(\)> \w+\{(\d+)u,/g,
        ),
    ].map((match) => match[1]);
    assert.equal(identities.length, 2);
    assert.equal(new Set(identities).size, 2);
    assert.match(
        result.cpp,
        /for \(auto&& \w+ : v_callbacks\) \{\s*\w+\(\);/,
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
        (
            named.cpp.match(
                /bbl::js::Callback<void\(\)> \w+\{\d+u,/g,
            ) ?? []
        ).length,
        1,
    );
});

test("borrows keyboard and base Event views from their active callbacks", () => {
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
        /bbl::js::Borrowed<const bbl::PlatformKeyboardEvent> event;/,
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
    assert.match(base.cpp, /bbl::js::BorrowedEvent event;/);
    assert.match(base.cpp, /->event\.get\(\)\.prevent_default\(\)/);
});

test("refuses borrowed payloads at retained storage and capture sites", () => {
    const cases = [
        {
            name: "array",
            declarations: "const saved: Payload[] = [];",
            body: "saved.push(payload);",
            pattern: /through Array\.push/,
        },
        {
            name: "set",
            declarations: "const saved = new Set<Payload>();",
            body: "saved.add(payload);",
            pattern: /through Set\.add/,
        },
        {
            name: "map",
            declarations: "const saved = new Map<string, Payload>();",
            body: 'saved.set("event", payload);',
            pattern: /through Map\.set value/,
        },
        {
            name: "array-map",
            declarations: "const source: number[] = [1];",
            body: "const saved = source.map(() => payload);",
            pattern: /through Array\.map result/,
        },
        {
            name: "class-field",
            declarations: `
                class Keeper {
                    private saved: Payload | null = null;
                    keep(payload: Payload): void { this.saved = payload; }
                }
                const keeper = new Keeper();
            `,
            body: "keeper.keep(payload);",
            pattern: /through (?:class field assignment|a reassigned local)/,
        },
        {
            name: "outer-record-field",
            declarations: `
                interface Holder { saved: Payload | null; }
                const holder: Holder = { saved: null };
            `,
            body: "holder.saved = payload;",
            pattern: /through data field assignment/,
        },
        {
            name: "timer",
            declarations: "",
            body: "setTimeout(() => payload.domEvent.preventDefault(), 0);",
            pattern: /escaping callback cannot capture platform event value 'payload'/,
        },
        {
            name: "listener",
            declarations: "",
            body: `
                window.addEventListener("mouseup", () => {
                    payload.domEvent.preventDefault();
                });
            `,
            pattern: /escaping callback cannot capture platform event value 'payload'/,
        },
        {
            name: "stored-closure",
            declarations: "const saved = new Set<() => void>();",
            body: `
                const later = (): void => {
                    payload.domEvent.preventDefault();
                };
                saved.add(later);
            `,
            pattern: /escaping callback cannot capture platform event value 'payload'/,
        },
        {
            name: "nested-record-array",
            declarations: `
                interface Envelope { nested: { payload: Payload }; }
                const saved: Envelope[] = [];
            `,
            body: `
                const envelope: Envelope = { nested: { payload } };
                saved.push(envelope);
            `,
            pattern: /through Array\.push/,
        },
    ];

    for (const escape of cases) {
        assert.throws(
            () =>
                compileSource(
                    `
                        import { createEngine } from "@babylonjs/lite";
                        interface Payload {
                            domEvent: MouseEvent;
                            consumed: boolean;
                        }
                        ${escape.declarations}
                        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
                        await createEngine(canvas);
                        canvas.addEventListener("mousedown", (event) => {
                            const payload: Payload = {
                                domEvent: event,
                                consumed: false,
                            };
                            ${escape.body}
                        });
                    `,
                    { fileName: `test/borrow-${escape.name}.ts` },
                ),
            (error: unknown) => {
                assert.ok(error instanceof CompileError);
                assert.match(
                    error.message,
                    new RegExp(`^test/borrow-${escape.name}\\.ts:\\d+:\\d+:`),
                );
                assert.match(error.message, escape.pattern);
                return true;
            },
        );
    }
});

test("follows helper call graphs when checking borrowed callback captures", () => {
    const cases = [
        {
            name: "direct",
            helpers: "",
            invoke: "payload.domEvent.preventDefault();",
        },
        {
            name: "one-hop",
            helpers: `
                function capture(): void {
                    payload.domEvent.preventDefault();
                }
            `,
            invoke: "capture();",
        },
        {
            name: "multi-hop",
            helpers: `
                function capture(): void {
                    payload.domEvent.preventDefault();
                }
                function hop(): void {
                    capture();
                }
            `,
            invoke: "hop();",
        },
        {
            name: "recursive-cycle",
            helpers: `
                function first(recurse: boolean): void {
                    if (recurse) second(false);
                }
                function second(recurse: boolean): void {
                    if (recurse) first(false);
                    payload.domEvent.preventDefault();
                }
            `,
            invoke: "first(true);",
        },
    ];

    for (const entry of cases) {
        assert.throws(
            () =>
                compileSource(
                    `
                        import { createEngine } from "@babylonjs/lite";
                        interface Payload {
                            domEvent: MouseEvent;
                        }
                        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
                        await createEngine(canvas);
                        canvas.addEventListener("mousedown", (event) => {
                            const payload: Payload = { domEvent: event };
                            ${entry.helpers}
                            window.addEventListener("mouseup", () => {
                                ${entry.invoke}
                            });
                        });
                    `,
                    {
                        fileName:
                            `test/borrow-helper-${entry.name}.ts`,
                    },
                ),
            (error: unknown) => {
                assert.ok(error instanceof CompileError);
                assert.match(
                    error.message,
                    new RegExp(
                        `^test/borrow-helper-${entry.name}\\.ts:\\d+:\\d+:`,
                    ),
                );
                assert.match(
                    error.message,
                    /escaping callback cannot capture platform event value 'payload'/,
                );
                return true;
            },
        );
    }
});

test("refuses unrelated DOM records and unknown MouseEvent provenance", () => {
    assert.throws(
        () =>
            compileSource(`
                interface FocusPayload {
                    event: FocusEvent;
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
        /must come from the active synchronous platform callback/,
    );
});
