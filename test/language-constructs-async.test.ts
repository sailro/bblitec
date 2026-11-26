import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { check, checkInRealm } from "./language-constructs.js";

check(
    "kept-callbacks-through-cycles-and-awaits",
    `
    class Relay {
        private kept: Array<() => void> = [];
        a(cb: () => void, depth: number): void {
            if (depth > 0) this.b(() => cb(), depth - 1);
            else this.kept.push(cb);
        }
        b(cb: () => void, depth: number): void { this.a(() => cb(), depth); }
        fire(): void { for (const cb of this.kept) cb(); }
    }
    async function later(cb: () => void): Promise<void> {
        await Promise.resolve(0);
        cb();
    }
    async function main(): Promise<void> {
        let viaA = 0, viaB = 0, viaAwait = 0;
        const relay = new Relay();
        relay.a(() => { viaA++; }, 2);
        relay.b(() => { viaB++; }, 2);
        relay.fire();
        if (viaA !== 1 || viaB !== 1) throw new Error("mutual recursion");
        await later(() => { viaAwait++; });
        if (viaAwait !== 1) throw new Error("callback after an await");
    }
    void main();
`,
);

checkInRealm(
    "promise-reaction-closure-calling-its-enclosing-function",
    `
    let requested = 1;
    let gen = 0;
    let inFlight = false;
    let seen = "";
    function request(): void {
        const x = requested;
        const generation = ++gen;
        inFlight = true;
        const finish = (point: number | null): void => {
            if (generation !== gen) return;
            inFlight = false;
            if (x !== requested) {
                request();
                return;
            }
            seen += String(point) + ";";
        };
        void Promise.resolve()
            .then(() => x * 2)
            .then(finish, () => finish(null));
    }
    request();
    requested = 2;
    setTimeout(() => {
        if (seen !== "4;" || inFlight) throw new Error("seen " + seen);
        globalThis.close();
    }, 0);
`,
);

checkInRealm(
    "loops-start-async-activations-per-iteration",
    `
    const log: string[] = [];
    async function settle(name: string): Promise<void> {
        await Promise.resolve();
        log.push(name);
    }
    const handlers: Array<() => Promise<void>> = [];
    function fill(): void {
        for (const name of ["a", "b", "c"]) {
            handlers.push(async () => { await settle("late " + name); });
            void settle(name);
        }
    }
    fill();
    setTimeout(async () => {
        for (const handler of handlers) await handler();
        if (log.join(",") !== "a,b,c,late a,late b,late c") throw new Error("log " + log.join(","));
        globalThis.close();
    }, 0);
`,
);

checkInRealm(
    "function-fields-return-dynamic-members-through-promises",
    `
    interface Entry { label: string; view?: unknown }
    interface Follower { follow(dirty?: number | null): boolean }
    interface Field { outline: (from: number) => Entry[]; first: () => Entry; follow: (dirty?: number | null) => boolean }
    const followers = new Set<Follower>();
    async function createField(view: object): Promise<Field> {
        await Promise.resolve();
        const entries: Entry[] = [{ label: "first", view }, { label: "second" }];
        let follows = 0;
        return {
            outline: (from: number) => entries.slice(from),
            first: () => entries[0]!,
            follow: (dirty?: number | null) => ++follows > 0 && dirty !== undefined,
        };
    }
    void (async () => {
        const view = { id: 7 };
        const field = await createField(view);
        followers.add(field);
        for (const follower of followers) if (follower !== field || !follower.follow(null)) throw new Error("follower");
        const all = field.outline(0);
        if (all.length !== 2 || all[0]!.view !== view || all[1]!.view !== undefined) throw new Error("outline");
        const first = field.first();
        if (first !== all[0] || first.label !== "first") throw new Error("identity");
        first.view = 3;
        if (field.outline(0)[0]!.view !== 3 || field.outline(1)[0]!.label !== "second") throw new Error("shared entry");
        globalThis.close();
    })();
`,
);

checkInRealm(
    "promise-combinators-and-microtasks-without-engine",
    `
    let log = "";
    queueMicrotask(() => { log += "m"; });
    log += "s";
    void (async () => {
        await Promise.resolve();
        if (log !== "sm") throw new Error("microtask order " + log);
        const raced = await Promise.race([Promise.resolve(1), new Promise<number>(() => {})]);
        const first = await Promise.any([Promise.reject(new Error("x")), Promise.resolve(2)]);
        const settled = await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("y"))]);
        if (raced !== 1 || first !== 2 || settled[1]!.status !== "rejected") throw new Error("combinators");
        const reasons: string[] = [];
        try {
            await Promise.any([Promise.reject(new Error("a")), Promise.reject(new Error("b"))]);
        } catch (error) {
            if (!(error instanceof AggregateError)) throw new Error("not aggregate");
            reasons.push(error.message);
        }
        try { await Promise.any([] as Promise<number>[]); } catch (error) { reasons.push(String(error instanceof AggregateError)); }
        if (reasons.join("|") !== "All promises were rejected|true") throw new Error("aggregate " + reasons.join("|"));
        const stored: Promise<number>[] = [Promise.reject(new Error("c")), Promise.resolve(4)];
        if ((await Promise.any(stored)) !== 4) throw new Error("stored any");
        globalThis.close();
    })();
`,
);

