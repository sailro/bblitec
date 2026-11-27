import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { check, executeGeneratedAssertions } from "./language-constructs.js";

// A subpath of the pinned package types its names from its own module:
// `WgslSource` exists only there, and an options interface the entry also
// exports stays the entry's one type.
check(
    "a-pinned-subpath-types-its-names-from-its-own-module",
    `
    import type { WgslSource } from "babylon-lite/shader/wgsl.js";
    import type { DdsEnvironmentBackgroundOptions } from "babylon-lite/material/pbr/background-dds-environment.js";
    function mark(text: string): WgslSource { return text as WgslSource; }
    const parts: WgslSource[] = [mark("fn a() {}"), mark("fn b() {}")];
    const joined: string = parts.join("|");
    if (joined !== "fn a() {}|fn b() {}" || !parts[1]!.startsWith("fn b")) throw new Error("wgsl source " + joined);
    const options: DdsEnvironmentBackgroundOptions = { skyboxUrl: "sky.dds", groundTextureUrl: "ground.png", skyboxSize: 400 };
    options.enableNoise ??= false;
    if (options.skyboxSize / 2 !== 200 || options.enableNoise || options.skyboxUrl + options.groundTextureUrl !== "sky.ddsground.png") throw new Error("options");
`,
);

test("absent typeof support preserves errors for unprovided reads and imported implementations", () => {
    assert.throws(
        () =>
            compileSource(
                "declare const OPTIONAL_BUILD: boolean; const value=OPTIONAL_BUILD;",
            ),
        /Unknown or unsupported variable/,
    );
    assert.throws(
        () =>
            compileSource(
                "declare const OPTIONAL_BUILD: {value:number}; const value=typeof OPTIONAL_BUILD.value;",
            ),
        /Unknown or unsupported variable/,
    );
    const directory = resolve("artifacts/ambient-typeof-import");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "provider.ts"),
        "export declare const supplied: number;",
    );
    assert.throws(() =>
        compileSource(
            'import {supplied} from "./provider.js"; const kind=typeof supplied;',
            { fileName: join(directory, "entry.ts") },
        ),
    );
});

test("ambient availability guards settle through imported helpers", async (t) => {
    const directory = resolve("artifacts/ambient-typeof-module");
    mkdirSync(directory, { recursive: true });
    const module = `declare const OPTIONAL_LABEL: string | undefined;
        export const label = typeof OPTIONAL_LABEL === "undefined" ? "baseline" : OPTIONAL_LABEL;
        export function describe(prefix="value"): string { return prefix+":"+label; }`;
    writeFileSync(join(directory, "feature.ts"), module);
    const javascript = ts.transpileModule(module, {
        compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.CommonJS,
        },
    }).outputText;
    assert.equal(
        runInNewContext(
            "const exports={};" + javascript + ";exports.describe()",
        ),
        "value:baseline",
    );
    const result = compileSource(
        'import {describe,label} from "./feature.js"; if(describe()!=="value:baseline" || label!=="baseline") throw new Error("module fallback");',
        { fileName: join(directory, "entry.ts") },
    );
    await executeGeneratedAssertions(t, "ambient-typeof-module", result.cpp);
});

test("a loop over another module's constant set ranges over the set it constructs", async (t) => {
    const cpp = compileModules(
        resolve("artifacts/imported-constant-set"),
        [
            [
                "kinds",
                `export type Kind = "alpha" | "extra" | "beta" | "gamma" | "delta";
                export const FLAGGED: ReadonlySet<Kind> = new Set<Kind>(["alpha", "extra", "beta", "gamma"]);
                export function policy(kind: Kind): string { return FLAGGED.has(kind) ? "fresh" : "durable"; }`,
            ],
        ],
        `import { FLAGGED, policy } from "./kinds.js";
        (() => { if (policy("delta") !== "durable" || !FLAGGED.has("alpha")) throw new Error("has"); })();
        (() => {
            let fresh = "";
            for (const kind of FLAGGED) if (policy(kind) === "fresh") fresh += kind[0];
            if (fresh !== "aebg") throw new Error("fresh " + fresh);
        })();`,
    );
    await executeGeneratedAssertions(t, "imported-constant-set", cpp);
});

check(
    "an interface a class's this and a module literal both produce is the instance or the literal",
    `
    interface View { count: number; radius: number[] }
    interface Envelope {
        readonly compact: boolean;
        preferredDistance(view: View, a: number, b: number): number;
        permitsApproach(view: View, walker: number, other: number): boolean;
    }
    class Contacts {
        private compactCount = 0;
        private readonly members: number[] = [];
        constructor(private readonly view: View) {}
        get compact(): boolean { return this.compactCount > 0; }
        add(slot: number): void { this.compactCount++; this.members[slot] = 1; }
        preferredDistance(view: View, a: number, b: number): number { return view.radius[a]! + view.radius[b]! + this.view.count; }
        permitsApproach(_view: View, walker: number, other: number): boolean { return this.members[walker]! > 0 && other >= 0; }
        envelope(slot?: number): Envelope {
            return this.compactCount > 0 && (slot === undefined || this.members[slot]! > 0) ? this : normalEnvelope;
        }
    }
    const normalEnvelope: Envelope = {
        compact: false,
        preferredDistance: (view, a, b) => view.radius[a]! + view.radius[b]!,
        permitsApproach: () => false,
    };
    const contacts = new WeakMap<View, Contacts>();
    function envelopeOf(view: View, slot?: number): Envelope {
        return contacts.get(view)?.envelope(slot) ?? normalEnvelope;
    }
    const view: View = { count: 2, radius: [0.5, 0.25] };
    let text = "";
    const first = envelopeOf(view, 0);
    text += String(first.compact) + first.preferredDistance(view, 0, 1) + first.permitsApproach(view, 0, 1);
    const created = new Contacts(view);
    contacts.set(view, created);
    created.add(0);
    const second = envelopeOf(view, 0);
    text += "," + String(second.compact) + second.preferredDistance(view, 0, 1) + second.permitsApproach(view, 0, 1);
    text += "," + String(envelopeOf(view, 1) === normalEnvelope) + String(second === created) + String(envelopeOf(view) === second);
    if (text !== "false0.75false,true2.75true,truetruetrue") throw new Error(text);
    `,
);

