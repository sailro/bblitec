import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { check } from "./language-constructs.js";

check(
    "split-evaluates-its-separator-once-and-keeps-a-limit",
    `
    const log: string[] = [];
    const sep = () => { log.push("sep"); return ","; };
    const lim = () => { log.push("lim"); return Math.random() < 2 ? 2 : 1; };
    const s = Math.random() < 2 ? "a,b,c" : "";
    const out = s.split(sep(), lim());
    if (out.join("|") !== "a|b" || log.join() !== "sep,lim") throw new Error("split " + out.join("|") + " " + log.join());
    if (s.split(",", 0).length !== 0 || s.split(",").length !== 3) throw new Error("split limits");
`,
);

check(
    "switch-on-temporary-string",
    `
    function classify(prefix: string, tail: string): number {
        switch (prefix + tail) {
            case "ab": return 1;
            case "abc": return 2;
            default: return 0;
        }
    }
    let total = 0;
    for (const tail of ["b", "bc", "x"]) total = total * 10 + classify("a", tail);
    if (total !== 120) throw new Error("switch on a concatenation " + total);
`,
);

check(
    "string-collection-foreach",
    `
    const names = new Set<string>(["alpha", "beta"]);
    const seen: string[] = [];
    names.forEach(name => {
        seen.push(name);
        if (name === "alpha") names.delete("beta");
    });
    if (seen.join(",") !== "alpha") throw new Error("set forEach order " + seen.join(","));
    const labels = new Map<string, string>([["a", "one"], ["b", "two"]]);
    const pairs: string[] = [];
    labels.forEach((value, key) => { pairs.push(key + "=" + value); });
    if (pairs.join(",") !== "a=one,b=two") throw new Error("map forEach " + pairs.join(","));
`,
);

check(
    "string-replacement-callbacks",
    `
    let calls = 0;
    let input = "aba";
    const result = input.replaceAll("a", (match, index: number, original: string) => {
        calls++;
        input = "changed";
        if (original !== "aba" || match !== "a") throw new Error("callback input snapshot");
        return "$&" + index;
    });
    if (result !== "$&0b$&2" || calls !== 2 || input !== "changed") throw new Error("literal callback result");
    function replace(match: string, offset: number, source: string): string {
        return match + offset + source.length;
    }
    if ("aba".replace("a", replace) !== "a03ba") throw new Error("first replacement");
    let stored: (match: string) => string = match => match.toUpperCase();
    if ("aba".replaceAll("a", stored) !== "AbA") throw new Error("stored replacement");
    calls = 0;
    const untouched = "abc".replaceAll("z", () => { calls++; return "bad"; });
    if (untouched !== "abc" || calls !== 0) throw new Error("missing match callback");
    const padded = "😀".replaceAll("", (_match, offset: number) => "[" + offset + "]");
    if (padded !== "[0]\\ud83d[1]\\ude00[2]") throw new Error("empty search UTF16 positions");
    let order = "";
    function source(): string { order += "s"; return "x"; }
    function search(): string { order += "p"; return "x"; }
    function callback(): (value: string) => string { order += "c"; return value => { order += "r"; return value; }; }
    if (source().replace(search(), callback()) !== "x" || order !== "spcr") throw new Error("replacement evaluation order");
`,
);

check(
    "known-nullish-string-conversion",
    `
    function show(value: unknown): string { return String(value); }
    const missing = undefined;
    const empty = null;
    if (typeof missing !== "undefined" || typeof empty !== "object") throw new Error("nullish typeof");
    if (show(missing) !== "undefined" || show(empty) !== "null") throw new Error("nullish String");
    if ("value=" + missing !== "value=undefined" || "value=" + empty !== "value=null") throw new Error("nullish concatenation");
    if (\`value=\${missing}\` !== "value=undefined" || \`value=\${empty}\` !== "value=null") throw new Error("nullish interpolation");
`,
);

check(
    "nullable-string-enum-assertions",
    `
    const keys = ["low", "high"] as const;
    type Key = typeof keys[number];
    function parse(raw: string | null): Key | null {
        return (keys as readonly string[]).includes(raw ?? "") ? raw as Key : null;
    }
    const inputs: Array<string | null> = ["high", null, "unknown", "low"];
    const parsed = inputs.map(parse);
    if (parsed[0] !== "high" || parsed[1] !== null || parsed[2] !== null || parsed[3] !== "low") throw new Error("nullable enum assertion");
`,
);

check(
    "string-or-function-parameter-narrowed-into-a-function-argument",
    `
    type Commit = () => void;
    interface Homes { claim(v: number, homeId: number, routeKeyOrCommit?: string | Commit, commit?: Commit): string }
    let commits = 0;
    function doClaim(v: number, homeId: number, routeKey?: string, commit?: Commit): string {
        commit?.();
        return (routeKey ?? "none") + ":" + v + ":" + homeId;
    }
    function createHomes(): Homes {
        return {
            claim: (v, homeId, routeKeyOrCommit, commit) =>
                doClaim(
                    v,
                    homeId,
                    typeof routeKeyOrCommit === "string" ? routeKeyOrCommit : undefined,
                    typeof routeKeyOrCommit === "function" ? routeKeyOrCommit : commit,
                ),
        };
    }
    const registry: Homes[] = [createHomes()];
    const homes = registry[0]!;
    const text = homes.claim(1, 2, "tab") + "|" + homes.claim(3, 4, () => { commits++; }) + "|" + homes.claim(5, 6, undefined, () => { commits += 10; }) + "|" + homes.claim(7, 8);
    if (text !== "tab:1:2|none:3:4|none:5:6|none:7:8" || commits !== 11) throw new Error(text + commits);
`,
);

check(
    "compound-union-tags",
    `
    type Key = {kind: "motion"; action: "up" | "down"} | {kind: "command"; action: "save" | "load"};
    type Result = {ok: true; value: number; displaced?: Key} | {ok: false; reason: "invalid"} | {ok: false; reason: "blocked"; key: Key};
    function result(index: number): Result {
        if (index < 0) return {ok: false, reason: "invalid"};
        if (index === 0) return {ok: false, reason: "blocked", key: {kind: "motion", action: "up"}};
        return {ok: true, value: index};
    }
    const results: Result[] = [result(-1), result(0), result(3)];
    let text = "";
    for (const entry of results) {
        if (entry.ok) text += entry.value;
        else if (entry.reason === "blocked") text += entry.key.action;
        else text += entry.reason;
    }
    if (text !== "invalidup3") throw new Error("compound tag narrowing");
`,
);

check(
    "contextual-string-array-results",
    `
    interface Definition { name: "first" | "second" | null; }
    interface Group { names: readonly string[]; }
    const definitions: Definition[] = [{name:"first"}, {name:null}, {name:"second"}];
    const names: readonly string[] = definitions.map(value => value.name).filter((name): name is NonNullable<typeof name> => name !== null);
    const groups: Group[] = [{names}];
    const alias = names as string[];
    alias.push("extra");
    if (groups[0]!.names.join(",") !== "first,second,extra") throw new Error("contextual filter identity");
    const mapped: string[] = definitions.filter(value => value.name !== null).map(value => value.name!);
    mapped.push("extra");
    if (mapped.join(",") !== "first,second,extra") throw new Error("contextual map");
`,
);

check(
    "indexed-and-union-string-parts",
    `
    function token(text: string): string { let i = 0, value = ""; while (i < text.length) value += text[i++]; return value; }
    if (token("text") !== "text") throw new Error("indexed concat");
    let index = 0;
    const text = "x" + ""[index++];
    if (text !== "xundefined" || index !== 1) throw new Error("missing character once");
    interface Label { text: (value: string | number) => string; }
    const label: Label = {text: value => \`value:\${value}\`};
    if (label.text(3) !== "value:3" || label.text("name") !== "value:name") throw new Error("union template");
`,
);