checkInRealm(
    "rejected promises carry an Error or a string to any handler",
    `
    let seen = "";
    function declared(error: unknown): string { seen += String(error) + ";"; return "declared"; }
    const stored = (reason: unknown): string => { seen += typeof reason + ":" + String(reason) + ";"; return "stored"; };
    function quiet(error: Error): void { seen += error.message + ";"; }
    const failure = new Error("same");
    void (async () => {
        const results = [
            await Promise.reject(new Error("a")).catch(declared),
            await Promise.reject("b").catch(stored),
            await Promise.reject(new Error("c")).catch((error: unknown) => String(error)),
        ];
        await Promise.reject(new Error("d")).catch(quiet);
        const same = await Promise.reject(failure).catch((reason: unknown) => reason === failure);
        let caught = "";
        try { await Promise.reject("e"); } catch (reason) { caught = typeof reason + ":" + String(reason); }
        if (results.join() !== "declared,stored,Error: c" || !same || caught !== "string:e")
            throw new Error("results " + results.join() + " " + same + " " + caught);
        if (seen !== "Error: a;string:b;d;") throw new Error("seen " + seen);
        globalThis.close();
    })();
`,
);

checkInRealm(
    "an executor's reject carries a string to its handler",
    `
    let seen = "";
    new Promise<number>((_, reject) => reject("boom")).catch((reason: unknown) => {
        seen = typeof reason + ":" + String(reason);
        return 0;
    }).then(() => {
        if (seen !== "string:boom") throw new Error("seen " + seen);
        globalThis.close();
    });
`,
);

checkInRealm(
    "promise-combinators-over-literal-spreads",
    `
    const order: string[] = [];
    async function tick(count: number): Promise<void> { for (let i = 0; i < count; i++) await Promise.resolve(); }
    async function step(name: string): Promise<void> { order.push(name); await tick(1); }
    async function value(name: string, result: number, delay: number): Promise<number> { order.push(name); await tick(delay); return result; }
    async function fail(error: Error, delay: number): Promise<number> { await tick(delay); throw error; }
    function startAll(extra: boolean, ready: Promise<void> | null): Promise<void> | null {
        return Promise.all([ready!, step("a"), ...(extra ? [step("extra")] : [])]).then(() => undefined);
    }
    function many(names: string[]): Promise<number>[] { order.push("spread"); return names.map((name, index) => value(name, index, 3 - index)); }
    void (async () => {
        const started = startAll(true, step("first"));
        if (order.join() !== "first,a,extra") throw new Error("inputs start in order " + order.join());
        await started;
        await startAll(false, step("again"));
        order.length = 0;
        const values = await Promise.all([value("x", 10, 1), ...many(["p", "q"]), value("y", 20, 0)]);
        if (values.join() !== "10,0,1,20" || order.join() !== "x,spread,p,q,y") throw new Error("ordered results " + values.join() + " " + order.join());
        const xs = [1, 2, 3];
        const doubled = await Promise.all([...xs.map((x) => value("m", x * 2, 3 - x)), value("n", 7, 0)]);
        if (doubled.join() !== "2,4,6,7") throw new Error("mapped spread " + doubled.join());
        const voids = await Promise.all([step("v"), ...[step("w")]]);
        if (voids.length !== 2 || voids[0] !== undefined || voids[1] !== undefined) throw new Error("void results are undefined");
        const pending: Promise<void>[] = [step("k"), step("l")];
        const fromStored = await Promise.all(pending);
        if (fromStored.length !== 2 || fromStored[1] !== undefined) throw new Error("stored void array");
        const slow = new RangeError("slow"), fast = new TypeError("fast");
        let caught = "none";
        try { await Promise.all([fail(slow, 3), ...[fail(fast, 1)], value("z", 1, 0)]); } catch (error) { caught = error === fast ? "fast" : "other"; }
        if (caught !== "fast") throw new Error("first rejection wins: " + caught);
        const settled = await Promise.allSettled([value("s", 5, 1), ...[fail(slow, 0)]]);
        const kept = settled[0]!, lost = settled[1]!;
        if (kept.status !== "fulfilled" || kept.value !== 5 || lost.status !== "rejected" || lost.reason !== slow) throw new Error("settled spread");
        const winner = await Promise.race([value("r", 1, 3), ...[value("t", 2, 1)]]);
        const any = await Promise.any([fail(slow, 0), ...[value("u", 9, 2)]]);
        if (winner !== 2 || any !== 9) throw new Error("race and any over spreads");
        globalThis.close();
    })();
`,
);

test("promise combinator literal spreads join settlement types and synchronous values", () => {
    assert.doesNotThrow(() =>
        compileSource(
            "async function n(): Promise<number> { return 1; } async function s(): Promise<string> { return ''; } const xs = [s()]; void Promise.all([n(), ...xs]);",
        ),
    );
    assert.doesNotThrow(() =>
        compileSource(
            "async function n(): Promise<number> { return 1; } const xs = [1, 2]; void Promise.all([n(), ...xs]);",
        ),
    );
});

checkInRealm(
    "promises-that-only-reject-join-any-settlement-type",
    `
    const conditional = new Error("conditional"), spread = new Error("spread"), returned = new Error("returned");
    async function fail(reason: Error): Promise<never> { await Promise.resolve(); throw reason; }
    async function num(value: number): Promise<number> { await Promise.resolve(); return value; }
    async function relay(reason: Error): Promise<number> { return fail(reason); }
    let flip = 0;
    void (async () => {
        const reasons: string[] = [];
        const picked: Promise<number> = flip > 0 ? fail(conditional) : num(4);
        if ((await picked) !== 4) throw new Error("fulfilled arm");
        flip = 1;
        const rejected: Promise<number> = flip > 0 ? fail(conditional) : num(4);
        try { await rejected; } catch (error) { reasons.push(error === conditional ? "conditional" : "other"); }
        const pending = [num(1), num(2)];
        try { await Promise.all([fail(spread), ...pending]); } catch (error) { reasons.push(error === spread ? "spread" : "other"); }
        const settled = await Promise.allSettled([fail(spread), ...pending]);
        const first = settled[0]!, last = settled[2]!;
        if (settled.length !== 3 || first.status !== "rejected" || first.reason !== spread || last.status !== "fulfilled" || last.value !== 2) throw new Error("settled");
        try { await relay(returned); } catch (error) { reasons.push(error === returned ? "returned" : "other"); }
        if (reasons.join() !== "conditional,spread,returned") throw new Error(reasons.join());
        globalThis.close();
    })();
`,
);