check(
    "module-state",
    `
    const items: number[] = [];
    const stats = { hits: 0, nested: { depth: 1 } };
    const cache = new Map<string, number>();
    const listeners: Array<() => void> = [];
    const api = { base: 10, get() { return this.base + items.length; } };
    function add(n: number): void { items.push(n); stats.hits += 1; stats.nested.depth += n; }
    function memo(key: string): number { let v = cache.get(key); if (v === undefined) { v = key.length; cache.set(key, v); } return v; }
    function on(l: () => void): () => void { listeners.push(l); return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; }
    function emit(): void { for (const l of listeners) l(); }
    add(1);
    add(2);
    let fired = 0;
    const off = on(() => { fired += 1; });
    emit();
    off();
    emit();
    if (items.length !== 2 || stats.hits !== 2 || stats.nested.depth !== 4) throw new Error("mutated module containers");
    if (memo("ab") + memo("ab") + cache.size !== 5 || fired !== 1) throw new Error("module cache and listeners");
    if (api.get() !== 12) throw new Error("module record method");
`,
);

check(
    "a module record returned inside a literal is written through its holder",
    `
    const table = { a: 1 };
    function leak(): { a: number } { return [table][0]!; }
    leak().a = 5;
    if (table.a !== 5) throw new Error("table " + table.a);
    `,
);

test("module namespace entries fold computed constants and re-exports", async (t) => {
    const directory = resolve("artifacts/namespace-entry-digest");
    mkdirSync(directory, { recursive: true });
    const layout = `
        export const HEADER_INTS = 6;
        export const HEADER_BYTES = HEADER_INTS * 4;
        export const STRIDE = 3;
        export const NAME = "layout";
        export function pack(value: number): number { return value * STRIDE; }`;
    const wider = `
        export * from "./layout.js";
        export const EXTRA = 7;`;
    const mutable = `
        export const STRIDE = 3;
        export let counter = 1;
        export function bump(): void { counter++; }`;
    writeFileSync(join(directory, "layout.ts"), layout);
    writeFileSync(join(directory, "wider.ts"), wider);
    writeFileSync(join(directory, "mutable.ts"), mutable);
    writeFileSync(
        join(directory, "mutable-wider.ts"),
        `export * from "./mutable.js"; export const EXTRA = 7;`,
    );
    const digest = `
        function digest(table: Readonly<Record<string, unknown>>, excluding?: Readonly<Record<string, unknown>>): string {
            return Object.entries(table)
                .filter(([name, value]) => typeof value === "number" && (!excluding || excluding[name] !== value))
                .map(([name, value]) => \`\${name}=\${value as number}\`)
                .sort()
                .join(";");
        }`;
    const entry = `
        import * as layout from "./layout.js";
        import * as wider from "./wider.js";
        ${digest}
        function parts(): string { return digest(layout) + "|" + digest(wider, layout); }
        const stored: Array<typeof parts> = [parts];
        if (stored[0]!() !== "HEADER_BYTES=24;HEADER_INTS=6;STRIDE=3|EXTRA=7") throw new Error("namespace digest " + stored[0]!());
        if (layout.HEADER_BYTES !== wider.HEADER_BYTES || layout.pack(2) !== 6) throw new Error("namespace members");`;
    const commonJs = (source: string): string =>
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.CommonJS,
            },
        }).outputText;
    const layoutExports: Record<string, unknown> = {};
    runInNewContext(commonJs(layout), { exports: layoutExports });
    const widerExports: Record<string, unknown> = {};
    runInNewContext(commonJs(wider), {
        exports: widerExports,
        require: () => layoutExports,
    });
    runInNewContext(commonJs(entry), {
        exports: {},
        require: (name: string) =>
            name === "./layout.js" ? layoutExports : widerExports,
    });
    const result = compileSource(entry, {
        fileName: join(directory, "entry.ts"),
    });
    await executeGeneratedAssertions(t, "namespace-entry-digest", result.cpp);
    // A live `let` export has no generation-time value to compare.
    assert.throws(
        () =>
            compileSource(
                `import * as base from "./mutable.js";
                import * as wider from "./mutable-wider.js";
                ${digest}
                base.bump();
                if (digest(wider, base) !== "EXTRA=7") throw new Error("digest");`,
                { fileName: join(directory, "mutable-entry.ts") },
            ),
        /Unsupported call target 'Object\.entries\(table\)\s*\.filter'/,
    );
});

