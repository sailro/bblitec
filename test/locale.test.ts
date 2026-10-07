import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("native Unicode normalization and collation match JavaScript", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required");
        return;
    }
    const normalization = [
        "",
        "e\u0301",
        "\ufb03",
        "\u212b",
        "\uac00",
        "A\ud800\u0301\udfff\ud83d\ude80",
    ]
        .flatMap((value) =>
            ["NFC", "NFD", "NFKC", "NFKD"].map(
                (form) =>
                    `if (${JSON.stringify(value)}.normalize(${JSON.stringify(form)}) !== ${JSON.stringify(value.normalize(form))}) throw new Error("normalization ${form}");`,
            ),
        )
        .join("\n");
    const comparisons: Array<
        readonly [
            string,
            string,
            string | string[],
            Omit<Intl.CollatorOptions, "collation"> & { collation?: string },
        ]
    > = [
        ["item2", "item10", "en", { numeric: true }],
        ["item2", "item10", "en-u-kn-true", {}],
        ["item2", "item10", "en-u-kn-true", { numeric: false }],
        ["é", "e", "fr", { sensitivity: "base" }],
        ["é", "e", "fr", { sensitivity: "accent" }],
        ["A", "a", "en", { sensitivity: "case" }],
        ["ä", "z", "sv", {}],
        ["ä", "z", "de", {}],
        ["é", "e\u0301", "en", {}],
        ["ä", "z", ["zz-ZZ", "sv"], {}],
        ["ä", "z", ["zz-ZZ", "sv-SE"], { localeMatcher: "lookup" }],
        ["ä", "z", ["de", "sv"], { localeMatcher: "best fit" }],
        ["A", "a", ["en"], { caseFirst: "upper" }],
        ["A", "a", "en-u-kf-upper", { caseFirst: "lower" }],
        ["A", "a", "en-u-kf-upper", { caseFirst: "false" }],
        ["ab", "a-b", "en", { ignorePunctuation: true }],
        ["ab", "a-b", "en", { ignorePunctuation: false }],
        ["$a", "a", "en", { ignorePunctuation: true }],
        ["a", "ä", "de", { usage: "search", sensitivity: "base" }],
        ["ä", "ae", "de", { collation: "phonebk", sensitivity: "base" }],
        [
            "ä",
            "ae",
            "de-u-co-phonebk",
            { collation: "foobar", sensitivity: "base" },
        ],
        [
            "ä",
            "ae",
            "de-u-co-phonebk",
            { collation: "standard", sensitivity: "base" },
        ],
        [
            "ä",
            "ae",
            "de-u-co-phonebk",
            { collation: "search", sensitivity: "base" },
        ],
        ["a", "A", "en-u-ks-level1", {}],
        ["a", "a-", "th", {}],
        ["a", "a-", "th", { ignorePunctuation: false }],
        ["same", "same", [], {}],
        ["x2", "x10", "en-u-kn", {}],
        ["x2", "x10", "en-u-kn-false", {}],
        ["x2", "x10", "en-u-kn-invalid", {}],
        ["A", "a", "en-u-kf-invalid", {}],
        ["A", "a", "en-u-kf-false", {}],
        ["A", "a", "en-u-kf-upper", {}],
        [
            "ä",
            "ae",
            "de-u-co-phonebk",
            { collation: "PHONEBK", sensitivity: "base" },
        ],
    ];
    const collation = comparisons
        .map(([left, right, locale, options], index) => {
            const expression = `Math.sign(${JSON.stringify(left)}.localeCompare(${JSON.stringify(right)}, ${JSON.stringify(locale)}, ${JSON.stringify(options)}))`;
            const sign: unknown = runInNewContext(expression);
            assert.ok(typeof sign === "number");
            return `if (${expression} !== ${sign}) throw new Error("collation ${index}");`;
        })
        .join("\n");
    const result = compileSource(
        `${normalization}\n${collation}
        let locale: string | undefined = "en";
        const options: {numeric?: boolean; sensitivity?: string} = {numeric:true, sensitivity:"base"};
        function compare(a: string, b: string) { return a.localeCompare(b, locale, options); }
        if (compare("x2", "X10") >= 0) throw new Error("stored options");
        locale = undefined;
        if (compare("same", "same") !== 0) throw new Error("default locale");
        let text = "e\\u0301";
        if (text.normalize(undefined) !== "é") throw new Error("default form");
        let failed = 0;
        try { text.normalize("invalid"); } catch { failed++; }
        try { text.localeCompare("x", "en_US"); } catch { failed++; }
        try { text.localeCompare("x", "en", {sensitivity:"invalid"}); } catch { failed++; }
        if (failed !== 3) throw new Error("invalid options");
        let receiver = "b";
        function right(): string { receiver = "a"; return "a"; }
        if (receiver.localeCompare(right(), "en") <= 0 || receiver !== "a") throw new Error("receiver snapshot");
        const locales: string[] = ["zz-ZZ", "sv"];
        const fullOptions: {usage?:string; localeMatcher?:string; collation?:string; caseFirst?:string; numeric?:boolean; sensitivity?:string; ignorePunctuation?:boolean} = {
            usage:"sort", localeMatcher:"lookup", collation:"default", caseFirst:"upper", numeric:true, sensitivity:"base", ignorePunctuation:true
        };
        if ("item-2".localeCompare("item10", locales, fullOptions) >= 0) throw new Error("stored locale options");
        let optionalLocales: string[] | undefined = ["sv"];
        if ("ä".localeCompare("z", optionalLocales) <= 0) throw new Error("optional locale list");
        optionalLocales = undefined;
        if ("same".localeCompare("same", optionalLocales) !== 0) throw new Error("absent locale list");
        function mutateOptions() { locales[1] = "de"; return {sensitivity:"base"}; }
        if ("ä".localeCompare("z", locales, mutateOptions()) >= 0) throw new Error("locale argument identity");
        let invalid = 0;
        try { text.localeCompare("x", ["en", "en_US"]); } catch { invalid++; }
        try { text.localeCompare("x", "en", {caseFirst:"invalid"}); } catch { invalid++; }
        try { text.localeCompare("x", "en", {usage:"invalid"}); } catch { invalid++; }
        try { text.localeCompare("x", "en", {localeMatcher:"invalid"}); } catch { invalid++; }
        try { text.localeCompare("x", "en", {collation:"a_b"}); } catch { invalid++; }
        if (invalid !== 5) throw new Error("invalid locale list or options");
        const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
        const names = ["item10", "Item2", "item1"];
        names.sort((a, b) => collator.compare(a, b));
        if (names.join(",") !== "item1,Item2,item10") throw new Error("collator sort");
        const swedish = Intl.Collator(locales);
        locales[1] = "sv";
        if (swedish.compare("ä", "z") >= 0 || new Intl.Collator(["sv"]).compare("ä", "z") <= 0) throw new Error("collator locales");
        let order = "";
        function first(): string { order += "1"; return "a"; }
        function second(): string { order += "2"; return "b"; }
        if (new Intl.Collator().compare(first(), second()) >= 0 || order !== "12") throw new Error("collator arguments");
        let rejected = 0;
        try { new Intl.Collator("en", {sensitivity:"invalid"}); } catch { rejected++; }
        try { Intl.Collator("en_US"); } catch { rejected++; }
        if (rejected !== 2) throw new Error("collator construction");
        function compareOptional(options?: Intl.CollatorOptions): number {
            return new Intl.Collator("en", options).compare("item2", "item10");
        }
        const comparisons: Array<typeof compareOptional> = [compareOptional];
        if (comparisons[0]!() <= 0 || comparisons[0]!({numeric:true}) >= 0)
            throw new Error("optional retained collation options");
    `,
        { fileName: "test/locale-entry.ts" },
    );
    assert.ok(result.manifest.features.includes("data:locale"));
    const directory = resolve("artifacts/locale-check");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        source,
        "native/src/pal_locale.cpp",
        "icu.lib",
    ]);
    execFileSync(executable, { stdio: "pipe" });
});