checkInRealm(
    "reactions-adopt-a-value-or-promise-result",
    `
    async function later(value: number): Promise<number> { await Promise.resolve(); return value; }
    function pick(slow: boolean, value: number): number | Promise<number> { return slow ? later(value) : value; }
    let slow = false;
    void (async () => {
        const quick = await Promise.resolve(0).then(() => pick(slow, 2));
        slow = true;
        const adopted = await Promise.resolve(0).then(() => pick(slow, 5));
        if (quick + 1 !== 3 || adopted + 1 !== 6) throw new Error("adopted " + quick + " " + adopted);
        globalThis.close();
    })();
`,
);

checkInRealm(
    "instanceof-promise-tells-a-value-or-promise-result-apart",
    `
    const setters: ((id: string) => boolean | Promise<boolean>)[] = [
        (id) => id.length > 1,
        (id) => Promise.resolve(id.length > 2),
    ];
    let log = "";
    const accepted = (ok: boolean): boolean => {
        log += ok ? "y" : "n";
        return ok;
    };
    let pending = 0;
    for (const set of setters) {
        const result = set("abc");
        if (result instanceof Promise) {
            pending++;
            void result.then(accepted);
        } else accepted(result);
    }
    if (pending !== 1 || log !== "y") throw new Error("pending " + pending + " log " + log);
    setTimeout(() => {
        if (log !== "yy") throw new Error("settled log " + log);
        globalThis.close();
    }, 0);
`,
);

checkInRealm(
    "instanceof-promise-is-false-for-a-result-that-holds-no-promise",
    `
    interface Selection {
        set(id: string): void | boolean | Promise<void | boolean>;
        commit?(): void | boolean | Promise<void | boolean>;
    }
    let reopened = 0;
    let log = "";
    const pick = (selection: Selection, id: string): void => {
        const done = (accepted: void | boolean): void => { log += accepted === false ? "n" : "y"; };
        const selected = (accepted: void | boolean): void => {
            if (accepted === false) return done(false);
            const result = selection.commit?.();
            if (result instanceof Promise) void result.then(done);
            else done(result);
        };
        const result = selection.set(id);
        if (result instanceof Promise) void result.then(selected);
        else selected(result);
    };
    // A commit returning nothing, and a selection without one.
    pick({ set: (id) => (id.startsWith("now") ? true : Promise.resolve(true)), commit: () => { reopened++; } }, "now");
    pick({ set: (id) => { log += id.length > 0 ? "s" : "e"; } }, "stair");
    if (log !== "ysy" || reopened !== 1) throw new Error("log " + log + " reopened " + reopened);
    pick({ set: () => Promise.resolve(true), commit: () => { reopened++; } }, "later");
    setTimeout(() => {
        if (log !== "ysyy" || reopened !== 2) throw new Error("settled log " + log + " reopened " + reopened);
        globalThis.close();
    }, 0);
`,
);

check(
    "promise-rejection-parameters",
    `
    let seen = "";
    let marked = "";
    let calm = 0;
    let armed = true;
    async function risky(): Promise<void> {
        if (armed) throw new Error("boom");
        calm++;
    }
    // Each reaction touches state no later statement does, so running it
    // at once keeps JavaScript's order.
    void risky().catch((error) => {
        if (!(error instanceof Error) || error.message !== "boom") throw new Error("catch binding");
        seen = error.message;
    });
    void risky().then(() => { throw new Error("fulfilled"); }, (error) => {
        if (error.message !== "boom") throw new Error("rejection binding");
    });
    void risky().catch((error) => { if (error.message.length !== 4) return; marked = "!"; });
    armed = false;
    void risky().catch((error) => { throw new Error("unexpected " + error.message); });
`,
);

test("promise rejection callbacks refuse parameters the rejection cannot supply", () => {
    assert.throws(
        () =>
            compileSource(`
        let calm = 0;
        async function risky(): Promise<void> { calm++; }
        void risky().catch((error, extra) => { if (error || extra) calm++; });
    `),
        /declares more parameters than the operation supplies/,
    );
});

check(
    "immediate-promise-callbacks-destructure-their-value",
    `
    interface Pair { wave: number; caustics: number }
    async function load(n: number): Promise<number> { return n * 2; }
    async function loadPair(): Promise<Pair> { return { wave: 3, caustics: 4 }; }
    void Promise.all([load(1), load(2)]).then(([wave, caustics]) => {
        if (wave !== 2 || caustics !== 4) throw new Error("tuple destructuring");
    });
    void loadPair().then(({ wave, caustics: renamed }) => {
        if (wave !== 3 || renamed !== 4) throw new Error("record destructuring");
    });
`,
);

test("immediate promise callbacks refuse rest parameters", () => {
    assert.throws(
        () =>
            compileSource(
                "async function load(): Promise<number> { return 1; } void load().then((...values) => { const unused = values.length; });",
            ),
        /Immediate promise callback accepts zero parameters or one parameter binding/,
    );
});