test("a module namespace in a document slot is the namespace object", async (t) => {
    const directory = resolve("artifacts/namespace-document");
    const reference = join(directory, "reference");
    mkdirSync(reference, { recursive: true });
    const modules: Record<string, string> = {
        layout: `
            export const STRIDE = 3;
            export const NAME = "layout";
            export let counter = 1;
            export function bump(): void { counter++; }
            export function pack(value: number): number { return value * STRIDE; }`,
        wider: `
            export * from "./layout.js";
            export const EXTRA = 7;`,
        entry: `
            import * as layout from "./layout.js";
            import * as wider from "./wider.js";
            interface Part {
                readonly name: string;
                readonly table: Readonly<Record<string, unknown>>;
                readonly excluding?: Readonly<Record<string, unknown>>;
            }
            function digest(table: Readonly<Record<string, unknown>>, excluding?: Readonly<Record<string, unknown>>): string {
                return Object.entries(table)
                    .filter(([name, value]) => typeof value === "number" && (!excluding || excluding[name] !== value))
                    .map(([name, value]) => \`\${name}=\${value as number}\`)
                    .sort()
                    .join(";");
            }
            const parts: Part[] = [{ name: "layout", table: layout }, { name: "wider", table: wider, excluding: layout }];
            parts.push({ name: "plain", table: { Z: Date.now() > 0 ? 1 : 2, A: "a" } });
            function run(): string {
                const out: string[] = [];
                for (const part of parts) out.push(part.name + ":" + digest(part.table, part.excluding));
                return out.join("|");
            }
            if (run() !== "layout:STRIDE=3;counter=1|wider:EXTRA=7|plain:Z=1") throw new Error("digest " + run());
            layout.bump();
            if (run() !== "layout:STRIDE=3;counter=2|wider:EXTRA=7|plain:Z=1") throw new Error("live binding " + run());
            const table = parts[0]!.table;
            if (Object.keys(table).join() !== "NAME,STRIDE,bump,counter,pack") throw new Error("keys " + Object.keys(table).join());
            if (Object.keys(parts[1]!.table).join() !== "EXTRA,NAME,STRIDE,bump,counter,pack") throw new Error("re-exported keys");
            if (typeof table["pack"] !== "function" || (table as Readonly<Record<string, (value: number) => number>>).pack!(2) !== 6) throw new Error("function export");
            if (table !== parts[1]!.excluding || table === parts[1]!.table) throw new Error("identity");
            let refused = false;
            try {
                (table as Record<string, unknown>)["STRIDE"] = 4;
            } catch (error) {
                refused = error instanceof TypeError;
            }
            if (!refused || table["STRIDE"] !== 3) throw new Error("export write");`,
    };
    // The reference run is an ES module graph: its namespaces are module
    // namespace exotic objects.
    writeFileSync(join(reference, "package.json"), '{ "type": "module" }');
    for (const [name, source] of Object.entries(modules)) {
        writeFileSync(join(directory, `${name}.ts`), source);
        writeFileSync(
            join(reference, `${name}.js`),
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.ESNext,
                },
            }).outputText,
        );
    }
    await import(pathToFileURL(join(reference, "entry.js")).href);
    const result = compileSource(modules.entry!, {
        fileName: join(directory, "entry.ts"),
    });
    await executeGeneratedAssertions(t, "namespace-document", result.cpp);
});

test("imported functions read numeric tuples through nullable lanes", async (t) => {
    const directory = resolve("artifacts/tuple-nullable-lanes");
    mkdirSync(directory, { recursive: true });
    const routes = `
        export const EPSILON = 1e-4;
        export function topsMatch(a: readonly [number, number | null, number], b: readonly [number, number | null, number]): boolean {
            return Math.abs(a[0] - b[0]) <= EPSILON
                && (a[1] === null || b[1] === null ? a[1] === b[1] : Math.abs(a[1] - b[1]) <= EPSILON)
                && Math.abs(a[2] - b[2]) <= EPSILON;
        }
        export function clear(a: [number, number | null, number]): void { a[1] = null; }
        export const held: Array<readonly [number, number | null, number]> = [];
        export function keep(a: readonly [number, number | null, number]): void { held.push(a); }`;
    writeFileSync(join(directory, "routes.ts"), routes);
    const entry = `
        import { topsMatch } from "./routes.js";
        const scratch: [number, number, number] = [0, 0, 0];
        const target: [number, number, number] = [0, 0, 0];
        function pointAt(packed: Float32Array, index: number, out: [number, number, number]): void {
            out[0] = packed[index * 3]!;
            out[1] = packed[index * 3 + 1]!;
            out[2] = packed[index * 3 + 2]!;
        }
        function find(packed: Float32Array, x: number, y: number, z: number): number {
            for (let slot = 0; slot < packed.length / 3; slot++) {
                pointAt(packed, slot, scratch);
                target[0] = x;
                target[1] = y;
                target[2] = z;
                if (topsMatch(scratch, target)) return slot;
            }
            return -1;
        }
        const finders: Array<typeof find> = [find];
        const packed = new Float32Array([1, 2, 3, 4, 5, 6]);
        if (finders[0]!(packed, 4, 5, 6) !== 1 || find(packed, 1, 2, 3.5) !== -1) throw new Error("tuple tops");
        if (scratch.join() !== "4,5,6" || target[2] !== 3.5) throw new Error("scratch tuples keep their storage");
        if (!topsMatch([5, null, 7], [5, null, 7]) || topsMatch([5, null, 7], scratch)) throw new Error("null lane");`;
    const commonJs = (source: string): string =>
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.CommonJS,
            },
        }).outputText;
    const exported: Record<string, unknown> = {};
    runInNewContext(commonJs(routes), { exports: exported });
    runInNewContext(commonJs(entry), { exports: {}, require: () => exported });
    const result = compileSource(entry, {
        fileName: join(directory, "entry.ts"),
    });
    await executeGeneratedAssertions(t, "tuple-nullable-lanes", result.cpp);
    // The copy into nullable lanes is the callee's only when nothing can
    // tell it from the caller's array.
    assert.throws(
        () =>
            compileSource(
                `import { clear } from "./routes.js";
                const lanes: [number, number, number] = [1, 2, 3];
                function run(x: number): number { lanes[0] = x; clear(lanes); return lanes[1]; }
                const runs: Array<typeof run> = [run];
                if (runs[0]!(Math.random()) !== null) throw new Error("cleared");`,
                { fileName: join(directory, "writes.ts") },
            ),
        /By-reference data arguments require a matching addressable local or path/,
    );
    // A local the callee keeps holds the nullable lanes itself: one array.
    const retains = compileSource(
        `import { keep, held } from "./routes.js";
        const lanes: [number, number, number] = [1, 2, 3];
        function run(x: number): number { lanes[0] = x; keep(lanes); lanes[2] = 9; return held[0]![2]; }
        const runs: Array<typeof run> = [run];
        if (runs[0]!(Math.random()) !== 9) throw new Error("kept");`,
        { fileName: join(directory, "retains.ts") },
    );
    await executeGeneratedAssertions(
        t,
        "tuple-nullable-lanes-retained",
        retains.cpp,
    );
});

