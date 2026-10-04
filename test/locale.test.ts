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