checkInRealm(
    "async-returns-of-a-promise-or-a-record-branch",
    `
    type Result = { status: "loaded"; text: string } | { status: "invalid" } | { status: "cancelled" } | { status: "error" };
    async function parse(text: string): Promise<Result> {
        await Promise.resolve();
        return text.length > 0 ? { status: "loaded", text } : { status: "invalid" };
    }
    interface Picked { name: string; }
    async function choose(name: string): Promise<Picked | null> {
        await Promise.resolve();
        if (name === "-") return null;
        return { name };
    }
    async function pick(name: string): Promise<Result> {
        try {
            const file = await choose(name);
            return file ? parse(file.name) : { status: "cancelled" };
        } catch {
            return { status: "error" };
        }
    }
    async function direct(name: string): Promise<Result> {
        return name === "" ? { status: "cancelled" } : parse(name);
    }
    void (async () => {
        const seen = [await pick("a"), await pick("-"), await pick(""), await direct(""), await direct("b")].map((r) => r.status);
        if (seen.join(",") !== "loaded,cancelled,invalid,cancelled,loaded") throw new Error(seen.join(","));
        globalThis.close();
    })();
`,
);

checkInRealm(
    "suspended-activations-resume-after-the-code-that-follows-them",
    `
    const gathered: string[] = [];
    const returned: string[] = [];
    const discarded: string[] = [];
    const reacted: string[] = [];
    async function a(into: string[]): Promise<void> { into.push("a1"); await null; into.push("a2"); }
    async function b(into: string[]): Promise<void> { into.push("b1"); await Promise.resolve(); into.push("b2"); }
    async function passes(into: string[]): Promise<void> { return a(into); }
    async function one(): Promise<number> { return 1; }
    async function main(): Promise<void> {
        await Promise.all([a(gathered), b(gathered)]);
        if (gathered.join() !== "a1,b1,a2,b2") throw new Error("gathered " + gathered.join());
        await Promise.all([passes(returned), b(returned)]);
        if (returned.join() !== "a1,b1,a2,b2") throw new Error("returned " + returned.join());
        void a(discarded);
        discarded.push("after");
        await null;
        if (discarded.join() !== "a1,after,a2") throw new Error("discarded " + discarded.join());
        void one().then(() => { reacted.push("then"); });
        reacted.push("after");
        await null;
        if (reacted.join() !== "after,then") throw new Error("reacted " + reacted.join());
        globalThis.close();
    }
    void main();
`,
);

check(
    "gathered-activations-on-fresh-objects-run-where-they-start",
    `
    interface Level { lit: boolean; level: number }
    async function make(level: number): Promise<Level> {
        const made: Level = { lit: false, level: 0 };
        made.lit = true;
        await null;
        made.level = level;
        return made;
    }
    async function main(): Promise<void> {
        const [first, second] = await Promise.all([make(1), make(2)]);
        if (!first.lit || first.level !== 1 || second.level !== 2) throw new Error("fresh results");
    }
    void main();
`,
);

checkInRealm(
    "awaited-nullish-fallbacks-run-only-when-absent",
    `
    const order: string[] = [];
    async function load(n: number): Promise<number> {
        order.push("load" + n);
        await Promise.resolve();
        return n * 2;
    }
    const sizes = new Map<string, number>([["a", 1]]);
    async function count(key: string): Promise<number> {
        order.push("count:" + key);
        const value = sizes.get(key) ?? (await load(5));
        order.push("got" + value);
        return value;
    }
    const labels = new Map<string, string>([["a", "x"]]);
    async function label(key: string): Promise<string> {
        return labels.get(key) ?? String(await load(1));
    }
    void (async () => {
        const counted = [await count("a"), await count("b")];
        const labelled = [await label("a"), await label("b")];
        if (counted.join(",") !== "1,10" || labelled.join(",") !== "x,2") throw new Error(counted.join(",") + labelled.join(","));
        if (order.join(",") !== "count:a,got1,count:b,load5,got10,load1") throw new Error(order.join(","));
        globalThis.close();
    })();
`,
);

checkInRealm(
    "async-callees-read-records-past-the-call",
    `
    interface Wide { x: number; y: number; tag: string }
    interface Narrow { x: number; y: number }
    const third: Wide = { x: 1, y: 2, tag: "c" };
    async function readLater(p: Narrow): Promise<number> { await Promise.resolve(); return p.x; }
    void (async () => {
        const pending = readLater(third);
        third.x = 50;
        if ((await pending) !== 50) throw new Error("an async callee reads the original after the call returns");
        globalThis.close();
    })();
`,
);

checkInRealm(
    "async-results-of-another-record-type-settle-as-the-declared-type",
    `
    interface Info { name: string; icon: string | null; tint: [number, number, number] | null }
    const cache = new Map<string, Promise<Info>>();
    function delay(value: number): Promise<number> { return new Promise((resolve) => setTimeout(() => resolve(value), 0)); }
    async function readUncached(url: string): Promise<Info> {
        const size = await delay(url.length);
        return { name: url, icon: size > 3 ? "icon" : null, tint: size > 100 ? [1, 2, 3] : null };
    }
    function readInfo(url: string): Promise<Info> {
        let p = cache.get(url);
        if (!p) {
            p = readUncached(url);
            cache.set(url, p);
        }
        return p;
    }
    const first = readInfo("abcd");
    if (first !== readInfo("abcd")) throw new Error("cached promise");
    void first.then((info) => {
        if (info.icon !== "icon" || info.name !== "abcd" || info.tint !== null) throw new Error("settled record");
        globalThis.close();
    });
`,
);