test("raw text imports read the file beside the module", () => {
    const result = compileSource(
        'import shader from "./raw-text-import.wgsl?raw";\nif (shader.length !== 27) throw new Error("raw text length");\n',
        { fileName: "test/fixtures/raw-text-import.ts" },
    );
    assert.ok(
        result.manifest.inputs.includes("test/fixtures/raw-text-import.wgsl"),
        "the text file is a recorded input",
    );
});

test("raw text imports support constant string replacement through helpers", () => {
    const result = compileSource(
        `
        import shader from "./raw-text-import.wgsl?raw";
        function replacement(): string { return "return"; }
        const expanded = shader.replace(" r ", " " + replacement() + " ").replaceAll("1.0", "2.0");
        if (!expanded.includes("return 2.0")) throw new Error("raw text expansion");
    `,
        { fileName: "test/fixtures/raw-text-import.ts" },
    );
    assert.ok(result.cpp.includes("return 2.0"));
    assert.ok(
        result.manifest.inputs.includes("test/fixtures/raw-text-import.wgsl"),
    );
});

test("a JSON import is the one object its text parses to", async (t) => {
    const result = compileSource(
        `
        import table from "./json-import.json";
        import again from "./json-import.json";
        interface Table { size: string; houses: { id: number; x: number }[]; meta: { version: number } }
        function total(input: Table): number {
            let sum = input.meta.version;
            for (const house of input.houses) sum += house.id + house.x;
            return sum;
        }
        const before = total(table);
        again.meta.version = 10;
        if (table.size !== "small" || before !== 7.5 || total(table) !== 14.5 || table !== again) throw new Error("json import");
    `,
        { fileName: "test/fixtures/json-import.ts" },
    );
    assert.ok(
        result.manifest.inputs.includes("test/fixtures/json-import.json"),
        "the JSON file is a recorded input",
    );
    await executeGeneratedAssertions(t, "json-import", result.cpp);
});

test("a JSON import no layout stores is the document it spells", async (t) => {
    // Empty arrays and elements of mixed shapes: the literal's own type has
    // no layout, so a binding that must be stored holds it as a document.
    const result = compileSource(
        `
        import save from "./json-import-document.json";
        interface Item { id: number; name?: string; tags?: string[] }
        interface Rocks { drops: number[]; removed: number[] }
        interface Save { version: number; items: Item[]; rocks: Rocks; meta: Record<string, unknown> | null }
        function total(data: Save): number {
            let sum = data.version + data.rocks.drops.length;
            for (const item of data.items) sum += item.id + (item.tags?.length ?? 0);
            return sum;
        }
        const held: Save[] = [];
        held.push(save as Save);
        held[0]!.rocks.drops.push(4);
        const sum = total(held[0]!);
        if (sum !== 8 || save.rocks.drops.length !== 1) throw new Error("json import document " + sum);
    `,
        { fileName: "test/fixtures/json-import-document.ts" },
    );
    await executeGeneratedAssertions(t, "json-import-document", result.cpp);
});

check(
    "resolved-query-values-in-native-expressions",
    `
    const qs = new URLSearchParams(location.search);
    const labTest = qs.has("labtest");
    const godMode = qs.has("godmode");
    const cleanLab = qs.has("guidedtour") || qs.has("rocktest");
    const enabled = Date.now() > 0;
    interface Save { size: number; }
    const saves: (Save | null)[] = [{ size: 3 }, null];
    const loaded = saves[enabled ? 0 : 1];
    function fits(size: number): boolean { return size === 3; }
    const sizeOk = labTest || loaded === null || fits(loaded.size);
    const content = loaded !== null && sizeOk ? loaded : null;
    if (content === null || content.size !== 3) throw new Error("mixed chain");
    const skipSplash = godMode || loaded === null;
    const persist = !labTest && !cleanLab && enabled;
    if (!skipSplash || !persist) throw new Error("folded and native operands");
    const base = enabled ? 10 : 20;
    const count = Number(qs.get("count") ?? "3") + base;
    const modeName = qs.get("mode") ?? "walk";
    const current = enabled ? "fly" : "walk";
    let matched = 0;
    if (current === modeName) matched += 1;
    if (count !== 14 || matched !== 1) throw new Error("query constants beside natives " + count + " " + matched);
    const driveName = (qs.get("drive") || "Studio").toLowerCase();
    if (driveName !== "studio" || (qs.get("mode") ?? "").length !== 3) throw new Error("query receivers " + driveName);
`,
    { search: "?godmode&count=4&mode=fly" },
);

check(
    "query-iterators-walk-the-live-list",
    `
    const params = new URLSearchParams("a=1&b=two" + (Date.now() > 0 ? "&a=3" : ""));
    const keep = new Set(["b"]);
    const parts = [...params.entries()].filter(([k]) => !keep.has(k)).map(([k, v]) => k + "=" + v);
    if (parts.join(",") !== "a=1,a=3") throw new Error("entries " + parts.join(","));
    const keys = [...params.keys()].join(",");
    const values = [...params.values()].join(",");
    if (keys !== "a,b,a" || values !== "1,two,3") throw new Error("parts " + keys + " " + values);
    let walked = "";
    for (const [k, v] of params.entries()) {
        walked += k + v;
        if (k === "a" && v === "1") params.delete("b");
    }
    if (walked !== "a1a3") throw new Error("live " + walked);
`,
);