test("native number formatting matches JavaScript", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required");
        return;
    }
    const formats: Array<
        readonly [
            number,
            string | string[] | undefined,
            Intl.NumberFormatOptions,
        ]
    > = [
        [1234567.891, "en-US", {}],
        [1234.5, "es-ES", {}],
        [1234.5, "es-ES", { useGrouping: true }],
        [1234.5, "en", { useGrouping: false }],
        [12345.6789, "fr-FR", { maximumFractionDigits: 1 }],
        [123456, "fr-FR", {}],
        [1234567.5, "hi-IN", {}],
        [1234.5, "ar-EG-u-nu-arab", {}],
        [1234.5, "en-u-nu-thai", {}],
        [0.256, "en-US", { style: "percent" }],
        [0.25678, "fr-FR", { style: "percent", maximumFractionDigits: 1 }],
        [0.5, "en", { style: "percent", minimumFractionDigits: 1 }],
        [2.5, "en", { maximumFractionDigits: 0 }],
        [-2.5, "en", { maximumFractionDigits: 0 }],
        [1.005, "en", { maximumFractionDigits: 2 }],
        [1.5, "en", { minimumFractionDigits: 4 }],
        [1.23456, "en", { maximumFractionDigits: 0 }],
        [
            12345.678,
            "de-DE",
            { minimumFractionDigits: 2, maximumFractionDigits: 2 },
        ],
        [5, "en", { minimumIntegerDigits: 3 }],
        [0.000123456, "en", { maximumSignificantDigits: 3 }],
        [123456, "en", { minimumSignificantDigits: 8 }],
        [
            123456,
            "en",
            { maximumSignificantDigits: 2, maximumFractionDigits: 101 },
        ],
        [Number.NaN, "en", {}],
        [Number.POSITIVE_INFINITY, "fr", {}],
        [-0, "en", {}],
        [1e21, "en", {}],
        [1e-7, "en", {}],
        [1234.5, ["zz-ZZ", "de"], {}],
        [1234.5, ["zz-ZZ", "pt-BR"], { localeMatcher: "lookup" }],
    ];
    const formatting = formats
        .map(([value, locales, options], index) => {
            const expression = `(${Object.is(value, -0) ? "-0" : String(value)}).toLocaleString(${JSON.stringify(locales)}, ${JSON.stringify(options)})`;
            const text: unknown = runInNewContext(expression);
            assert.ok(typeof text === "string");
            return `if (${expression} !== ${JSON.stringify(text)}) throw new Error("format ${index}: " + ${expression});`;
        })
        .join("\n");
    const result = compileSource(
        `${formatting}
        function formatNumber(value: number, locale: string, options?: Intl.NumberFormatOptions): string {
            return value.toLocaleString(locale, options);
        }
        if (formatNumber(0.5, "en", { style: "percent", maximumFractionDigits: 0 }) !== "50%") throw new Error("struct options");
        if (formatNumber(1234.5, "en") !== "1,234.5") throw new Error("absent struct options");
        const formats: Array<typeof formatNumber> = [formatNumber];
        let optionCalls = 0;
        function nextOptions(): Intl.NumberFormatOptions | undefined {
            optionCalls++;
            return optionCalls === 1 ? undefined : {useGrouping:false};
        }
        if (formats[0]!(1234.5, "en", nextOptions()) !== "1,234.5" ||
            formats[0]!(1234.5, "en", nextOptions()) !== "1234.5" || optionCalls !== 2)
            throw new Error("optional retained number options");
        let unsupported = 0;
        try { formatNumber(1, "en", { currency: "EUR" }); } catch { unsupported++; }
        if (unsupported !== 1) throw new Error("unsupported struct option");
        const stored: {maximumFractionDigits?: number; useGrouping?: boolean} = {maximumFractionDigits: 1, useGrouping: false};
        if ((12345.67).toLocaleString("en", stored) !== "12345.7") throw new Error("stored options");
        let count = 1234.5;
        function bump(): string { count = 1; return "en"; }
        if (count.toLocaleString(bump()) !== "1,234.5" || count !== 1) throw new Error("receiver snapshot");
        const locales: string[] = ["zz-ZZ", "en"];
        function swap() { locales[1] = "de"; return {}; }
        if ((1234.5).toLocaleString(locales, swap()) !== "1.234,5") throw new Error("locale argument identity");
        const tris = 98765.4321;
        if (tris.toLocaleString() !== tris.toLocaleString(undefined) || tris.toLocaleString() !== tris.toLocaleString([])) throw new Error("default locale");
        interface Priced { amount: number }
        const priced: Priced[] = [{ amount: 1234.5 }, {} as Priced];
        const shown: string[] = [];
        for (const item of priced) {
            try { shown.push(item.amount.toLocaleString("en")); } catch (error) { shown.push(error instanceof TypeError ? "TypeError" : "other"); }
        }
        if (shown.join("|") !== "1,234.5|TypeError") throw new Error("asserted-empty receiver " + shown.join("|"));
        let invalid = 0;
        try { (1).toLocaleString("en", {maximumFractionDigits: 101}); } catch { invalid++; }
        try { (1).toLocaleString("en", {minimumFractionDigits: 3, maximumFractionDigits: 1}); } catch { invalid++; }
        try { (1).toLocaleString("en", {maximumSignificantDigits: 0}); } catch { invalid++; }
        try { (1).toLocaleString("en", {minimumIntegerDigits: 22}); } catch { invalid++; }
        try { (1).toLocaleString("en_US"); } catch { invalid++; }
        try { (1).toLocaleString("en", {localeMatcher: "invalid"}); } catch { invalid++; }
        const style: string = "invalid";
        try { (1).toLocaleString("en", {style}); } catch { invalid++; }
        if (invalid !== 7) throw new Error("invalid locale or options");
    `,
        { fileName: "test/number-format-entry.ts" },
    );
    assert.ok(result.manifest.features.includes("data:locale"));
    const directory = resolve("artifacts/number-format-check");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/utf-8",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        source,
        "native/src/pal_locale.cpp",
        "icu.lib",
    ]);
    execFileSync(executable, { stdio: "pipe" });
});