checkInRealm(
    "stored-promise-then-finally",
    `
    interface Deps { spawn(x: number): Promise<boolean>; despawn(): void }
    let spawned = 0;
    let spawning = false;
    let finished = 0;
    function createLive(deps: Deps): { start(x: number): void } {
        return {
            start(x) {
                spawning = true;
                void deps.spawn(x)
                    .then((ok) => { if (ok) spawned++; else deps.despawn(); })
                    .finally(() => {
                        spawning = false;
                        finished++;
                        if (spawned !== 1) throw new Error("fulfillment reaction runs before cleanup");
                        globalThis.close();
                    });
            },
        };
    }
    const lives: Array<typeof createLive> = [createLive];
    lives[0]!({ spawn: async (x) => x > 0, despawn: () => {} }).start(1);
    if (!spawning || finished !== 0) throw new Error("cleanup waits for settlement");
`,
);

checkInRealm(
    "generic-method-over-a-value-or-promise-union",
    `
    type Outcome = { readonly committed: true; readonly created: number } | { readonly committed: false; readonly reason: string };
    interface Deps { runWorldEdit<T>(operation: () => T | Promise<T>): Promise<T | null>; syncNow(): void }
    async function runEdit(deps: Deps, command: () => Outcome): Promise<Outcome> {
        return (await deps.runWorldEdit(async () => {
            const outcome = command();
            if (outcome.committed) deps.syncNow();
            return outcome;
        })) ?? { committed: false, reason: "transaction" };
    }
    let synced = 0;
    const deps: Deps = { runWorldEdit: async (operation) => await operation(), syncNow: () => { synced++; } };
    const refusing: Deps = { runWorldEdit: async () => null, syncNow: () => { synced += 10; } };
    const edits: Array<typeof runEdit> = [runEdit];
    void (async () => {
        const created = await edits[0]!(deps, () => ({ committed: true, created: 3 }));
        const refused = await edits[0]!(refusing, () => ({ committed: true, created: 4 }));
        if (!created.committed || created.created !== 3 || refused.committed || refused.reason !== "transaction" || synced !== 1)
            throw new Error("generic edit lane");
        globalThis.close();
    })();
`,
);

checkInRealm(
    "async-functions-a-record-carries-re-enter-their-caller",
    `
    const log: string[] = [];
    function drive(frame: () => void): () => void {
        let disposed = false;
        setTimeout(() => { if (!disposed) frame(); }, 0);
        return () => { disposed = true; };
    }
    interface Nav { goToMenu: () => Promise<void>; restart?: () => Promise<void> }
    async function build(nav: Nav, menu: boolean): Promise<() => void> {
        await Promise.resolve();
        log.push(menu ? "menu" : "race");
        const exit = menu ? null : { hint: 1 };
        return drive(() => {
            if (exit) void nav.goToMenu();
            else if (nav.restart) void nav.restart();
        });
    }
    async function run(): Promise<void> {
        let stop: (() => void) | null = null;
        async function goToMenu(): Promise<void> {
            stop?.();
            stop = await build({ goToMenu }, true);
        }
        function race(): () => Promise<void> {
            const start = async (): Promise<void> => {
                stop?.();
                stop = await build({ goToMenu, restart: start }, false);
            };
            return start;
        }
        await race()();
        setTimeout(() => setTimeout(() => {
            if (log.join(",") !== "race,menu") throw new Error(log.join(","));
            globalThis.close();
        }, 0), 0);
    }
    void run();
`,
);

check(
    "awaited-records-keep-their-record-type",
    `
    interface Grid { section: string; columns: number }
    interface Sheet { texture: number; grids: Map<string, Grid>; grid: (section: string) => Grid }
    async function loadSheet(texture: number): Promise<Sheet> {
        const grids = new Map<string, Grid>();
        grids.set("main", { section: "main", columns: texture });
        return { texture, grids, grid: (section) => grids.get(section)! };
    }
    interface Sheets { terrain: Sheet; hills: Sheet }
    async function main(): Promise<void> {
        const [terrain, hills] = await Promise.all([loadSheet(1), loadSheet(2)]);
        const sheets: Sheets = { terrain, hills };
        if (sheets.terrain !== terrain || sheets.hills.grid("main").columns !== 2) throw new Error("awaited sheets");
        const seen = new Set<Sheet>([terrain]);
        if (!seen.has(sheets.terrain) || seen.has(hills)) throw new Error("awaited identity");
    }
    void main();
`,
);

checkInRealm(
    "settled-records-enumerate-the-keys-their-tags-select",
    `
    setTimeout(() => {
        void (async () => {
            const failure = new RangeError("first");
            const settled = await Promise.allSettled([Promise.resolve(3), Promise.reject(failure)]);
            const rejected = settled[1]!;
            if (rejected.status !== "rejected" || rejected.reason !== failure) throw new Error("rejection");
            if (Object.keys(rejected).join() !== "status,reason") throw new Error("rejected keys " + Object.keys(rejected).join());
            const keys: string[] = [];
            for (const entry of settled) keys.push(Object.keys(entry).join("+"));
            if (keys.join() !== "status+value,status+reason") throw new Error("keys per element " + keys.join());
            if (!("value" in settled[0]!) || "reason" in settled[0]!) throw new Error("membership");
            globalThis.close();
        })();
    }, 0);
`,
);