test("a query bag the program owns changes alone: the deployment query still folds", () => {
    // A URL's own `searchParams` and a constructed URLSearchParams are not
    // the deployment query's, so mutating them leaves `?debug` folded.
    for (const mutation of [
        'const url = new URL(href); url.searchParams.delete("quality"); return url.href;',
        'const query = new URLSearchParams(href.split("?")[1] ?? ""); query.set("quality", "normal"); return query.toString();',
    ]) {
        const cpp = compileSource(
            `const params = new URLSearchParams(location.search);
            function reload(href: string): string { ${mutation} }
            const button = document.createElement("button");
            document.body.appendChild(button);
            button.addEventListener("click", () => { button.textContent = reload(location.href); });
            if (params.has("debug")) throw new Error("debug only");`,
        ).cpp;
        assert.doesNotMatch(cpp, /debug only/, mutation);
    }
});

check(
    "query-record-initializer-appends-own-properties-in-order",
    `
    const embed = Date.now() < 0;
    const settings = { view: Date.now() > 0 ? "grazing" : "front", depth: 0.06 };
    const params = new URLSearchParams({
        pom: settings.view === "grazing" ? "on" : "off",
        depth: String(settings.depth),
        view: settings.view,
        ...(embed ? { embed: "1" } : {}),
    });
    if (params.toString() !== "pom=on&depth=0.06&view=grazing") throw new Error("record " + params.toString());
    if (params.get("embed") !== null) throw new Error("absent " + params.get("embed"));
    const fixed = new URLSearchParams({ a: "1 2", b: "x&y" });
    if (fixed.toString() !== "a=1+2&b=x%26y") throw new Error("fixed " + fixed.toString());
`,
);

check(
    "query-helpers-with-parameters",
    `
    const qs = new URLSearchParams(location.search);
    const num = (k: string, d: number): number => {
        const v = qs.get(k);
        return v !== null && Number.isFinite(Number(v)) ? Number(v) : d;
    };
    function str(k: string, d: string): string {
        const v = qs.get(k);
        return v !== null && v !== "" ? v : d;
    }
    let report = "";
    function main(): void {
        const keys: string[] = ["w", "h", "mode"];
        for (const key of keys) report += num(key, -1) + ":" + str(key, "none") + ";";
        report += num("w", 4) + ":" + qs.has("wire");
    }
    main();
    const moduleKeys: string[] = ["mode", "h"];
    for (const key of moduleKeys) report += "," + (qs.get(key) ?? "-");
    if (report !== "6:6;-1:none;-1:fly;6:true,fly,-") throw new Error(report);
`,
    { search: "?w=6&wire=1&mode=fly" },
);

check(
    "class-static-block-at-module-evaluation",
    `
    let hits = 0;
    class Counter {
        static readonly base = 2;
        static { hits = 5; }
        value(): number { return hits; }
    }
    class Unused { static { hits += 1; } }
    function main(): void {
        if (new Counter().value() !== 6 || Counter.base + hits !== 8) throw new Error("static blocks " + hits);
    }
    main();
`,
);

test("imported class static fields and blocks run when their module evaluates", async (t) => {
    const directory = resolve("artifacts/class-static-state-module");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "counter.ts"),
        `export class Counter {
            static count = 0;
            static readonly step = 2;
            static { Counter.count = 10; }
            static next(): number { this.count += Counter.step; return this.count; }
        }
        let evaluated = 0;
        class Unused { static { evaluated += 1; } }
        export function peek(): number { return Counter.count + evaluated * 100; }`,
    );
    const result = compileSource(
        `import { Counter, peek } from "./counter.js";
        if (Counter.next() !== 12 || peek() !== 112) throw new Error("imported statics " + peek());`,
        { fileName: join(directory, "entry.ts") },
    );
    await executeGeneratedAssertions(
        t,
        "class-static-state-module",
        result.cpp,
    );
});

test("module const function aliases call the aliased function", async (t) => {
    const directory = resolve("artifacts/const-function-aliases");
    mkdirSync(directory, { recursive: true });
    const module = `
        function archKey(x: number, z: number): string { return Math.round(x * 10) + "," + Math.round(z * 10); }
        const f32 = Math.fround;
        const quantKey = archKey;
        const sameKey = quantKey;
        function append(log: number[]): number { log.push(log.length); return log.length; }
        const record = append;
        export function noise(x: number): number { const px = f32(x); return f32(f32(px * px) * f32(3 - f32(2 * px))); }
        export function loopKey(x: number, z: number): string { return quantKey(x, z) + "~" + sameKey(z, x); }
        export function aliasIdentity(): boolean { return quantKey === archKey && sameKey === archKey; }
        export function recordTwice(log: number[]): number { record(log); return record(log); }`;
    writeFileSync(join(directory, "aliases.ts"), module);
    const entry = `
        import { aliasIdentity, loopKey, noise, recordTwice } from "./aliases.js";
        const x = 0.3, px = Math.fround(x);
        if (noise(x) !== Math.fround(Math.fround(px * px) * Math.fround(3 - Math.fround(2 * px)))) throw new Error("Math alias");
        if (loopKey(1, 0.25) !== "10,3~3,10" || !aliasIdentity()) throw new Error("function alias");
        const log: number[] = [];
        if (recordTwice(log) !== 2 || log.join(",") !== "0,1") throw new Error("alias calls run once each");
        const stored: Array<typeof noise> = [noise];
        if (stored[0]!(x) !== noise(x)) throw new Error("stored alias caller");`;
    const commonJs = (source: string): string =>
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.CommonJS,
            },
        }).outputText;
    const exported: Record<string, unknown> = {};
    runInNewContext(commonJs(module), { exports: exported });
    runInNewContext(commonJs(entry), { exports: {}, require: () => exported });
    const result = compileSource(entry, {
        fileName: join(directory, "entry.ts"),
    });
    await executeGeneratedAssertions(t, "const-function-aliases", result.cpp);
});