test("native locale case mapping matches JavaScript", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required");
        return;
    }
    const values = [
        "",
        "Report.TXT",
        "Iİiı",
        "straße ﬃ",
        "ΟΣ ΟΣΑ",
        "I\u0301 J\u0300 i\u0307",
        "A\0Z\ud800\udfff\ud83d\ude80",
    ];
    const locales: Array<string | string[] | undefined> = [
        undefined,
        [],
        "en",
        "tr",
        "az",
        "lt",
        "el",
        "tr-TR-u-co-search",
        "tr-u-co-search",
        "tr-x-test",
        "az-x-test",
        "lt-u-co-search",
        "tur",
        "tr-Latn-TR",
        "en-001",
        "sl-rozaj-biske-1994",
        ["zz-ZZ", "tr"],
        ["tr", "en"],
        ["tr", "en_US"],
        ["en", "x-private"],
    ];
    const mappings = values.flatMap((value) =>
        locales.flatMap((locale) =>
            (["toLocaleLowerCase", "toLocaleUpperCase"] as const).map(
                (method) =>
                    `if (${JSON.stringify(value)}.${method}(${JSON.stringify(locale)}) !== ${JSON.stringify(value[method](locale))}) throw new Error("case mapping ${method}");`,
            ),
        ),
    );
    const invalidTags = [
        "x-private",
        "i-klingon",
        "root",
        "abcd",
        "zh-cmn",
        "en-GB-oed",
    ];
    const invalid = invalidTags.flatMap((tag) => [
        `try { "I".toLocaleLowerCase(${JSON.stringify(tag)}); } catch { rejected++; }`,
        `try { "i".toLocaleUpperCase(${JSON.stringify(tag)}); } catch { rejected++; }`,
        `try { "a".localeCompare("b", ${JSON.stringify(tag)}); } catch { rejected++; }`,
        `try { (1).toLocaleString(${JSON.stringify(tag)}); } catch { rejected++; }`,
    ]);
    const source = `${mappings.join("\n")}
        let receiver = "I";
        let calls = 0;
        function locale(): string { calls++; receiver = "other"; return "tr"; }
        if (receiver.toLocaleLowerCase(locale()) !== "ı" || receiver !== "other" || calls !== 1)
            throw new Error("receiver snapshot");
        let requested: string[] | undefined = ["tr"];
        function lower(value: string): string { return value.toLocaleLowerCase(requested); }
        if (lower("I") !== "ı") throw new Error("stored locales");
        requested[0] = "en";
        if (lower("I") !== "i") throw new Error("live locale array");
        requested = undefined;
        if (lower("REPORT") !== "report") throw new Error("absent locales");
        let tag: string | undefined = "tr";
        function upper(value: string): string { return value.toLocaleUpperCase(tag); }
        if (upper("i") !== "İ") throw new Error("stored locale tag");
        tag = undefined;
        if (upper("report") !== "REPORT") throw new Error("absent locale tag");
        let rejected = 0;
        try { "".toLocaleLowerCase("en_US"); } catch { rejected++; }
        try { "I".toLocaleUpperCase(["en_US", "tr"]); } catch { rejected++; }
        try { "a".localeCompare("b", ["en", "en_US"]); } catch { rejected++; }
        try { (1).toLocaleString(["en", "en_US"]); } catch { rejected++; }
        ${invalid.join("\n")}
        if (rejected !== ${invalid.length + 4}) throw new Error("invalid locales");
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source, {
        fileName: "test/locale-case-entry.ts",
    });
    assert.ok(result.manifest.features.includes("data:locale"));
    const directory = resolve("artifacts/locale-case-check");
    mkdirSync(directory, { recursive: true });
    const cpp = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/utf-8",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        cpp,
        "native/src/pal_locale.cpp",
        "icu.lib",
    ]);
    execFileSync(executable, { stdio: "pipe" });
});

/** Compiles `source` with the platform layer linked and runs it; the snippet throws on a mismatch. */
function runWithLocale(
    native: NonNullable<ReturnType<typeof optionalNativeFixtureTools>>,
    name: string,
    source: string,
): void {
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ESNext },
        }).outputText,
    );
    const result = compileSource(source, { fileName: `test/${name}.ts` });
    assert.ok(result.manifest.features.includes("data:locale"));
    const directory = resolve(`artifacts/${name}`);
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(file, result.cpp);
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/utf-8",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        file,
        "native/src/pal_locale.cpp",
        "icu.lib",
    ]);
    execFileSync(executable, { stdio: "pipe" });
}

/** One expectation per expression, read from JavaScript's own Intl. */
function expectations(expressions: readonly string[]): string {
    return expressions
        .map((expression, index) => {
            const expected: unknown = runInNewContext(expression);
            assert.ok(typeof expected === "string");
            return `if (${expression} !== ${JSON.stringify(expected)}) throw new Error("case ${index}: " + ${expression});`;
        })
        .join("\n");
}

test("native Intl NumberFormat, PluralRules and ListFormat match JavaScript", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required");
        return;
    }
    const numbers = [
        `new Intl.NumberFormat("en-US", {maximumFractionDigits: 1}).format(1.25)`,
        `Intl.NumberFormat("de-DE").format(1234567.891)`,
        `new Intl.NumberFormat("fr-FR", {style: "percent"}).format(0.256)`,
        `new Intl.NumberFormat(["zz-ZZ", "pt-BR"], {minimumFractionDigits: 2}).format(5)`,
        `new Intl.NumberFormat("en", {maximumSignificantDigits: 3}).format(123456)`,
        `new Intl.NumberFormat("en", {useGrouping: false}).format(-1234.5)`,
    ];
    const plurals = [
        ...[0, 1, 2, 1.5, 1.0001, -1, NaN, Infinity].map(
            (value) => `new Intl.PluralRules("en").select(${value})`,
        ),
        ...[1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(
            (value) =>
                `new Intl.PluralRules("en", {type: "ordinal"}).select(${value})`,
        ),
        ...[0, 1, 1.5, 2].map(
            (value) => `new Intl.PluralRules("fr").select(${value})`,
        ),
        ...[1, 2, 5, 21, 1.5].map(
            (value) => `new Intl.PluralRules("ru").select(${value})`,
        ),
        ...[0, 1, 2, 3, 11, 100].map(
            (value) => `new Intl.PluralRules("ar").select(${value})`,
        ),
        `new Intl.PluralRules("ja").select(1)`,
        `new Intl.PluralRules("en", {maximumFractionDigits: 0}).select(1.4)`,
        `new Intl.PluralRules("en", {maximumFractionDigits: 0}).select(1.6)`,
        `new Intl.PluralRules("en", {minimumFractionDigits: 1}).select(1)`,
        `new Intl.PluralRules("en", {minimumSignificantDigits: 2}).select(1)`,
    ];
    const lists = ["en", "fr", "de", "es", "ja"].flatMap((locale) =>
        ["conjunction", "disjunction", "unit"].flatMap((type) =>
            ["long", "short", "narrow"].flatMap((style) =>
                [[], ["a"], ["a", "b"], ["a", "b", "c"]].map(
                    (values) =>
                        `new Intl.ListFormat(${JSON.stringify(locale)}, {type: ${JSON.stringify(type)}, style: ${JSON.stringify(style)}}).format(${JSON.stringify(values)})`,
                ),
            ),
        ),
    );
    runWithLocale(
        native,
        "intl-formatters-check",
        `${expectations([...numbers, ...plurals, ...lists])}
        let order = "";
        function locale(): string { order += "l"; return "en"; }
        function precision(): number { order += "p"; return 1; }
        const cache = new Map<string, Map<number | undefined, Intl.PluralRules>>();
        function counted(value: number, digits?: number): string {
            let entries = cache.get("en");
            if (!entries) { entries = new Map(); cache.set("en", entries); }
            let rules = entries.get(digits);
            if (!rules) {
                rules = new Intl.PluralRules(locale(), digits === undefined ? undefined : {maximumFractionDigits: precision()});
                entries.set(digits, rules);
            }
            return rules.select(value);
        }
        if (counted(1) !== "one" || counted(1.04, 1) !== "one" || counted(2, 1) !== "other" || order !== "llp") throw new Error("cached rules " + order);
        const list = new Intl.ListFormat(locale(), {style: "long", type: "disjunction"});
        const callbacks: Array<(values: readonly string[]) => string> = [values => list.format(values)];
        if (callbacks[0]!(["one", "two"]) !== "one or two") throw new Error("retained list format");
        const optional: Array<Intl.ListFormat | undefined> = [undefined, list];
        if (optional[0]?.format(["x"]) !== undefined || optional[1]?.format(["x"]) !== "x") throw new Error("optional list format");
        const formats: Intl.NumberFormat[] = [new Intl.NumberFormat("en", {minimumIntegerDigits: 3})];
        if (formats[0]!.format(5) !== "005") throw new Error("stored number format");
        let rejected = 0;
        try { new Intl.PluralRules("en", {type: "bogus" as Intl.PluralRuleType}); } catch { rejected++; }
        try { new Intl.PluralRules("en", {maximumFractionDigits: 101}); } catch { rejected++; }
        try { new Intl.ListFormat("en", {type: "bogus" as Intl.ListFormatType}); } catch { rejected++; }
        try { new Intl.ListFormat("en", {style: "bogus" as Intl.ListFormatStyle}); } catch { rejected++; }
        try { new Intl.NumberFormat("en_US"); } catch { rejected++; }
        if (rejected !== 5) throw new Error("invalid options " + rejected);
    `,
    );
});

test("native Date locale strings match JavaScript", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required");
        return;
    }
    const times = [0, 1700000000123, -100000000000, Date.UTC(1500, 0, 1)];
    const options: Array<Record<string, string | boolean>> = [
        {},
        { year: "numeric", month: "short", day: "numeric" },
        { weekday: "long" },
        { year: "2-digit", month: "2-digit", day: "2-digit" },
        { month: "long" },
        { era: "short", year: "numeric" },
        { hour: "numeric", minute: "2-digit" },
        { hour12: false },
        { second: "numeric" },
    ];
    const zones = ["UTC", "America/New_York", "Asia/Kolkata"];
    const dates = times.flatMap((time) =>
        ["en-US", "fr-FR", "de", "ja", "th"].flatMap((locale, localeIndex) =>
            // CLDR revisions differ in Thai day periods; the platform ICU's apply.
            [
                ...options,
                ...(locale === "th" ? [] : [{ hour12: true }]),
            ].flatMap((option, optionIndex) =>
                [
                    "toLocaleDateString",
                    "toLocaleTimeString",
                    "toLocaleString",
                ].map(
                    (method) =>
                        `new Date(${time}).${method}(${JSON.stringify(locale)}, ${JSON.stringify({ ...option, timeZone: zones[(localeIndex + optionIndex) % zones.length] })})`,
                ),
            ),
        ),
    );
    runWithLocale(
        native,
        "date-locale-strings-check",
        `${expectations(dates)}
        const host = new Date(1700000000000);
        if (host.toLocaleString() !== host.toLocaleString(undefined) || host.toLocaleDateString() !== host.toLocaleDateString([])) throw new Error("default locale and zone");
        if (new Date(NaN).toLocaleDateString("en", {timeZone: "Nowhere/Zone"}) !== "Invalid Date") throw new Error("invalid date");
        function formatDate(ms: number, locale: string): string {
            try {
                return new Date(ms).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
            } catch {
                return "";
            }
        }
        if (formatDate(0, "en-US") !== "Jan 1, 1970" || formatDate(0, "en_US") !== "") throw new Error("guarded format");
        let rejected = 0;
        try { new Date(0).toLocaleDateString("en", {timeZone: "Nowhere/Zone"}); } catch { rejected++; }
        try { new Date(0).toLocaleDateString("en", {month: "bogus" as "long"}); } catch { rejected++; }
        if (rejected !== 2) throw new Error("invalid options " + rejected);
    `,
    );
});

test("unlowered Intl and Date locale contracts refuse explicitly", () => {
    for (const [source, message] of [
        [
            `const f = new Intl.NumberFormat("en", { style: "currency", currency: "EUR" }); f.format(1);`,
            /Intl\.NumberFormat option 'currency' is not lowered/,
        ],
        [
            `const p = new Intl.PluralRules("en", { roundingMode: "floor" }); p.select(1);`,
            /Intl\.PluralRules option 'roundingMode' is not lowered/,
        ],
        [
            `const p = new Intl.PluralRules("en"); p.selectRange(1, 2);`,
            /Intl\.PluralRules\.selectRange is not lowered/,
        ],
        [
            `new Date(0).toLocaleDateString("en", { dateStyle: "full" });`,
            /Date\.toLocaleDateString option 'dateStyle' is not lowered/,
        ],
        [
            `const l = new Intl.ListFormat("en"); l.formatToParts(["a"]);`,
            /Intl\.ListFormat\.formatToParts is not lowered/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

test("unlowered number format contracts refuse explicitly", () => {
    assert.throws(
        () =>
            compileSource(
                `const n = 1; n.toLocaleString("en", { style: "unit" });`,
            ),
        /style 'unit' is not lowered/,
    );
    assert.throws(
        () =>
            compileSource(
                `const n = 1; n.toLocaleString("en", { notation: "compact" });`,
            ),
        /option 'notation' is not lowered/,
    );
});

test("native local-time Date getters match JavaScript in the host zone", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required");
        return;
    }
    const times = [
        0, -1, 951782400000, 1000000000000, 1700000000123, 1719792000000,
        -100000000000, 8.6e15,
    ];
    const getters = [
        "getFullYear",
        "getMonth",
        "getDate",
        "getDay",
        "getHours",
        "getMinutes",
        "getSeconds",
        "getMilliseconds",
        "getTimezoneOffset",
    ] as const;
    const expectations = times
        .flatMap((time) =>
            getters.map((getter) => {
                const expected = new Date(time)[getter]();
                return `if (new Date(times[${times.indexOf(time)}]!).${getter}() !== ${expected}) throw new Error("${getter} ${time}");`;
            }),
        )
        .join("\n");
    const source = `
        const times = [${times.join(", ")}];
        ${expectations}
        for (const time of times) {
            const date = new Date(time);
            const local = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(),
                date.getMinutes(), date.getSeconds(), date.getMilliseconds());
            if (local !== time - date.getTimezoneOffset() * 60000) throw new Error("local fields " + time);
        }
        const invalid = new Date(NaN);
        if (!Number.isNaN(invalid.getHours()) || !Number.isNaN(invalid.getTimezoneOffset())) throw new Error("invalid");
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ESNext },
        }).outputText,
    );
    const result = compileSource(source, {
        fileName: "test/locale-date-entry.ts",
    });
    assert.ok(result.manifest.features.includes("data:locale"));
    const directory = resolve("artifacts/locale-date-check");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(file, result.cpp);
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        file,
        "native/src/pal_locale.cpp",
        "icu.lib",
    ]);
    execFileSync(executable, { stdio: "pipe" });
});

test("unlowered collation option contracts refuse explicitly", () => {
    assert.throws(
        () =>
            compileSource(
                `const a = "a"; a.localeCompare("b", "en", {get sensitivity() { return "base"; }});`,
            ),
        /record of collation options/,
    );
    assert.throws(
        () => compileSource(`const a = "a"; a.localeCompare("b", [1, 2]);`),
        /string/,
    );
});

test("locale case mapping refuses non-string locale entries", () => {
    for (const method of ["toLocaleLowerCase", "toLocaleUpperCase"]) {
        assert.throws(
            () => compileSource(`"text".${method}([1, 2]);`),
            /string/,
        );
    }
});