checkInRealm(
    "optional-promise-reactions",
    `
    // A reaction on a promise that may be absent runs on the present one;
    // an absent receiver evaluates none of its arguments.
    let seen = "";
    let evaluated = 0;
    setTimeout(() => {
        if (seen.split("").sort().join("") !== "1cf") throw new Error("seen " + seen);
        if (evaluated !== 1) throw new Error("arguments evaluated " + evaluated);
        globalThis.close();
    }, 5);
    async function load(n: number): Promise<number> { if (n > 1) throw new Error("big"); return n; }
    function kick(n: number): Promise<number> | undefined { return n > 0 ? load(n) : undefined; }
    function maybe(n: number): Promise<number> | null { return n > 0 ? load(n) : null; }
    const recovery = (): (() => void) => { evaluated++; return () => { seen += "c"; }; };
    for (const n of [2, 0]) { const p = kick(n); void p?.catch(recovery()); }
    for (const n of [1, 0]) { const p = maybe(n); p?.then((value) => { seen += String(value); }); }
    let pending: Promise<number> | undefined;
    pending?.finally(() => { seen += "never"; });
    pending = load(1);
    void pending?.finally(() => { seen += "f"; });
`,
);

checkInRealm(
    "later-bindings-read-from-nested-levels-across-awaits",
    `
    // The storage declared ahead of an awaiting statement lives across the
    // await: closures built before it read the binding declared after it.
    const reads: (() => string)[] = [];
    async function loaded(text: string): Promise<string> {
        await Promise.resolve();
        return text + "!";
    }
    async function start(active: boolean): Promise<string> {
        if (active) {
            reads.push(() => label + ":" + sizes.length);
        }
        const first = await loaded("a");
        for (const part of ["x", "y"]) {
            if (part !== "x") {
                reads.push(() => suffix + part);
            }
            const suffix = await loaded(part);
        }
        const label = first + (await loaded("b"));
        const sizes = [label.length];
        return reads.map((read) => read()).join();
    }
    void start(true).then((seen) => {
        if (seen !== "a!b!:1,y!y") throw new Error("across awaits " + seen);
        globalThis.close();
    });
`,
);

checkInRealm(
    "value-or-promise-results-are-awaited-as-either-arm",
    `
    type Result = { changed: true; hostId: number } | { changed: false; reason: "stale" | "missing" };
    type MaybeAsync<T> = T | Promise<T>;
    function createCommand(deps: { read(id: number): { mix: number } | undefined; prepare: () => Promise<void> }) {
        const refused = (reason: "stale" | "missing"): Result => ({ changed: false, reason });
        const publish = (id: number, slow: boolean): MaybeAsync<Result> => {
            if (slow)
                return (async (): Promise<Result> => {
                    await deps.prepare();
                    return { changed: true, hostId: id };
                })();
            return { changed: true, hostId: id };
        };
        const pick = (id: number, slow: boolean): MaybeAsync<Result> => {
            const record = deps.read(id);
            if (!record) return refused("missing");
            if (record.mix < 0) return refused("stale");
            return publish(id, slow);
        };
        return {
            preview: (id: number): MaybeAsync<Result> => pick(id, false),
            commit: async (id: number): Promise<boolean> => (await pick(id, true)).changed,
        };
    }
    const creates: Array<typeof createCommand> = [createCommand];
    let prepared = 0;
    const command = creates[0]!({ read: (id) => (id > 0 ? { mix: id - 2 } : undefined), prepare: async () => { prepared++; } });
    const order: string[] = [];
    void (async () => {
        const quick = await command.preview(3);
        order.push("quick:" + quick.changed);
        const missing = await command.preview(0);
        order.push("missing:" + (missing.changed ? "" : missing.reason));
        const committed = await command.commit(4);
        order.push("commit:" + committed + ":" + prepared);
        const stale = await command.commit(1);
        order.push("stale:" + stale);
        if (order.join(",") !== "quick:true,missing:missing,commit:true:1,stale:false") throw new Error(order.join(","));
        globalThis.close();
    })();
`,
);

// Cancelling a timer whose identifier may be absent cancels nothing while it
// is absent.
checkInRealm(
    "timer-cancellation-of-an-absent-identifier",
    `
    const ready = new Promise<void>((resolve) => setTimeout(resolve, 0));
    let fired = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    function end(): void { fired++; }
    function key(): void { clearTimeout(settle); settle = setTimeout(end, 0); }
    function cancel(): void { clearTimeout(settle); settle = undefined; }
    const handlers: Array<() => void> = [key, cancel];
    void (async () => {
        await ready;
        handlers[1]!();
        handlers[0]!();
        handlers[0]!();
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        if (fired !== 1) throw new Error("one settled burst " + fired);
        handlers[0]!();
        handlers[1]!();
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        if (fired !== 1) throw new Error("cancelled burst");
        globalThis.close();
    })();
`,
);

checkInRealm(
    "for await suspends inside catch and finally blocks",
    `
    async function fails(): Promise<void> {
        await Promise.resolve();
        throw new Error("x");
    }
    async function* values(): AsyncGenerator<number, void, unknown> {
        yield 1;
    }
    void (async () => {
        let n = 0;
        try {
            await fails();
        } catch {
            for await (const v of values()) n += v;
        }
        try {
            await Promise.resolve();
        } finally {
            for await (const v of values()) n += v * 2;
        }
        if (n !== 3) throw new Error(String(n));
        globalThis.close();
    })();
    `,
);