test("an imported typed array answers its methods where it is read", async (t) => {
    const directory = resolve("artifacts/imported-typed-array-methods");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "matrix.ts"),
        `export const IDENTITY = new Float32Array([1, 0, 0, 1]);`,
    );
    const result = compileSource(
        `import { IDENTITY } from "./matrix.js";
        class Frame {
            point(x: number): Float32Array {
                const matrix = IDENTITY.slice(), first = IDENTITY.indexOf(1);
                matrix[1] = x + first;
                return matrix;
            }
        }
        const frames: Frame[] = [new Frame()];
        const placed = frames[0]!.point(3);
        if (placed[1] !== 3 || IDENTITY[1] !== 0 || placed === IDENTITY) throw new Error("imported typed array slice");`,
        { fileName: join(directory, "entry.ts") },
    );
    await executeGeneratedAssertions(
        t,
        "imported-typed-array-methods",
        result.cpp,
    );
});

// A string an imported module binding holds from generation reaches a
// string sink, here a nullish fallback's.
test("an imported generation-time string feeds a string sink", async (t) => {
    const directory = resolve("artifacts/imported-generation-string");
    mkdirSync(directory, { recursive: true });
    const module = `export const GENERATIONS = ["legacy", "new"] as const;
        export type Generation = typeof GENERATIONS[number];
        export function forSearch(search: string): Generation { return new URLSearchParams(search).get("v") === "new" ? "new" : "legacy"; }
        export const ACTIVE = forSearch(typeof location === "undefined" ? "" : location.search);`;
    writeFileSync(join(directory, "generation.ts"), module);
    const entry = `import { ACTIVE, type Generation } from "./generation.js";
        interface Deps { modelGeneration?: Generation; count: number }
        function spawn(deps: Deps): string { const generation = deps.modelGeneration ?? ACTIVE; return generation + deps.count; }
        const spawners: Array<typeof spawn> = [spawn];
        if (spawners[0]!({ count: 1 }) !== "legacy1" || spawners[0]!({ count: 2, modelGeneration: "new" }) !== "new2") throw new Error("generation");`;
    const commonJs = (source: string): string =>
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.CommonJS,
            },
        }).outputText;
    runInNewContext(
        "const exports = {};" +
            commonJs(module) +
            ";const required = exports; (function (exports, require) {" +
            commonJs(entry) +
            "})({}, () => required);",
        { URLSearchParams },
    );
    const result = compileSource(entry, {
        fileName: join(directory, "entry.ts"),
    });
    await executeGeneratedAssertions(
        t,
        "imported-generation-string",
        result.cpp,
    );
});

/**
 * Writes project modules beside an entry, runs them as CommonJS in Node (in
 * the order given, each resolving the earlier ones by name) and returns the
 * entry's compiled C++.
 */
function compileModules(
    directory: string,
    modules: ReadonlyArray<readonly [string, string]>,
    entry: string,
): string {
    mkdirSync(directory, { recursive: true });
    const loaded = new Map<string, Record<string, unknown>>();
    const run = (source: string): Record<string, unknown> => {
        const exports: Record<string, unknown> = {};
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.CommonJS,
                },
            }).outputText,
            {
                exports,
                require: (specifier: string) => {
                    const required = loaded.get(specifier.slice(2, -3));
                    if (!required) throw new Error(`unresolved ${specifier}`);
                    return required;
                },
            },
        );
        return exports;
    };
    for (const [name, source] of modules) {
        writeFileSync(join(directory, `${name}.ts`), source);
        loaded.set(name, run(source));
    }
    run(entry);
    return compileSource(entry, { fileName: join(directory, "entry.ts") }).cpp;
}

test("imported module records run their members on the one object their module creates", async (t) => {
    const cpp = compileModules(
        resolve("artifacts/imported-module-records"),
        [
            [
                "records",
                `function plus(a: number, b: number): number { return a + b; }
                export const ops = { plus };
                export const capability = {
                    issue(): number { return 1; },
                    value(token: number): string { return String(token); },
                };
                export const counter = {
                    count: 0,
                    bump(): number { this.count += 1; return this.count; },
                    read(): number { return this.count; },
                };
                let evaluations = 0;
                const sequence = (() => {
                    evaluations += 1;
                    let next = 0;
                    const issue = (): number => ++next;
                    const peek = (): number => next;
                    return { issue, peek } as const;
                })();
                export function bumpTwice(): number { counter.bump(); return counter.bump(); }
                export function allocate(): number { return sequence.issue() * 10 + sequence.peek(); }
                export function evaluated(): number { return evaluations; }
                export function sum(a: number): number { return ops.plus(a, 1); }`,
            ],
        ],
        `import { allocate, bumpTwice, capability, counter, evaluated, sum } from "./records.js";
        const key = capability.issue();
        const text = capability.value(key);
        if (key !== 1 || text !== "1") throw new Error("method record");
        if (bumpTwice() !== 2 || counter.read() !== 2 || counter.count !== 2) throw new Error("this record");
        const alias = counter;
        alias.bump();
        if (counter.count !== 3 || alias !== counter) throw new Error("one record");
        const allocators: Array<typeof allocate> = [allocate];
        if (allocators[0]!() !== 11 || allocate() !== 22 || evaluated() !== 1) throw new Error("module closure state");
        if (sum(2) !== 3) throw new Error("function shorthand");`,
    );
    await executeGeneratedAssertions(t, "imported-module-records", cpp);
});

