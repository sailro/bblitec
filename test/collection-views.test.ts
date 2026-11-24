import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runSelfCheckingProgram } from "./self-checking-program.js";

test("a program's own object cast to ReadonlyMap keeps its getters and generator members", (t) => {
    // The view reads the live map behind it: its getter, its methods, its
    // generator members and its [Symbol.iterator] are the object's own, and
    // `forEach` hands the view itself to the callback.
    const source = `
interface Spec { s: number }
interface Fixtures { slits: ReadonlyMap<string, readonly Spec[]>; add(key: string, spec: Spec): void }
function createFixtures(): Fixtures {
    const slits = new Map<string, Spec[]>();
    const entries = function* (): IterableIterator<[string, readonly Spec[]]> {
        for (const [key, list] of slits) yield [key, Object.freeze([...list])];
    };
    const values = function* (): IterableIterator<readonly Spec[]> {
        for (const list of slits.values()) yield Object.freeze([...list]);
    };
    const view = Object.freeze({
        get size() { return slits.size; },
        get(key: string) { const list = slits.get(key); return list ? Object.freeze([...list]) : undefined; },
        has(key: string) { return slits.has(key); },
        keys() { return slits.keys(); },
        values,
        entries,
        forEach(
            callback: (value: readonly Spec[], key: string, map: ReadonlyMap<string, readonly Spec[]>) => void,
            thisArg?: unknown,
        ) {
            for (const [key, list] of entries()) callback.call(thisArg, list, key, view);
        },
        [Symbol.iterator]: entries,
    }) as ReadonlyMap<string, readonly Spec[]>;
    return {
        slits: view,
        add(key, spec) { const list = slits.get(key) ?? []; list.push(spec); slits.set(key, list); },
    };
}
function run(): void {
    const fixtures = createFixtures();
    fixtures.add("a", { s: 1 });
    fixtures.add("b", { s: 2 });
    fixtures.add("b", { s: 3 });
    const view = fixtures.slits;
    let log = \`\${view.size} \${view.get("b")?.length} \${view.has("c")} \${[...view.keys()].join(",")}\`;
    for (const [key, list] of view) log += \` \${key}:\${list.length}\`;
    for (const list of view.values()) log += \` v\${list.length}\`;
    view.forEach((list, key, map) => { log += \` f\${key}\${list.length}\${map === view}\`; });
    log += \` \${[...view].length} \${[...view.entries()].map(([k]) => k).join("")}\`;
    fixtures.add("c", { s: 4 });
    log += \` \${view.size} \${view.get("c")?.[0]?.s}\`;
    if (log !== "2 2 false a,b a:1 b:2 v1 v2 fa1true fb2true 2 ab 3 4") throw new Error(log);
}
run();
`;
    return runSelfCheckingProgram(t, "collection-view-map", source, {
        compile: { fileName: resolve("collection-view-map.ts") },
        expectedOutput: "",
    });
});

test("a program's own object annotated as ReadonlySet keeps its members", (t) => {
    const source = `
function createTags(): ReadonlySet<string> {
    const tags: string[] = ["oak", "slate"];
    const view: ReadonlySet<string> = {
        get size() { return tags.length; },
        has(tag: string) { return tags.includes(tag); },
        *values() { yield* tags; },
        *keys() { yield* tags; },
        *entries(): IterableIterator<[string, string]> { for (const tag of tags) yield [tag, tag]; },
        forEach(callback: (value: string, key: string, set: ReadonlySet<string>) => void) {
            for (const tag of tags) callback(tag, tag, view);
        },
        *[Symbol.iterator]() { yield* tags; },
    };
    tags.push("tile");
    return view;
}
function run(): void {
    const tags = createTags();
    let log = \`\${tags.size} \${tags.has("slate")} \${tags.has("reed")} \${[...tags].join(",")}\`;
    for (const tag of tags.values()) log += \` \${tag.length}\`;
    tags.forEach((tag, key, set) => { log += \` \${tag === key && set === tags}\`; });
    if (log !== "3 true false oak,slate,tile 3 5 4 true true true") throw new Error(log);
}
run();
`;
    return runSelfCheckingProgram(t, "collection-view-set", source, {
        compile: { fileName: resolve("collection-view-set.ts") },
        expectedOutput: "",
    });
});

test("an own object stored as a keyed collection refuses what it does not implement", () => {
    const make = (cast: string, members: string): string => `
function make() {
    const entries = new Map<string, number>([["a", 1]]);
    return { get(key: string) { return entries.get(key); }, get size() { return entries.size; } } as unknown as ${cast};
}
function run(): void {
    const view = make();
    ${members}
}
run();
`;
    assert.throws(
        () =>
            compileSource(
                make(
                    "ReadonlyMap<string, number>",
                    'if (view.get("a") !== 1 || view.has("a")) throw new Error("has");',
                ),
            ),
        /The program's own object stored as 'ReadonlyMap<string, number>' does not implement 'has'/,
    );
    assert.throws(
        () =>
            compileSource(
                make(
                    "ReadonlyMap<string, number>",
                    "let total = 0; for (const [, value] of view) total += value; if (total !== 1) throw new Error();",
                ),
            ),
        /is iterated through its own \[Symbol\.iterator\] member, which its record does not implement/,
    );
    assert.throws(
        () =>
            compileSource(
                make(
                    "Map<string, number>",
                    'if (view.get("a") !== 1) throw new Error("get");',
                ),
            ),
        /object stored as 'Map<string, number>' is not a native Map/,
    );
});