checkInRealm(
    "a promise reaction completes with what every dispatched method body completes with",
    `
    const played: number[] = [];
    class Voice {
        start(value: number): void {
            if (value < 0) return;
            played.push(value);
        }
        play(value: Promise<number>): Promise<void> {
            return value.then((settled) => this.start(settled));
        }
    }
    class Echo extends Voice {
        override start(value: number): void { played.push(value * 10); }
    }
    void (async () => {
        const voices: Voice[] = [new Voice(), new Echo(), new Voice()];
        const results = [
            await voices[0]!.play(Promise.resolve(1)),
            await voices[1]!.play(Promise.resolve(2)),
            await voices[2]!.play(Promise.resolve(-1)),
        ];
        if (played.join() !== "1,20" || results.some((result) => result !== undefined)) throw new Error("dispatched completion " + played.join());
        globalThis.close();
    })();
    `,
);

test("a promise reaction refuses a dispatched method override that completes with a value", () => {
    assert.throws(
        () =>
            compileSource(`
            class Voice {
                start(value: number): void { if (value < 0) return; }
                play(value: Promise<number>): Promise<void> { return value.then((settled) => this.start(settled)); }
            }
            class Echo extends Voice {
                start(value: number): number { return value; }
            }
            const voices: Voice[] = [new Voice(), new Echo()];
            void (async () => { await voices[1]!.play(Promise.resolve(2)); globalThis.close(); })();
        `),
        /Promise reaction with a void result requires a proven undefined completion/,
    );
});

// A program that declares no `then` member holds only native promises
// where it types a PromiseLike: a shared closure awaits one as a promise.
checkInRealm(
    "a PromiseLike only promises implement awaits as a promise",
    `
    interface Readiness {
        readonly worldReady: PromiseLike<void>;
        readonly postReady?: PromiseLike<void> | null;
        readonly renderReady?: PromiseLike<void> | null;
        readonly waitForGpuIdle: () => PromiseLike<void>;
        readonly onMilestone?: (milestone: string) => void;
    }
    async function waitFor(options: Readiness): Promise<void> {
        const observe = async (milestone: string, promise: PromiseLike<void> | null | undefined): Promise<void> => {
            if (promise) await promise;
            options.onMilestone?.(milestone);
        };
        await Promise.all([observe("world", options.worldReady), observe("post", options.postReady), observe("render", options.renderReady)]);
        await options.waitForGpuIdle();
        options.onMilestone?.("gpu");
    }
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    let order = "";
    void waitFor({
        worldReady: delay(4),
        postReady: Math.random() < 2 ? delay(1) : null,
        waitForGpuIdle: () => delay(1),
        onMilestone: (milestone) => {
            order += milestone + " ";
        },
    }).then(() => {
        if (order !== "render post world gpu ") throw new Error("order " + order);
        globalThis.close();
    });
    `,
);