test("an imported generic alias omitting its defaulted argument is one record type with its complete instantiation", async (t) => {
    const cpp = compileModules(
        resolve("artifacts/imported-alias-default-argument"),
        [
            [
                "sources",
                `export interface Texture { width: number }
                export type Source<T extends Texture | null = Texture> = (() => T) & {
                    onResize?: (callback: () => void) => () => void;
                };
                export const listeners: Array<() => void> = [];
                export function make(texture: Texture): Source {
                    return Object.assign(() => texture, {
                        onResize: (callback: () => void) => { listeners.push(callback); return () => {}; },
                    });
                }
                export type Tagged<K extends string, T extends Texture | null = Texture> = (() => T) & { key?: K };
                export function tag(texture: Texture): Tagged<"a"> {
                    return Object.assign(() => texture, { key: "a" as const });
                }`,
            ],
        ],
        `import { listeners, make, tag, type Source, type Tagged, type Texture } from "./sources.js";
        const tagged: Tagged<"a">[] = [tag({ width: 1 })];
        const complete: Tagged<"a", Texture>[] = tagged;
        complete.push(tag({ width: 2 }));
        if (tagged.length !== 2 || tagged[1] !== complete[1] || tagged[1]!.key !== "a" || tagged[1]!().width !== 2)
            throw new Error("spelled argument");
        interface Holder { readonly live: Source; readonly enabled: boolean }
        const made: Source[] = [];
        function build(texture: Texture, enabled: boolean): Holder {
            if (!enabled) return { live: () => texture, enabled };
            const live = make(texture);
            made.push(live);
            return { live, enabled };
        }
        const texture: Texture = { width: 3 };
        const holders: Holder[] = [];
        for (const enabled of [true, false, Math.random() < 2]) holders.push(build(texture, enabled));
        let resized = 0;
        for (const holder of holders) {
            if (holder.live() !== texture) throw new Error("call");
            holder.live.onResize?.(() => { resized++; });
        }
        for (const listener of listeners) listener();
        if (resized !== 2 || made.length !== 2 || holders[0]!.live !== made[0] || holders[2]!.live !== made[1])
            throw new Error("one record");
        const replaced = (callback: () => void) => { callback(); return () => {}; };
        holders[0]!.live.onResize = replaced;
        if (made[0]!.onResize !== replaced || holders[2]!.live.onResize === replaced) throw new Error("one slot");`,
    );
    await executeGeneratedAssertions(t, "imported-alias-default-argument", cpp);
});

test("imported capability records issue class instances behind empty-object tokens", async (t) => {
    const cpp = compileModules(
        resolve("artifacts/imported-capability-records"),
        [
            ["order", `export const log: string[] = [];`],
            [
                "capability",
                `import { log } from "./order.js";
                declare const keyBrand: unique symbol;
                export type Key = Readonly<{ readonly [keyBrand]: true }>;
                const capability = (() => {
                    const constructorToken = {};
                    let issue!: (value: number) => Key;
                    let value!: (id: Key) => number;
                    log.push("capability");
                    class Capability {
                        readonly #value: number;
                        constructor(token: object, durableValue: number) {
                            if (token !== constructorToken) throw new TypeError("requires its private constructor token");
                            this.#value = durableValue;
                            Object.freeze(this);
                        }
                        static {
                            issue = (durableValue) => new Capability(constructorToken, durableValue) as unknown as Key;
                            value = (id) => (id as unknown as Capability).#value;
                        }
                    }
                    void Capability;
                    return { issue, value } as const;
                })();
                log.push("after");
                declare const labelBrand: unique symbol;
                export type Label = Readonly<{ readonly [labelBrand]: true }>;
                const labels = (() => {
                    const labelToken = {};
                    let issue!: () => Label;
                    let update!: (key: Label, text: string) => void;
                    let signature!: (key: Label, suffix: string) => string;
                    class LabelCapability {
                        #text = "";
                        constructor(token: object) {
                            if (token !== labelToken) throw new TypeError("requires its private constructor token");
                        }
                        static {
                            issue = () => new LabelCapability(labelToken) as unknown as Label;
                            update = (key, text) => { (key as unknown as LabelCapability).#text = text; };
                            signature = (key, suffix) => \`rb\${(key as unknown as LabelCapability).#text}:\${suffix}\`;
                        }
                    }
                    void LabelCapability;
                    return { issue, update, signature } as const;
                })();
                export function keyOf(value: unknown): number | null {
                    if ((typeof value !== "object" && typeof value !== "function") || value === null) return null;
                    try {
                        const key = capability.value(value as Key);
                        return Number.isSafeInteger(key) && key > 0 ? key : null;
                    } catch {
                        return null;
                    }
                }
                export function allocate(next: number): { id: Key; nextId: number } {
                    return { id: capability.issue(next), nextId: next + 1 };
                }
                export function labelKey(text: string, reuse?: Label): Label {
                    const key = reuse ?? labels.issue();
                    labels.update(key, text);
                    return key;
                }
                export function labelSignature(key: Label, suffix: string): string {
                    return labels.signature(key, suffix);
                }`,
            ],
        ],
        `import { log } from "./order.js";
        import { allocate, keyOf, labelKey, labelSignature } from "./capability.js";
        const keys: Array<(value: unknown) => number | null> = [keyOf];
        const first = allocate(4);
        const second = allocate(first.nextId);
        if (keys[0]!(first.id) !== 4 || keys[0]!(second.id) !== 5) throw new Error("live keys");
        if (first.id === second.id || keys[0]!(first.id) !== keyOf(first.id)) throw new Error("distinct identities");
        if (keys[0]!({}) !== null || keys[0]!(3) !== null || keys[0]!(null) !== null) throw new Error("foreign values");
        const label = labelKey("a");
        const reused = labelKey("b", label);
        if (reused !== label || labelSignature(label, "x") !== "rbb:x") throw new Error("label");
        const other = labelKey("c");
        if (other === label || labelSignature(other, "y") !== "rbc:y") throw new Error("fresh label");
        if (log.join(",") !== "capability,after") throw new Error("module order " + log.join(","));`,
    );
    await executeGeneratedAssertions(t, "imported-capability-records", cpp);
});