check(
    "logical-string-selection",
    `
    let effects = 0;
    function read(value: string): string { effects++; return value; }
    function fallback(): string { effects += 10; return "fallback"; }
    interface Selector { choose: (value: string | null) => string; }
    const selector: Selector = {choose: value => value || fallback()};
    if ((read("kept") || fallback()) !== "kept" || effects !== 1) throw new Error("lazy OR");
    if ((read("") || fallback()) !== "fallback" || effects !== 12) throw new Error("fallback OR");
    if ((read("") && fallback()) !== "" || effects !== 13) throw new Error("lazy AND");
    if ((read("kept") && fallback()) !== "fallback" || effects !== 24) throw new Error("selected AND");
    if (selector.choose(null) !== "fallback" || effects !== 34) throw new Error("nullable OR");
    if (selector.choose("present") !== "present" || effects !== 34) throw new Error("present OR");
`,
);

check(
    "string-indexing",
    `
    function at(value: string, index: number): string | undefined { return value[index]; }
    const text = "Aé😀Z";
    if (at(text, 0) !== "A" || at(text, 1) !== "é" || at(text, 4) !== "Z") throw new Error("code unit indexing");
    if (at(text, 2) !== String.fromCharCode(0xd83d) || at(text, 3) !== String.fromCharCode(0xde00)) throw new Error("surrogate indexing");
    if (at(text, -1) !== undefined || at(text, 5) !== undefined || at(text, 1.5) !== undefined || at(text, NaN) !== undefined) throw new Error("absent string property");
    let source = "ab";
    function change(): number { source = "cd"; return 1; }
    const selected = source[change()];
    if (selected !== "b") throw new Error("string receiver snapshot");
    const axes = [[0, 1, 2], [1, 0, 2], [2, 1, 0]] as const;
    const names = axes.map(row => row.map(index => "xyz"[index]).join(""));
    if (names.join(",") !== "xyz,yxz,zyx") throw new Error("static string projection");
`,
);

check(
    "string-indexing-parameter-lifetime",
    `
    function scan(text: string): number {
        let sum = 0;
        const n = text.length;
        for (let i = 0; i < n;) sum += text[i++]!.charCodeAt(0);
        for (let i = n - 1; i >= 0; i--) sum -= text.charCodeAt(i);
        if (text[n] !== undefined || text[-1] !== undefined || text[0.5] !== undefined ||
            !Number.isNaN(text.charCodeAt(Infinity))) throw new Error("indexed bounds");
        return sum;
    }
    if (scan("aé😀Z".repeat(20000)) !== 0 || scan("different") !== 0 || scan("") !== 0)
        throw new Error("repeated string traversal");
    function replace(text: string): string {
        const first = text[0];
        function change(): number { text = "cd"; return 1; }
        const selected = text[change()];
        return first + selected + text[0];
    }
    const runtimeText = "ab".repeat(Math.trunc(Math.random()) + 1);
    if (replace(runtimeText) !== "abc") throw new Error("mutable parameter snapshot");
    function retained(text: string): () => string | undefined {
        const first = text[0];
        return () => first + text[1];
    }
    const first = retained("ab"), second = retained("cd");
    if (first() !== "ab" || second() !== "cd") throw new Error("retained string capture");
`,
);

check(
    "regexp-unicode-flag-matches-code-points",
    String.raw`
    function stripMarks(value: string): string { return value.replace(/\p{Diacritic}/gu, "").toLowerCase().trim(); }
    if (stripMarks("Élodie Brontë ") !== "elodie bronte") throw new Error("diacritics");
    const s = ["abc", "a\u{1F600}b", "x\ud800y", "😀"];
    const astral = s[1]!;
    if (!/^a/u.test(s[0]!) || astral.match(/./gu)!.length !== 3 || astral.match(/./g)!.length !== 4) throw new Error("dot");
    if (!/^a.b$/u.test(astral) || /^a.b$/.test(astral)) throw new Error("dot anchors");
    if (astral.replace(/(?:)/gu, "-") !== "-a-\u{1F600}-b-") throw new Error("empty matches advance by code point");
    const parts = s[3]!.split(/(?:)/u);
    if (parts.length !== 1 || parts[0] !== "\u{1F600}" || "a,b".split(/,/u).join("|") !== "a|b" || "".split(/x/u).length !== 1) throw new Error("split");
    if (/\ude00/u.test(s[3]!) || !/😀/u.test(s[3]!) || !/^[\u{1F600}-\u{1F64F}]$/u.test(s[3]!)) throw new Error("surrogates");
    if (!/^x[\ud800-\udbff]y$/u.test(s[2]!) || !/^x.y$/u.test(s[2]!) || /^x𐀀/u.test("x\ud800")) throw new Error("lone lead");
    if (/[^a]/u.exec(s[3]!)![0] !== "\u{1F600}" || !/^\S$/u.test(s[3]!)) throw new Error("negated sets");
    if (!/ſ/iu.test("s") || /ſ/i.test("s") || !/[a-z]/iu.test("K") || !/^K$/iu.test("k")) throw new Error("case folding");
    if (!/^\p{Lu}+$/u.test("ÀB") || /^\P{L}$/u.test("é") || !/^\p{Script=Greek}$/u.test("α")) throw new Error("properties");
    const re = /./gu;
    re.lastIndex = 1;
    const found = re.exec("\u{1F600}\u{1F600}");
    if (!found || found[0] !== "\u{1F600}" || re.lastIndex !== 2) throw new Error("lastIndex inside a pair");
    if ("a1b22".replace(/(\d)(\d)?/gu, "[$1|$2|$&|$$|$01|$3]") !== "a[1||1|$|1|$3]b[2|2|22|$|2|$3]") throw new Error("substitution");
    if ("x\u{1F600}y".replace(/\u{1F600}/u, "$` +
        "`" +
        String.raw`$'") !== "xxyy") throw new Error("context substitution");
    const words = [..."é a\u{1F600}b".matchAll(/\w+/gu)].map((m) => m[0]);
    if (words.join(",") !== "a,b" || !/\bx/u.test("éx") || /\bé/u.test(" é")) throw new Error("words");
    const dynamic = new RegExp("^\\p{N}+$", "u");
    if (!dynamic.test("٣" + "3") || dynamic.test("x")) throw new Error("constructor");
    let count = 0;
    const replaced = "a\u{1F600}".replace(/(.)/gu, (match, char: string, offset: number) => { count++; return char + offset; });
    if (replaced !== "a0\u{1F600}1" || count !== 2) throw new Error("callback offsets");
`,
);