test("a PromiseLike a declared thenable may implement refuses its assimilation", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Readiness {
                readonly worldReady: PromiseLike<void>;
                readonly postReady?: PromiseLike<void> | null;
                readonly renderReady?: PromiseLike<void> | null;
                readonly waitForGpuIdle: () => PromiseLike<void>;
                readonly onMilestone?: (milestone: string) => void;
            }
            async function waitFor(options: Readiness): Promise<void> {
                const observe = async (milestone: string, promise: PromiseLike<void> | null | undefined): Promise<void> => {
                    if (promise) await promise;
                    options.onMilestone?.(milestone);
                };
                await Promise.all([observe("world", options.worldReady), observe("post", options.postReady), observe("render", options.renderReady)]);
                await options.waitForGpuIdle();
                options.onMilestone?.("gpu");
            }
            const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
            let order = "";
            void waitFor({
                worldReady: delay(4),
                postReady: Math.random() < 2 ? delay(1) : null,
                waitForGpuIdle: () => delay(1),
                onMilestone: (milestone) => {
                    order += milestone + " ";
                },
            }).then(() => {
                if (order !== "render post world gpu ") throw new Error("order " + order);
                globalThis.close();
            });
            const custom = { then(resolve: (value: void) => void): void { resolve(); } };
            void waitFor({ worldReady: custom, waitForGpuIdle: () => custom });
        `),
        /Custom thenable assimilation requires an owned promise resolution protocol/,
    );
});

// A result that may be absent, a boolean or a promise is a promise only
// while present and holding its promise member.
checkInRealm(
    "an optional value-or-promise union is an instance of Promise in its promise member",
    `
    interface Action {
        readonly id: string;
        run: () => void | boolean | Promise<void | boolean>;
    }
    const actions: Action[] = [
        { id: "wave", run: () => {} },
        { id: "pick", run: () => true },
        {
            id: "save",
            run: async () => {
                await Promise.resolve();
                throw new Error("disk");
            },
        },
    ];
    let caught = "";
    let promises = 0;
    for (const action of actions) {
        const result = action.run();
        if (result instanceof Promise) {
            promises++;
            void result.catch((error: unknown) => {
                caught = action.id + ":" + (error as Error).message;
            });
        }
    }
    setTimeout(() => {
        if (promises !== 1 || caught !== "save:disk") throw new Error("instances " + promises + " " + caught);
        globalThis.close();
    }, 0);
    `,
);

// A void reaction completes as the functions its completion calls do:
// a callback parameter the caller fills, a chain of named arrows, a
// record's method and member, a dispatched method and an arrow called
// at once, each followed to a body that returns nothing.
checkInRealm(
    "a promise reaction follows the functions its completion calls",
    `
    let failures = 0;
    const count = (error: unknown): void => {
        failures += error instanceof Error ? 1 : 0;
    };
    const tally = (error: unknown): void => count(error);
    const report = (error: unknown): void => tally(error);
    type Hooks = { failed(error: unknown): void };
    function mount(hooks: Hooks, task: Promise<void>): Promise<void> {
        return task.catch(hooks.failed);
    }
    function ring(onError?: (error: unknown) => void): (task: Promise<void>) => Promise<void> {
        return (task) => mount({ failed: (error) => onError?.(error) }, task);
    }
    const handlers = {
        method(error: unknown): void {
            return tally(error);
        },
        member: (error: unknown): void => tally(error),
    };
    class Voice {
        fail(error: unknown): void {
            return tally(error);
        }
        play(task: Promise<void>): Promise<void> {
            return task.catch((error) => this.fail(error));
        }
    }
    const rejected = (): Promise<void> => Promise.reject(new Error("x"));
    void (async () => {
        await ring((error) => tally(error))(rejected());
        await rejected().catch(report);
        await rejected().catch((error) => handlers.method(error));
        await rejected().catch((error) => handlers.member(error));
        await new Voice().play(rejected());
        await rejected().catch((error) => ((inner: unknown) => tally(inner))(error));
        if (failures !== 6) throw new Error("reactions " + failures);
        globalThis.close();
    })();
    `,
);

test("a promise reaction refuses a chain that completes with a value", () => {
    assert.throws(
        () =>
            compileSource(`
            const measure: (error: unknown) => void = (error) => String(error).length;
            const tally = (error: unknown): void => measure(error);
            void Promise.reject(new Error("x")).catch((error) => tally(error)).finally(() => globalThis.close());
        `),
        /Promise reaction with a void result requires a proven undefined completion/,
    );
});

checkInRealm(
    "a reaction calling an omitted optional handler completes with undefined",
    `
    function widget(onError?: (error: unknown) => void): (fail: boolean) => Promise<void> {
        const hooks = { failed: (error: unknown) => onError?.(error) };
        return (fail) => Promise.resolve(fail).then((bad) => { if (bad) throw new Error("bad"); }).catch(hooks.failed);
    }
    let seen = 0;
    const quiet = widget();
    const loud = widget(() => { seen++; });
    void quiet(true).then(() => loud(true)).then(() => {
        if (seen !== 1) throw new Error("handled " + seen);
        globalThis.close();
    });
    `,
);

checkInRealm(
    "Promise.all settles to a new array",
    `
    const arr = [1, 2];
    void Promise.all(arr).then((out) => {
        out.push(3);
        if (arr.length !== 2 || out.length !== 3) throw new Error("all identity " + arr.length);
        globalThis.close();
    });
    `,
);

checkInRealm(
    "an-awaited-optional-call-keeps-the-null-its-promise-settles-with",
    `
    interface Opts { captureShot?: () => Promise<string | null> }
    const gate = new Float32Array([1, 0]);
    async function delayed(shot: string | null): Promise<string | null> {
        await Promise.resolve();
        return shot;
    }
    const blank: Opts = { captureShot: () => delayed(gate[1]! > 0 ? "late" : null) };
    const framed: Opts = { captureShot: () => delayed(gate[0]! > 0 ? "pic" : null) };
    const bare: Opts = {};
    async function shotOf(opts: Opts): Promise<string> {
        const settled = await opts.captureShot?.();
        const kept = (await opts.captureShot?.()) ?? "none";
        return (settled === null ? "null" : settled === undefined ? "undefined" : settled) + ":" + kept;
    }
    void Promise.all([shotOf(blank), shotOf(framed), shotOf(bare)]).then((shots) => {
        if (shots.join(",") !== "null:none,pic:pic,undefined:none") throw new Error(shots.join(","));
        globalThis.close();
    });
`,
);

checkInRealm(
    "a-promise-all-lane-of-undefined-is-undefined",
    `
    interface Pkg { name: string; size: number }
    const gate = new Float32Array([1, 0]);
    async function loadPkg(name: string): Promise<Pkg> { await Promise.resolve(); return { name, size: name.length }; }
    async function settle(): Promise<void> { await Promise.resolve(); }
    interface Opts { bodyUrl: string; brickUrl?: string }
    async function loadAssets(opts: Opts): Promise<string> {
        const [body, brick, done] = await Promise.all([loadPkg(opts.bodyUrl), opts.brickUrl ? loadPkg(opts.brickUrl) : undefined, settle()]);
        return body.name + ":" + (brick ? brick.name : "none") + ":" + String(done);
    }
    const withBrick: Opts = gate[0]! > 0 ? { bodyUrl: "wall", brickUrl: "brick" } : { bodyUrl: "x" };
    void Promise.all([loadAssets(withBrick), loadAssets({ bodyUrl: "slab" })]).then((names) => {
        if (names.join(",") !== "wall:brick:undefined,slab:none:undefined") throw new Error(names.join(","));
        globalThis.close();
    });
`,
);

checkInRealm(
    "a-promise-reaction-given-as-a-record-function-runs-it",
    `
    interface Hooks { failed(error: unknown): void; isFailed(): boolean }
    let failures = 0;
    const gate = new Float32Array([1]);
    function mount(hooks: Hooks) {
        const pending = new Set<Promise<void>>();
        let changed = false;
        const flush = (value: number): void => {
            if (hooks.isFailed()) return;
            const task = (value > 0 ? Promise.resolve(true) : Promise.reject(new Error("refused"))).then((accepted) => { changed ||= accepted; });
            pending.add(task);
            void task.catch(hooks.failed).finally(() => pending.delete(task));
        };
        return { flush, settled: () => pending.size === 0 && changed };
    }
    const slider = mount({ failed: () => { failures++; }, isFailed: () => gate[0]! < 0 });
    slider.flush(1);
    slider.flush(-1);
    setTimeout(() => {
        if (!slider.settled() || failures !== 1) throw new Error("settled " + failures);
        globalThis.close();
    }, 0);
`,
);