test("imported module records reached through holders and element reads are one object", async (t) => {
    const cpp = compileModules(
        resolve("artifacts/imported-module-record-receivers"),
        [
            [
                "records",
                `export const sequence = (() => {
                    let next = 0;
                    const issue = (): number => ++next;
                    const peek = (): number => next;
                    return { issue, peek } as const;
                })();
                export const counter = {
                    count: 0,
                    bump(): number { this.count += 1; return this.count; },
                };`,
            ],
        ],
        `import { counter, sequence } from "./records.js";
        const issue = sequence["issue"];
        if (issue() !== 1 || sequence["peek"]() !== 1) throw new Error("element reads");
        const holders = [sequence];
        if (holders[0]!.issue() !== 2 || [sequence].map((s) => s.peek())[0] !== 2) throw new Error("holders");
        const counters = [counter];
        counters[0]!.bump();
        if (counter.count !== 1 || counters[0] !== counter) throw new Error("home object through a holder");`,
    );
    await executeGeneratedAssertions(
        t,
        "imported-module-record-receivers",
        cpp,
    );
});

test("imported containers written through a destructured or exported alias are written", async (t) => {
    const cpp = compileModules(
        resolve("artifacts/imported-container-aliases"),
        [
            [
                "state",
                `export const state = { list: [] as string[] };
                export const table = { xs: [1] };
                export const xs = table.xs;`,
            ],
        ],
        `import { state, table, xs } from "./state.js";
        const { list } = state;
        list.push("x");
        xs.push(2);
        if (state.list.length !== 1 || table.xs.length !== 2) throw new Error("aliases " + state.list.length + " " + table.xs.length);`,
    );
    await executeGeneratedAssertions(t, "imported-container-aliases", cpp);
});

// A module container a function keeps is written through its new holder;
// one a function only reads stays a constant.
check(
    "module-containers-kept-by-a-function-are-written-through-the-holder",
    `
    const ITEMS: number[] = [1, 2];
    const CONFIG = { size: 1 };
    const CODES = new Set(["a", "b"]);
    const holder: { list: number[] } = { list: [] };
    const slots: { size: number }[] = [];
    function keep(list: number[]): void { holder.list = list; }
    function register(config: { size: number }): void { slots.push(config); }
    function anyIn(codes: Set<string>, key: string): boolean {
        for (const code of codes) if (code === key) return true;
        return false;
    }
    keep(ITEMS);
    holder.list.push(3);
    register(CONFIG);
    slots[0]!.size = 7;
    if (ITEMS.length !== 3 || CONFIG.size !== 7) throw new Error("kept " + ITEMS.length + " " + CONFIG.size);
    if (!anyIn(CODES, "b") || anyIn(CODES, "z")) throw new Error("read-only set");
`,
);

test("module records and tokens refuse what one object cannot represent", () => {
    const directory = resolve("artifacts/imported-module-record-refusals");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "counter.ts"),
        `export const counter = { count: 0, bump(): number { this.count += 1; return this.count; } };
        export function detached(): () => number { const bump = counter.bump; return bump; }`,
    );
    assert.throws(
        () =>
            compileSource(
                `import { counter, detached } from "./counter.js";
                counter.bump();
                const f = detached();`,
                { fileName: join(directory, "entry.ts") },
            ),
        /Method 'bump' reads `this`, and counter\.ts:2 reads its function value, which could call it with another receiver\./,
    );
    assert.throws(
        () =>
            compileSource(
                `const pairs = [{ side: 1 }, { side: 1 }];
                if (pairs[0] === pairs[1]) throw new Error("distinct");`,
            ),
        /Comparison requires represented operands, received record and record\./,
    );
    // Empty object tokens compare by being one object: two literals never are.
    assert.doesNotMatch(
        compileSource(
            `const pairs = [{}, {}];
            if (pairs[0] === pairs[1]) throw new Error("distinct");`,
        ).cpp,
        /distinct/,
    );
    assert.throws(
        () =>
            compileSource(
                `const holder = { inner: { count: 0, bump(): number { this.count += 1; return this.count; } } };
                if (holder.inner.bump() !== 1) throw new Error("bump");`,
            ),
        /A write through `this` needs the object its literal creates stored where a binding names it\./,
    );
});

check(
    "a write through a destructured member reaches a module constant",
    `
    const CONFIG = { inner: { v: 1 }, list: [{ v: 1 }] };
    const { inner } = CONFIG;
    inner.v = 2;
    const [first] = CONFIG.list;
    first!.v = 3;
    if (CONFIG.inner.v !== 2 || CONFIG.list[0]!.v !== 3)
        throw new Error("module const alias");
    `,
);

check(
    "a-module-const-snapshots-the-let-it-reads",
    `
    let committed = 0;
    const previous = committed;
    const read = (): number => previous;
    const bump = (): void => { committed = 7; };
    const later: Array<() => number> = [read, () => committed];
    bump();
    if (previous !== 0 || later[0]!() !== 0 || later[1]!() !== 7) throw new Error("snapshot");
`,
);

check(
    "a module Map written through a reassigned alias or a returning helper",
    `
    function entries(): [string, number][] { return [["a", 1], ["b", 1]]; }
    const M = new Map(entries());
    let view = new Map<string, number>();
    view = M;
    view.set("a", 2);
    function registry(): Map<string, number> { return M; }
    registry().set("b", 3);
    if (M.get("a") !== 2 || M.get("b") !== 3) throw new Error("map aliases " + M.get("a") + " " + M.get("b"));
    `,
);