test("u-flag RegExp forms the runtime engine cannot express refuse", () => {
    for (const [source, message] of [
        [
            String.raw`const t = ["a"]; const r = /(?<=a)b/u.test(t[0]!);`,
            /Lookbehind assertions are not lowered/,
        ],
        [
            String.raw`const t = ["a"]; const r = /(?<x>a)/u.test(t[0]!);`,
            /Named groups are not lowered/,
        ],
        [
            String.raw`const t = ["aa"]; const r = /(a)\1/iu.test(t[0]!);`,
            /A backreference under the i and u flags/,
        ],
        [
            String.raw`const t = ["a"]; const r = /\ba/iu.test(t[0]!);`,
            /A word boundary under the i and u flags/,
        ],
        [
            String.raw`const p = ["a"]; const r = new RegExp(p[0]!, "u");`,
            /A u-flag RegExp constructor needs a pattern known at generation/,
        ],
        [
            String.raw`const t = ["a"]; const r = /a/y.test(t[0]!);`,
            /support the g, i and u flags, not 'y'/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

check(
    "pushed-string-lists",
    `
    // Lists of strings a function pushes onto, read and iterated as they hold.
    function attributes(normals: boolean, uvs: boolean): string[] {
        const list = normals ? ["position", "normal"] : ["position"];
        if (uvs) list.push("uv");
        let joined = "";
        for (const name of list) joined += name[0];
        list.push(joined);
        return list;
    }
    const a = attributes(true, true);
    const b = attributes(false, Math.random() < 2);
    const c = attributes(Math.random() > 2, false);
    if (a.join() !== "position,normal,uv,pnu" || b.join() !== "position,uv,pu" || c.join() !== "position,p") throw new Error(a.join() + " " + b.join() + " " + c.join());
    const written = ["x", "y"];
    written.push("z");
    written[1] = Math.random() > 2 ? "q" : "w";
    let spelled = "";
    for (const name of written) spelled += name;
    if (spelled !== "xwz" || written.length !== 3) throw new Error(spelled);
    // A push through an alias, a callee or a callback is the list's too.
    function aliased(extra: boolean): string {
        const list = extra ? ["a", "b"] : ["a"];
        const alias = list;
        alias.push("c");
        const add = (name: string): void => { list.push(name); };
        add("d");
        grow(list);
        let joined = "";
        for (const name of list) joined += name;
        return joined + list.length;
    }
    function grow(list: string[]): void { list.push("e"); }
    const viaAlias = aliased(true) + aliased(Math.random() > 2);
    if (viaAlias !== "abcde5acde4") throw new Error(viaAlias);
`,
);

check(
    "narrower-string-union-callback-slot",
    `
    type BuildingKind = "house" | "tower" | "mill" | "well";
    type RecipeKind = "house" | "tower";
    interface Guidance { openBuilding(kind: BuildingKind): void }
    interface Ring { openRecipeGuide?: (recipe: RecipeKind) => void; label?: (text: string) => void }
    let opened = "";
    const guidance: Guidance = { openBuilding: (kind) => { opened += kind + ","; } };
    const name = (kind: BuildingKind): void => { opened += "[" + kind + "]"; };
    const rings: Ring[] = [];
    rings.push({ openRecipeGuide: guidance.openBuilding });
    rings.push({ openRecipeGuide: name });
    for (const ring of rings) ring.openRecipeGuide?.(rings.length > 9 ? "house" : "tower");
    if (opened !== "tower,[tower]") throw new Error("opened " + opened);
`,
);

check(
    "spread-string-literal-sets",
    `
    const labels = { first: "warm", second: "cool", duplicate: "warm" } as const;
    type Label = "start" | "warm" | "cool" | "end";
    const values: readonly Label[] = ["start", ...new Set(Object.values(labels)), "end"];
    if (values.join(",") !== "start,warm,cool,end") throw new Error("set widening and order");
    const small: ("warm" | "cool")[] = ["cool", "warm"];
    const strings: string[] = [...small];
    small[0] = "warm";
    if (strings.join(",") !== "cool,warm") throw new Error("fresh widened array");
    if (values.filter(label => label.startsWith("c")).map(label => label.toUpperCase()).join(",") !== "COOL")
        throw new Error("string methods on literal unions");
    const selected = values[2]!;
    if (selected.length !== 4 || selected[1] !== "o") throw new Error("literal union string members");
`,
);

check(
    "strings-and-numbers",
    `
    function text(s: string): string { return s.charAt(0) + s.charAt(9) + s.padEnd(4, "-") + s.trimStart().trimEnd() + "|"; }
    if (text(" ab") !== " " + " ab-" + "ab|") throw new Error("string methods");
    function spell(n: number): string { return n.toString(16) + ":" + n.toString(2) + ":" + n.toString(); }
    if (spell(255) !== "ff:11111111:255" || (-10).toString(16) !== "-a" || (0.5).toString(2) !== "0.1") throw new Error("radix");
    function parse(s: string): number { return parseFloat(s) + Number.parseFloat(s) + parseInt(s, 10); }
    if (parse("1.5x") !== 4 || !Number.isNaN(parseFloat("x")) || parseFloat("  -2e1z") !== -20) throw new Error("parseFloat");
    if ("\\u00a0\\u3000x\\u2028\\ufeff".trim() !== "x" || parseFloat("\\u00a0\\u2029 3.5") !== 3.5) throw new Error("JavaScript white space");
    function num(s: string): number { return Number(s); }
    if (num(" \\u00a012\\u3000") !== 12 || num("\\u2028") !== 0 || num("5.") !== 5 || num("-Infinity") !== -Infinity || parseInt("\\u00a0 42px") !== 42)
        throw new Error("Number of decimal strings");
    if (num("0x1F") !== 31 || num("0o17") !== 15 || num("0B101") !== 5 || num("0x20000000000001") !== 9007199254740992)
        throw new Error("Number of radix strings");
    for (const bad of ["inf", "-0x10", "0x", "1e", "1_0", "0x1p3", "Infinityx", "."])
        if (!Number.isNaN(num(bad))) throw new Error("Number of " + bad);
    function truthy(n: number, s: string): number { return (Boolean(n) ? 1 : 0) + (Boolean(s) ? 2 : 0); }
    if (truthy(0, "x") !== 2 || truthy(3, "") !== 1) throw new Error("Boolean()");
    if (String(null) + String(undefined) !== "nullundefined") throw new Error("String of nullish");
    let a = 1;
    const comma = (a += 1, a * 10);
    if (comma !== 20 || Date.now() <= 0) throw new Error("comma and clock");
`,
);

check(
    "string-append-storage",
    `
    class Log {
        private parts: string[] = ["a", "b"];
        private text = "";
        describe(): string { return this.parts.join("/"); }
        get size(): number { return this.parts.length; }
        add(entry: string): void { this.text += entry + ";"; }
        get all(): string { return this.text; }
    }
    const log = new Log();
    let text = log.describe();
    text += "|" + log.describe() + "|" + log.size;
    text += 2;
    if (text !== "a/b|a/b|22") throw new Error(text);
    log.add("x"); log.add("y");
    if (log.all !== "x;y;") throw new Error(log.all);
    interface Entry { text: string; count: number; }
    const entries: Entry[] = [{ text: "a", count: 0 }];
    entries[0].text += "b";
    if (entries[0].text !== "ab") throw new Error(entries[0].text);
    const words: string[] = ["a", "b"];
    words[1] += "c";
    words[0] += log.size;
    if (words.join(",") !== "a2,bc") throw new Error(words.join(","));
    const emoji = "😀";
    let joined = emoji.at(0) ?? "";
    joined += emoji.at(1) ?? "";
    if (joined !== emoji || joined.codePointAt(0) !== 128512) throw new Error("surrogate append");
`,
);

check(
    "absent values spell undefined or null in text",
    `
    enum Shape {
        Box = 0,
        Ball = 1,
    }
    enum Tone {
        Soft = "soft",
    }
    interface Options {
        label?: string;
        size?: number;
        wide?: boolean;
    }
    function describe(options: Options): string {
        return options.label + ":" + options.size + ":" + options.wide;
    }
    function main(): void {
        const items: number[] = [];
        if ("last " + items.pop() !== "last undefined") throw new Error("absent number");
        items.push(4);
        if (\`value \${items.pop()}\` !== "value 4") throw new Error("present number in a template");
        const flags: boolean[] = [];
        if ("flag " + flags.shift() !== "flag undefined") throw new Error("absent boolean");
        const lookup = new Map<string, number>([["a", 1]]);
        if (\`\${lookup.get("a")}/\${lookup.get("b")}\` !== "1/undefined") throw new Error("map lookups");
        let maybe: number | null = null;
        if ("maybe " + maybe !== "maybe null") throw new Error("null number");
        maybe = 2.5;
        if ("maybe " + maybe !== "maybe 2.5") throw new Error("present nullable number");
        if (describe({}) !== "undefined:undefined:undefined") throw new Error("absent fields " + describe({}));
        if (describe({ label: "x", size: 3, wide: true }) !== "x:3:true") throw new Error("present fields");
        const shapes: Shape[] = [];
        shapes.push(Shape.Ball);
        if ("shape " + shapes.pop() + shapes.pop() !== "shape 1undefined") throw new Error("enum");
        const tones: Tone[] = [];
        tones.push(Tone.Soft);
        if ("tone " + tones.pop() + tones.pop() !== "tone softundefined") throw new Error("string enum");
        const mixed: Array<number | string> = ["a"];
        if (\`\${mixed.pop()}|\${mixed.pop()}\` !== "a|undefined") throw new Error("absent union");
        let text = "sum";
        text += items.pop();
        if (text !== "sumundefined") throw new Error("append " + text);
        if (String(items.pop()) !== "undefined") throw new Error("String of an absent value");
        const pair: [number, number?] = [1];
        if ("second " + pair[1] !== "second undefined") throw new Error("missing tuple lane");
        const omitted: Options = {};
        if (typeof omitted.size !== "undefined") throw new Error("typeof an omitted field");
    }
    main();
`,
);

check(
    "text distinguishes null and undefined in mixed primitive storage",
    `
    function main(): void {
        const values: Array<number | null | undefined> = [];
        values.push(null);
        const spelled = "value " + values[0];
        if (spelled !== "value null") throw new Error("null spelling");
        values.push(undefined, 4);
        if (String(values[1]) !== "undefined" || String(values[2]) !== "4") throw new Error("distinct spellings");
    }
    main();
`,
);

check(
    "array reads past the end spell undefined in text",
    `
    function main(): void {
        const plain: number[] = [1, 2];
        let index = 3;
        if ("x" + plain[index] !== "xundefined") throw new Error("past the end in text " + plain[index]);
        index = 1;
        if (\`v\${plain[index]}\` !== "v2") throw new Error("in range in a template");
        const words: string[] = ["a"];
        let at = 4;
        if ("w" + words[at] !== "wundefined") throw new Error("string element past the end");
        const flags: boolean[] = [true];
        if ("f" + flags[at] + flags[0] !== "fundefinedtrue") throw new Error("boolean element");
        let text = "";
        for (let i = 0; i < plain.length; i++) text += plain[i];
        if (text !== "12") throw new Error("canonical loop " + text);
        if (String(plain[index + 5]) !== "undefined") throw new Error("String() past the end");
        const held = plain[index + 9];
        plain.push(3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
        if ("h" + held !== "hundefined") throw new Error("a local keeps its missed slot " + held);
        const heldWord = words[at];
        words.push("b", "c", "d", "e");
        if ("h" + heldWord !== "hundefined") throw new Error("a string local keeps its missed slot");
        if ("h" + words[at] !== "he") throw new Error("the slot filled later");
    }
    main();
`,
);

check(
    "enum array reads past the end spell undefined in text",
    `
    enum Tone {
        Soft = 1,
        Loud = 2,
    }
    enum Name {
        A = "a",
    }
    function main(): void {
        const tones: Tone[] = [Tone.Soft, Tone.Loud];
        const names: Name[] = [Name.A];
        let at = 5;
        if ("t" + tones[at] + tones[1] !== "tundefined2") throw new Error("numeric enum element past the end");
        if (\`n\${names[at]}\${names[0]}\` !== "nundefineda") throw new Error("string enum element past the end");
        at = 0;
        if ("t" + tones[at] !== "t1") throw new Error("numeric enum element in range");
    }
    main();
`,
);

check(
    "union-tags-admitting-several-literals",
    `
    type Job = "farmer" | "potter" | "priest";
    type Requirement =
        | { id: string; kind: "default" | "field" | "pond"; satisfied: boolean }
        | { id: string; kind: "staffedAnyOf"; jobs: readonly Job[]; satisfied: boolean }
        | { id: string; kind: "mana"; satisfied: boolean; current: number; goal: number };
    function label(requirement: Requirement): string {
        if (requirement.kind === "staffedAnyOf") return "jobs:" + requirement.jobs.join("|");
        if (requirement.kind === "mana") return "mana:" + requirement.current + "/" + requirement.goal;
        return requirement.kind + (requirement.satisfied ? "+" : "-");
    }
    const requirements: Requirement[] = [
        { id: "a", kind: "field", satisfied: true },
        { id: "b", kind: "staffedAnyOf", jobs: ["farmer", "potter"], satisfied: false },
        { id: "c", kind: "mana", satisfied: false, current: 3, goal: 40 },
        { id: "d", kind: "pond", satisfied: false },
    ];
    const labels: Array<typeof label> = [label];
    const text = requirements.map(labels[0]!).join(",");
    if (text !== "field+,jobs:farmer|potter,mana:3/40,pond-") throw new Error(text);
    const pond = requirements[3]!;
    if (pond.kind === "staffedAnyOf" || pond.kind === "mana" || pond.kind !== "pond") throw new Error("tag set member");
    const alias = requirements[1]!;
    if (alias.kind === "staffedAnyOf") alias.satisfied = true;
    if (!requirements[1]!.satisfied) throw new Error("arm identity");
    function plain(kind: "default" | "field" | "pond", id: string): Requirement {
        return { id, kind, satisfied: kind !== "pond" };
    }
    const kinds: Array<"default" | "field" | "pond"> = ["pond", "default"];
    const made = kinds.map((kind, index) => plain(kind, "r" + index));
    made.push({ id: "m", kind: "mana", current: 2, goal: 4, satisfied: true });
    if (made.map(labels[0]!).join(",") !== "pond-,default+,mana:2/4") throw new Error("run-time tags");
`,
);

check(
    "union-arms-whose-tag-literals-overlap-are-told-apart-by-fields",
    `
    type Overlap = { kind: "a" | "b"; x: number } | { kind: "b" | "c"; y: string };
    const items: Overlap[] = [{ kind: "a", x: 1 }, { kind: "b", y: "z" }, { kind: "b", x: 2 }];
    const seen = items.map((item) => ("x" in item ? "x" + item.x : "y" + item.y)).join();
    if (seen !== "x1,yz,x2" || JSON.stringify(items) !== '[{"kind":"a","x":1},{"kind":"b","y":"z"},{"kind":"b","x":2}]') throw new Error(seen);
`,
);

check(
    "union-arm-own-keys-follow-tags",
    `
    type Requirement =
        | { id: string; kind: "field" | "pond"; satisfied: boolean }
        | { id: string; kind: "staffedAnyOf"; satisfied: boolean; jobs: readonly string[] }
        | { id: string; kind: "mana"; satisfied: boolean; current: number; extra?: number };
    const requirements: Requirement[] = [
        { id: "a", kind: "field", satisfied: true },
        { id: "b", kind: "staffedAnyOf", satisfied: false, jobs: ["farmer"] },
        { id: "c", kind: "mana", satisfied: false, current: 3 },
        { id: "d", kind: "mana", satisfied: false, current: 3, extra: 1 },
    ];
    const has = requirements.map((r) => ("jobs" in r ? "j" : "-") + ("current" in r ? "c" : "-") + ("extra" in r ? "e" : "-")).join(",");
    if (has !== "---,j--,-c-,-ce") throw new Error(has);
    const keys = requirements.map((r) => Object.keys(r).join("+")).join(",");
    if (keys !== "id+kind+satisfied,id+kind+satisfied+jobs,id+kind+satisfied+current,id+kind+satisfied+current+extra") throw new Error(keys);
    const json = requirements.map((r) => JSON.stringify(r)).join("");
    if (json !== '{"id":"a","kind":"field","satisfied":true}{"id":"b","kind":"staffedAnyOf","satisfied":false,"jobs":["farmer"]}{"id":"c","kind":"mana","satisfied":false,"current":3}{"id":"d","kind":"mana","satisfied":false,"current":3,"extra":1}') throw new Error(json);
    interface Circle { kind: "circle"; x: number; radius: number; grow?: number }
    interface Rect { kind: "rect"; cx: number; halfW: number; grow?: number }
    type Boundary = Circle | Rect;
    const reach = (boundary: Boundary): number => (boundary.grow ?? 0) + (boundary.kind === "circle" ? boundary.radius + boundary.x : boundary.halfW + boundary.cx);
    const pair = (a: { boundary: Boundary }, b: { boundary: Boundary }): number => reach({ ...a.boundary, grow: 0 }) + reach({ ...b.boundary, grow: 1 });
    const pairs: Array<typeof pair> = [pair];
    const hosts: Array<{ boundary: Boundary }> = [
        { boundary: { kind: "circle", x: 1, radius: 2, grow: 5 } },
        { boundary: { kind: "rect", cx: 1, halfW: 3 } },
    ];
    if (pairs[0]!(hosts[0]!, hosts[1]!) !== 8 || hosts[0]!.boundary.grow !== 5) throw new Error("spread arm override");
`,
);

check(
    "type-guard-filters-narrow-string-tags",
    `
    type Failure = "a" | "b" | "c";
    type Candidate = "a" | "b";
    const isCandidate = (f: Failure): f is Candidate => f !== "c";
    interface Facts { id: number; failures: Candidate[] }
    function facts(id: number, failures: Failure[]): Facts {
        return { id, failures: failures.filter(isCandidate) };
    }
    const roots: Array<typeof facts> = [facts];
    const made = roots[0]!(1, ["a", "c", "b"]);
    if (made.failures.join(",") !== "a,b") throw new Error("filtered tags");
    const source: Failure[] = ["c", "a"];
    const kept: Candidate[] = source.filter((f): f is Candidate => f === "a");
    source[1] = "b";
    if (kept.length !== 1 || kept[0] !== "a") throw new Error("a fresh array");
    interface Perk { jobs: readonly Failure[] }
    const WIDE: readonly Failure[] = Object.freeze(source.filter(isCandidate));
    const perk: Perk = { jobs: WIDE };
    const widen: Array<(all: Failure[]) => Failure[]> = [(all) => all.filter(isCandidate)];
    if (perk.jobs.join() !== "b" || widen[0]!(["c", "a"]).join() !== "a") throw new Error("a wider destination keeps the source tags");
`,
);

check(
    "number-to-string-checks-its-radix-first",
    `
    const rangeErrorOf = (run: () => string): string => {
        try {
            return run();
        } catch (error) {
            return error instanceof RangeError ? "RangeError" : "other";
        }
    };
    const n = Number("255");
    if (n.toString(16) !== "ff" || n.toString(Number("16.9")) !== "ff") throw new Error("radix as an integer");
    if (rangeErrorOf(() => n.toString(Number("1"))) !== "RangeError") throw new Error("radix below 2");
    if (rangeErrorOf(() => Number("x").toString(Number("37"))) !== "RangeError") throw new Error("NaN receiver");
    if (rangeErrorOf(() => n.toString(Number("y"))) !== "RangeError") throw new Error("NaN radix");
    if (rangeErrorOf(() => n.toString(Number("1e10"))) !== "RangeError") throw new Error("huge radix");
    if (Number("Infinity").toString(16) !== "Infinity") throw new Error("infinite receiver");
`,
);

check(
    "string-searches-with-utf16-positions",
    `
    const words = ["a/b/c", "\\u00e9/\\u00fc/\\u20ac", "x\\ud83d\\ude00y\\ud83d\\ude00z"];
    const s = words[0]!, u = words[1]!, e = words[2]!;
    if (s.indexOf("/", 2) !== 3 || s.indexOf("/", -5) !== 1 || s.indexOf("/", NaN) !== 1 || s.indexOf("/", Infinity) !== -1 ||
        s.indexOf("", 99) !== 5 || s.indexOf("c", 4.9) !== 4) throw new Error("indexOf position");
    if (s.lastIndexOf("/") !== 3 || s.lastIndexOf("/", 2) !== 1 || s.lastIndexOf("/", -1) !== -1 || s.lastIndexOf("a", -1) !== 0 ||
        s.lastIndexOf("/", NaN) !== 3 || s.lastIndexOf("") !== 5 || s.lastIndexOf("", 2) !== 2 || s.lastIndexOf("x") !== -1)
        throw new Error("lastIndexOf");
    if (u.indexOf("/") !== 1 || u.indexOf("\\u00fc", 1) !== 2 || u.lastIndexOf("/") !== 3 || u.indexOf("\\u20ac") !== 4 ||
        u.lastIndexOf("/", 2) !== 1) throw new Error("non-ASCII indices");
    if (e.indexOf("y") !== 3 || e.lastIndexOf("\\ud83d\\ude00") !== 4 || e.indexOf("\\ud83d\\ude00", 2) !== 4 ||
        !e.includes("z", 6) || e.includes("y", 4) || e.indexOf("\\ude00") !== 2) throw new Error("surrogate indices");
    if (!s.startsWith("b", 2) || !s.startsWith("a", -3) || s.startsWith("c", 99) || !s.startsWith("", 99) ||
        !e.startsWith("y", 3) || !u.startsWith("\\u00fc", 2) || e.startsWith("y", 2)) throw new Error("startsWith position");
    if (!s.endsWith("b", 3) || !s.endsWith("a", 1) || !s.endsWith("c", 99) || s.endsWith("a", -1) || !s.endsWith("", -1) ||
        !e.endsWith("y", 4) || !u.endsWith("\\u00e9", 1) || s.endsWith("c", NaN)) throw new Error("endsWith position");
    function find(text: string, at?: number): number { return text.indexOf("/", at); }
    function ends(text: string, end?: number): boolean { return text.endsWith("b", end); }
    function last(text: string, at?: number): number { return text.lastIndexOf("/", at); }
    function starts(text: string, at?: number): boolean { return text.startsWith("a", at); }
    if (find(s) !== 1 || find(s, 2) !== 3 || ends(s) || !ends(s, 3) || last(s) !== 3 || last(s, 0) !== -1 || !starts(s) || starts(s, 1))
        throw new Error("optional positions");
    let log = "";
    function receiver(): string { log += "r"; return "a/b"; }
    function needle(): string { log += "s"; return "/"; }
    function position(): number { log += "p"; return 0; }
    if (receiver().indexOf(needle(), position()) !== 1 || log !== "rsp") throw new Error("evaluation order " + log);
    log = "";
    if (!receiver().endsWith(needle(), position() + 2) || log !== "rsp") throw new Error("endsWith order " + log);
`,
);

check(
    "string-searches-over-wtf8-storage",
    `
    const texts = ["a\\u00e9\\u20ac\\ud83d\\ude00b\\ud83d\\ude00", "x\\ud83dy\\ude00z", "\\ud83d\\ude00", "\\ud83d", "\\ude00"];
    const t = texts[0]!, lone = texts[1]!, pair = texts[2]!, high = texts[3]!, low = texts[4]!;
    // t's UTF-16 units: a é € H L b H L.
    if (t.length !== 8 || t.indexOf("b") !== 5 || t.indexOf("\\ud83d\\ude00") !== 3 || t.indexOf("\\ud83d\\ude00", 4) !== 6 ||
        t.indexOf("\\ud83d\\ude00", 3) !== 3 || t.indexOf("", 4) !== 4 || t.indexOf("", 99) !== 8 || t.indexOf("\\u20ac", -3) !== 2 ||
        t.indexOf("b", NaN) !== 5 || t.indexOf("a", Infinity) !== -1 || t.indexOf("\\u00e9", 1.7) !== 1 || t.indexOf("\\u00e9\\u20ac") !== 1)
        throw new Error("indexOf");
    if (t.includes("b", 6) || !t.includes("\\ud83d\\ude00", 4) || t.includes("\\ud83d\\ude00", 7) || !t.includes("", 99) ||
        !t.includes("a", -Infinity) || !t.includes("\\u20ac") || t.includes("c"))
        throw new Error("includes");
    if (t.lastIndexOf("\\ud83d\\ude00") !== 6 || t.lastIndexOf("\\ud83d\\ude00", 7) !== 6 || t.lastIndexOf("\\ud83d\\ude00", 5) !== 3 ||
        t.lastIndexOf("\\ud83d\\ude00", 4) !== 3 || t.lastIndexOf("\\ud83d\\ude00", 2) !== -1 || t.lastIndexOf("", 4) !== 4 ||
        t.lastIndexOf("", 99) !== 8 || t.lastIndexOf("") !== 8 || t.lastIndexOf("b", NaN) !== 5 || t.lastIndexOf("a", -Infinity) !== 0 ||
        t.lastIndexOf("\\u20ac", 2) !== 2 || t.lastIndexOf("\\u20ac", 1) !== -1)
        throw new Error("lastIndexOf");
    if (!t.startsWith("\\ud83d\\ude00", 3) || !t.startsWith("", 4) || t.startsWith("b", 4) || !t.startsWith("\\u00e9\\u20ac", 1) ||
        !t.startsWith("a", NaN) || t.startsWith("b", Infinity) || !t.startsWith("", Infinity) || !t.startsWith("b", 5) ||
        !t.startsWith("a") || t.startsWith("\\u00e9"))
        throw new Error("startsWith");
    if (!t.endsWith("\\ud83d\\ude00") || !t.endsWith("\\u20ac", 3) || !t.endsWith("", 4) || t.endsWith("\\u20ac", 4) ||
        !t.endsWith("b", 6) || t.endsWith("a", NaN) || !t.endsWith("", NaN) || !t.endsWith("\\ud83d\\ude00", Infinity) ||
        t.endsWith("a", -1) || !t.endsWith("\\ud83d\\ude00b", 6) || t.endsWith("b"))
        throw new Error("endsWith");
    // A needle holding a lone surrogate matches one half of a pair.
    if (t.indexOf(low) !== 4 || t.lastIndexOf(high) !== 6 || t.indexOf(high, 4) !== 6 || !t.includes(low, 5) ||
        t.lastIndexOf(low, 6) !== 4 || !t.startsWith(low, 4) || !t.endsWith(high, 4) || !t.endsWith(low) || t.startsWith(high, 4) ||
        t.indexOf(low + "b") !== 4 || t.indexOf("\\u20ac" + high) !== 2 || t.lastIndexOf(low + "b", 99) !== 4)
        throw new Error("lone surrogate needles");
    // Lone surrogates in the receiver are single code units.
    if (lone.length !== 5 || lone.indexOf("y") !== 2 || lone.indexOf(high) !== 1 || lone.lastIndexOf(low + "z") !== 3 ||
        !lone.endsWith(low + "z") || !lone.startsWith(high + "y", 1) || lone.includes("\\ud83d\\ude00") || lone.indexOf("z", 3) !== 4 ||
        lone.indexOf("z", 5) !== -1 || lone.lastIndexOf("x", 1) !== 0 || !lone.includes(low, 3) || lone.includes(low, 4))
        throw new Error("lone surrogate receiver");
    if (pair.indexOf(high) !== 0 || pair.indexOf(low) !== 1 || pair.lastIndexOf(low) !== 1 || !pair.startsWith(high) ||
        !pair.endsWith(low) || pair.indexOf("", 1) !== 1 || pair.lastIndexOf("", 1) !== 1 || pair.endsWith(high) ||
        !pair.endsWith(high, 1) || pair.startsWith(low) || !pair.startsWith(low, 1) || pair.includes("x"))
        throw new Error("pair halves");
    // Concatenated halves are one pair.
    const joined = high + low;
    if (joined.length !== 2 || joined.indexOf("\\ud83d\\ude00") !== 0 || joined !== pair || !t.includes(joined, 6))
        throw new Error("joined pair");
    // A null position reads as 0; undefined reads as the method's absent position.
    const none: number | null = texts.length > 9 ? 1 : null;
    // @ts-expect-error null is outside the declared position type
    if (t.lastIndexOf("a", none) !== 0 || t.lastIndexOf("b", null) !== -1 || t.endsWith("b", none) || !t.endsWith("", none) ||
        // @ts-expect-error null is outside the declared position type
        t.indexOf("b", none) !== 5 || !t.startsWith("a", none) || !t.includes("a", null))
        throw new Error("null positions");
    function ends(text: string, end?: number): boolean { return text.endsWith("\\ud83d\\ude00", end); }
    function last(text: string, at?: number): number { return text.lastIndexOf("\\ud83d\\ude00", at); }
    function has(text: string, at?: number): boolean { return text.includes("\\ud83d\\ude00", at); }
    if (!ends(t) || ends(t, 4) || !ends(t, 5) || last(t) !== 6 || last(t, 4) !== 3 || !has(t) || has(t, 7) || !has(t, 4))
        throw new Error("optional positions");
    let log = "";
    function receiver(): string { log += "r"; return "a/b"; }
    function needle(): string { log += "s"; return "/"; }
    if (!receiver().includes(needle()) || log !== "rs") throw new Error("includes order " + log);
    log = "";
    if (receiver().lastIndexOf(needle()) !== 1 || log !== "rs") throw new Error("lastIndexOf order " + log);
`,
);

check(
    "string-from-code-point",
    `
    const codes = [65, 0x1f600, 0xd83d, 0xde00, 0xd800];
    const text = String.fromCodePoint(codes[0]!, codes[1]!, codes[2]!, codes[3]!);
    if (text !== "A\\ud83d\\ude00\\ud83d\\ude00" || text.length !== 5) throw new Error("code points");
    const lone = String.fromCodePoint(codes[4]!);
    if (lone.length !== 1 || lone.charCodeAt(0) !== 0xd800 || String.fromCodePoint() !== "") throw new Error("lone surrogate");
    const invalid = [-1, 1.5, NaN, 0x110000, Infinity];
    let refused = 0;
    for (const value of invalid) {
        try { String.fromCodePoint(value); } catch (error) { if (error instanceof RangeError) refused++; }
    }
    if (refused !== invalid.length) throw new Error("range " + refused);
`,
);

check(
    "string-search-positions-that-may-be-null-or-undefined",
    `
    function ends(text: string, end: number | null | undefined): boolean {
        // @ts-expect-error null is outside the declared position type
        return text.endsWith("b", end);
    }
    const picks = [2, 1, 0];
    const position = (pick: number): number | null | undefined => (pick === 0 ? undefined : pick === 1 ? null : 1);
    if (!ends("ab", position(picks[2]!)) || ends("ab", position(picks[1]!)) || ends("ab", position(picks[0]!)))
        throw new Error("undefined reads the end, null reads 0, a number reads itself");
`,
);

check(
    "asserted-wrappers-keep-never-calls-and-narrowed-tag-filters",
    `
    function fail(message: string): never { throw new Error(message); }
    function pick(flag: boolean): number { if (flag) return 1; return fail("no pick") as number; }
    function label(flag: boolean): string { if (flag) return "yes"; return fail("no label") satisfies never; }
    function guard(flag: boolean): void { if (!flag) fail("bad") as void; }
    let caught = "";
    try { pick(false); } catch (error) { caught += (error as Error).message; }
    try { label(false); } catch (error) { caught += "," + (error as Error).message; }
    try { guard(false); } catch (error) { caught += "," + (error as Error).message; }
    if (pick(true) !== 1 || label(true) !== "yes" || caught !== "no pick,no label,bad") throw new Error(caught);
    type Tag = "a" | "b" | "c";
    type Narrow = "a" | "b";
    function isNarrow(tag: Tag): tag is Narrow { return tag !== "c"; }
    const tags: Tag[] = ["a", "c", "b"];
    const asserted: Narrow[] = tags.filter(isNarrow) as Narrow[];
    const checked: Narrow[] = tags.filter(isNarrow) satisfies Narrow[];
    const record: { values: Narrow[] } = { values: tags.filter(isNarrow) as Narrow[] };
    function narrowed(): Narrow[] { return tags.filter(isNarrow) as Narrow[]; }
    if (asserted.join() !== "a,b" || checked.join() !== "a,b" || record.values.join() !== "a,b" || narrowed().join() !== "a,b")
        throw new Error("narrowed tag filters through assertions");
`,
);

check(
    "string-literal-union-truthiness",
    `
    type Status = "" | "earned" | "missing";
    function shown(status: Status, flags: Status[]): number {
        return flags.filter((flag) => !status || flag === status).length;
    }
    const counters: Array<typeof shown> = [shown];
    if (counters[0]!("", ["earned", "missing"]) !== 2 || counters[0]!("earned", ["earned", "missing"]) !== 1)
        throw new Error("string-literal union truthiness");
    type Mode = "on" | "off";
    function enabled(mode: Mode): boolean { return mode ? true : false; }
    const modes: Array<typeof enabled> = [enabled];
    if (!modes[0]!("off")) throw new Error("a union without an empty member is always truthy");
`,
);

check(
    "tagged-templates-and-string-raw",
    `
    function tag(strings: TemplateStringsArray, ...values: number[]): string {
        return strings.join("|") + values.join(",");
    }
    const x = [1, 2];
    if (tag\`a\${x[0]!}b\${x[1]!}c\` !== "a|b|c1,2") throw new Error("tag call");
    const order: string[] = [];
    function note(label: string, value: number): number { order.push(label); return value; }
    function pair(strings: TemplateStringsArray, first: number, second: number): number {
        order.push("call");
        return strings.length * 100 + first * 10 + second;
    }
    if (pair\`<\${note("first", 1)}|\${note("second", 2)}>\` !== 312) throw new Error("fixed parameters");
    if (order.join(",") !== "first,second,call") throw new Error("substitution order");
    const seen: TemplateStringsArray[] = [];
    function keep(strings: TemplateStringsArray): number {
        seen.push(strings);
        return strings.length;
    }
    for (let i = 0; i < 2; i++) keep\`x\${i}y\`;
    keep\`x\${0}y\`;
    if (seen[0] !== seen[1] || seen[0] === seen[2]) throw new Error("site identity");
    if (seen[0]!.raw[0] !== "x" || seen[0]!.raw !== seen[1]!.raw) throw new Error("raw identity");
    function rawTag(strings: TemplateStringsArray): string { return strings.raw.join("/") + strings.join("/"); }
    if (rawTag\`a\\n\${1}b\` !== "a\\\\n/ba\\n/b") throw new Error("raw and cooked");
    const v = String.raw\`a\\nb\${x[0]!}\`;
    if (v.length !== 5 || v !== "a\\\\nb1") throw new Error("String.raw");
`,
);

test("tagged templates refuse undefined cooked strings and method tags", () => {
    assert.throws(
        () =>
            compileSource(
                "function tag(s: TemplateStringsArray): number { return s.length; } const v = tag`\\unicode`; export {};",
            ),
        /A template escape without a cooked value/,
    );
    assert.throws(
        () =>
            compileSource(
                "const o = { tag(s: TemplateStringsArray): string { return s[0]!; } }; const v = o.tag`x`; export {};",
            ),
        /A template tag is a function named by an identifier/,
    );
});

test("a symbol refuses implicit string conversion", () => {
    assert.throws(
        () =>
            compileSource(
                'const s = Symbol("x"); const t = `${s}`; export {};',
            ),
        /A symbol converts to text only through String\(symbol\)/,
    );
});

// An array of a string literal union the program also reads as a string
// array, or as an array of a wider union, stores its members as strings:
// every view is the one array, written and compared through either.
check(
    "literal-union-arrays-viewed-as-string-arrays",
    `
    type K = "a" | "b";
    const kinds: K[] = [];
    function names(): readonly string[] { return kinds; }
    const roots: Array<typeof names> = [names];
    kinds.push("a");
    if (roots[0]!().length !== 1 || roots[0]!() !== roots[0]!() || roots[0]!()[0] !== "a") throw new Error("one array");
    type NewsFailure = "floating" | "flatRoof" | "storeys";
    type MillFailure = "wheel" | "water";
    type Kind = "news" | "mill";
    interface NewsRecipe { readonly homeId: number; readonly failures: readonly NewsFailure[] }
    interface MillRecipe { readonly homeId: number; failures: MillFailure[] }
    interface Host { readonly homeId: number; readonly floating: boolean; readonly flat: boolean }
    const LABELS: Record<NewsFailure, string> = { floating: "F", flatRoof: "R", storeys: "S" };
    function buildNews(hosts: readonly Host[]): NewsRecipe[] {
        const recipes: NewsRecipe[] = [];
        for (const host of hosts) {
            const failures: NewsFailure[] = [];
            if (host.floating) failures.push("floating");
            if (!host.flat) failures.push("flatRoof");
            recipes.push({ homeId: host.homeId, failures });
        }
        return recipes;
    }
    function buildMills(hosts: readonly Host[]): MillRecipe[] {
        return hosts.map((host) => ({ homeId: host.homeId, failures: host.flat ? ["wheel"] : [] }));
    }
    interface Entry { homeId: number; news: { failures: readonly NewsFailure[] } | null; mill: MillRecipe | null; kinds: readonly Kind[] }
    interface Row { readonly homeId: number; readonly kind: Kind; readonly failures: readonly string[] }
    function rows(list: readonly Entry[]): Row[] {
        const out: Row[] = [];
        for (const record of list)
            for (const kind of record.kinds) {
                const failures: readonly string[] = kind === "news" ? record.news?.failures ?? [] : record.mill?.failures ?? [];
                out.push({ homeId: record.homeId, kind, failures });
            }
        return out;
    }
    function reported(entry: Readonly<Entry>, kind: Kind): readonly string[] {
        switch (kind) {
            case "news": return entry.news?.failures ?? [];
            case "mill": return entry.mill?.failures ?? [];
        }
    }
    function describe(failures: readonly NewsFailure[]): string {
        let text = "";
        for (const failure of failures) {
            switch (failure) {
                case "floating": text += "f"; break;
                case "flatRoof": text += "r"; break;
                default: text += "s";
            }
            text += LABELS[failure];
            if (failure === "storeys") text += "!";
        }
        return text;
    }
    function same(a: unknown, b: unknown): boolean { return a === b; }
    function run(): string {
        const hosts: Host[] = [{ homeId: 1, floating: true, flat: false }, { homeId: 9, floating: false, flat: true }];
        const news = buildNews(hosts);
        const mills = buildMills(hosts);
        const list: Entry[] = news.map((recipe, i) => ({ homeId: recipe.homeId, news: { failures: recipe.failures }, mill: mills[i]!, kinds: ["news", "mill"] }));
        const table = rows(list);
        if (!same(table[0]!.failures, news[0]!.failures) || table[1]!.failures !== mills[0]!.failures) throw new Error("one array per view");
        if (reported(list[1]!, "mill") !== mills[1]!.failures) throw new Error("returned view");
        mills[1]!.failures.push("water");
        if (table[3]!.failures.join() !== "wheel,water") throw new Error("write through the union view");
        const view: string[] = mills[0]!.failures;
        view.push("wheel");
        if (mills[0]!.failures.length !== 1 || mills[0]!.failures[0] !== "wheel" || table[1]!.failures.length !== 1) throw new Error("write through the string view");
        if (describe(news[0]!.failures) !== "fFrR" || !news[0]!.failures.includes("flatRoof")) throw new Error("switch and keys over elements");
        return JSON.stringify(table.map((row) => [row.kind, row.failures]));
    }
    const runs: Array<typeof run> = [run];
    if (runs[0]!() !== '[["news",["floating","flatRoof"]],["mill",["wheel"]],["news",[]],["mill",["wheel","water"]]]') throw new Error("rows");
`,
);

check(
    "nested-literal-union-arrays-viewed-as-string-arrays",
    `
    type ChurchFailure = "nave" | "bell";
    type KilnFailure = "kiln" | "kilnAccess" | "kilnAccess.blocked" | "chimney";
    type Recipe = "church" | "kiln";
    function rowsWithFamily<F extends string>(failures: readonly F[], member: (failure: F) => boolean, group: F): readonly (readonly F[])[] {
        const rows: F[][] = [];
        let family: F[] | null = null;
        for (const failure of failures) {
            if (!member(failure)) { rows.push([failure]); continue; }
            if (!family) rows.push(family = []);
            if (failure === group) family.unshift(failure);
            else family.push(failure);
        }
        return rows;
    }
    const CHURCH_FAILURES: readonly ChurchFailure[] = ["nave", "bell"];
    const CHURCH_ROWS: readonly (readonly ChurchFailure[])[] = CHURCH_FAILURES.map((failure) => [failure] as const);
    const KILN_ROWS: readonly (readonly KilnFailure[])[] = rowsWithFamily<KilnFailure>(["kiln", "kilnAccess.blocked", "kilnAccess", "chimney"], (f) => f.startsWith("kilnAccess"), "kilnAccess");
    const ROWS: Readonly<Record<Recipe, readonly (readonly string[])[]>> = { church: CHURCH_ROWS, kiln: KILN_ROWS };
    interface Plate { readonly candidates: readonly Recipe[]; readonly church: { failures: readonly ChurchFailure[] } | null; readonly kiln: { failures: readonly KilnFailure[] } | null }
    interface ChecklistRow { readonly token: string; readonly tokens: readonly string[]; readonly state: "met" | "missing" }
    function reported(plate: Readonly<Plate>, recipe: Recipe): readonly string[] {
        switch (recipe) {
            case "church": return plate.church?.failures ?? [];
            case "kiln": return plate.kiln?.failures ?? [];
        }
    }
    function checklists(plate: Readonly<Plate>): readonly { recipe: Recipe; rows: readonly ChecklistRow[] }[] {
        return plate.candidates.map((recipe) => {
            const failures = reported(plate, recipe);
            const rows: ChecklistRow[] = ROWS[recipe].map((tokens) => ({
                token: tokens[0]!,
                tokens,
                state: tokens.some((token) => failures.includes(token)) ? "missing" as const : "met" as const,
            }));
            return { recipe, rows };
        });
    }
    function lines(recipe: Recipe): readonly { key: string }[] {
        return ROWS[recipe].map((tokens) => ({ key: "row." + recipe + "." + tokens[0]! }));
    }
    function same(a: unknown, b: unknown): boolean { return a === b; }
    function run(): string {
        const kiln: KilnFailure[] = [];
        kiln.push("kilnAccess.blocked");
        const plate: Plate = { candidates: ["church", "kiln"], church: { failures: [] }, kiln: { failures: kiln } };
        const result = checklists(plate);
        if (!same(result[1]!.rows[1]!.tokens, KILN_ROWS[1]) || result[0]!.rows[0]!.tokens !== CHURCH_ROWS[0]) throw new Error("rows keep their arrays");
        if (reported(plate, "kiln") !== kiln) throw new Error("reported view");
        kiln.push("chimney");
        if (checklists(plate)[1]!.rows.map((row) => row.state).join() !== "met,missing,missing") throw new Error("write through the union array");
        return JSON.stringify([result[1]!.rows.map((row) => [row.token, row.tokens, row.state]), lines("kiln").map((line) => line.key)]);
    }
    const runs: Array<typeof run> = [run];
    if (runs[0]!() !== '[[["kiln",["kiln"],"met"],["kilnAccess",["kilnAccess","kilnAccess.blocked"],"missing"],["chimney",["chimney"],"met"]],["row.kiln.kiln","row.kiln.kilnAccess","row.kiln.chimney"]]')
        throw new Error("checklist");
`,
);

test("literal-union arrays store strings only where a string view reads them", () => {
    const viewed = compileSource(
        "type K = 'a' | 'b'; const kinds: K[] = []; function names(): readonly string[] { return kinds; } const roots: Array<typeof names> = [names]; kinds.push('a'); if (roots[0]!() !== roots[0]!()) throw new Error('x');",
    ).cpp;
    assert.match(viewed, /bbl::js::Array<std::string> v_kinds/);
    const kept = compileSource(
        "type K = 'a' | 'b'; const kinds: K[] = []; function count(): number { return kinds.length; } const roots: Array<typeof count> = [count]; kinds.push('a'); if (roots[0]!() !== 1) throw new Error('x');",
    ).cpp;
    assert.doesNotMatch(kept, /Array<std::string>/);
    assert.match(kept, /bbl::js::Array<bblscene::K>/);
});

// An assertion to a record type reads the record member of a union of a
// string and one record type.
check(
    "asserted-record-member-of-a-string-union",
    `
    interface Decl { readonly name: string; readonly sampleType?: "float" | "depth" }
    type Sampler = string | Decl;
    function samplers(shadows: boolean): readonly Sampler[] {
        return shadows ? [{ name: "csm", sampleType: "depth" }, { name: "stable" } as Sampler] : [{ name: "albedo" }];
    }
    function names(shadows: boolean): string[] { return samplers(shadows).map((sampler) => (sampler as { name: string }).name); }
    const stored: Array<typeof names> = [names];
    if (stored[0]!(true).join() !== "csm,stable" || stored[0]!(false).join() !== "albedo") throw new Error("names");
    const name = (sampler: Sampler): string => (sampler as { name: string }).name;
    if (name({ name: "x" }) !== "x") throw new Error("name");
`,
);

// A numeric index view with a length writes through any numeric array; a
// literal union assigned to a string local spells its string.
check(
    "numeric-index-views-and-literal-union-strings",
    `
    const LANE = { a: 3, b: 15 } as const;
    function stamp(matrix: { [index: number]: number; readonly length: number }, id: number, offset = 0, lane: "a" | "b" = "a"): void {
        const at = offset + LANE[lane];
        if (offset < 0 || at >= matrix.length) throw new RangeError("offset out of range");
        matrix[at] = lane === "b" ? id * 2 : id;
    }
    const stamps: Array<typeof stamp> = [stamp];
    const floats = new Float32Array(32);
    stamps[0]!(floats, 7, 16);
    const numbers: number[] = new Array<number>(16).fill(0);
    stamps[0]!(numbers, 5, 0, "b");
    if (floats[19] !== 7 || numbers[15] !== 10) throw new Error("stamp");
    let threw = false;
    try { stamps[0]!(numbers, 1, 8, "b"); } catch (error) { threw = error instanceof RangeError; }
    if (!threw) throw new Error("range");
    type Kind = "deer" | "fox";
    let animal = "";
    const spawn: Array<(kind: Kind) => void> = [(kind) => { animal = kind; }];
    spawn[0]!("fox");
    if (animal !== "fox") throw new Error("spelled kind");
`,
);

check(
    "a tag's rest parameter at index zero takes the strings and every substitution",
    `
    function parts(...values: unknown[]): string {
        return values.length + ":" + String(values[1]);
    }
    if (parts\`a\${7}b\` !== "2:7") throw new Error(parts\`a\${7}b\`);
    `,
);

check(
    "strings compare by UTF-16 code units",
    `
    const words = JSON.parse('["pear", "apple", "fig"]') as string[];
    const sorted = words.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const pair = JSON.parse('["\\ud83d\\ude00", "\\ufffd"]') as string[];
    const [emoji, replacement] = [pair[0]!, pair[1]!];
    const constants = "apple" < "banana" && "Zebra" < "apple";
    if (sorted.join() !== "apple,fig,pear" || !(emoji < replacement) || !constants)
        throw new Error(sorted.join());
    `,
);

check(
    "a string holding a trigraph sequence compiles as written",
    `
    const marks = "??= ??( ??) ??< ??> ??! ??' ??- ??/";
    if (marks.length !== 35 || marks[2] !== "=" || !marks.includes("??/")) throw new Error("trigraph text " + marks.length);
    const run = "a???=b????/";
    if (run.length !== 11 || run[4] !== "=" || run[10] !== "/") throw new Error("trigraph run " + run.length);
    `,
);

check(
    "string case maps every script as JavaScript does",
    `
    const words = JSON.parse('["é","ÉÀ","ß","ΟΔΟΣ","αβγ","привет","İstanbul","ﬀ","Σ","ΑΣ.Β","abc"]') as string[];
    const up = words.map((w) => w.toUpperCase()).join("|");
    const low = words.map((w) => w.toLowerCase()).join("|");
    if (up !== "É|ÉÀ|SS|ΟΔΟΣ|ΑΒΓ|ПРИВЕТ|İSTANBUL|FF|Σ|ΑΣ.Β|ABC" || low !== "é|éà|ß|οδος|αβγ|привет|i̇stanbul|ﬀ|σ|ασ.β|abc") throw new Error("case " + up + " " + low);
    `,
);

check(
    "an empty split separates UTF-16 code units",
    `
    const s = String.fromCodePoint(97, Math.floor(Math.random() * 0) + 0x1f600, 98);
    const parts = s.split("");
    if (parts.length !== 4 || parts[1]!.charCodeAt(0) !== 0xd83d || parts[1]! + parts[2]! !== s.slice(1, 3)) throw new Error("split " + parts.length);
    `,
);

check(
    "a parsed string iterates its code points",
    `
    const s = JSON.parse('"a😀b"') as string;
    let count = 0;
    for (const c of s) count += c.length > 0 ? 1 : 0;
    if ([...s].length !== 3 || count !== 3) throw new Error("parsed string " + count);
    `,
);

check(
    "slice and padding count UTF-16 units",
    `
    const s = String.fromCodePoint(Math.floor(Math.random() * 0) + 0xe9, 0x1f600, 98);
    if (s.slice(1, 3) !== s.substring(1, 3) || s.slice(-1) !== "b" || s.slice(2, 3).charCodeAt(0) !== 0xde00)
        throw new Error("slice " + s.slice(1, 3).length);
    if (s.padStart(6, "-") !== "--" + s || s.padEnd(5, "é") !== s + "é" || "x".padStart(3, "é") !== "ééx")
        throw new Error("pad " + s.padStart(6, "-"));
    `,
);

check(
    "a numeric sum inside a folded string keeps its sum",
    `
    const joined = [1 + 2 + "x", 4].join("-");
    const parts = [1 + 2, "y" + 1 + 2].join("|");
    if (joined !== "3x-4" || parts !== "3|y12") throw new Error("plus " + joined + " " + parts);
    `,
);
