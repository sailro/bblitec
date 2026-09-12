import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {runInNewContext} from "node:vm";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("native Unicode normalization and collation match JavaScript", t => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native compiler required"); return; }
    const normalization = ["", "e\u0301", "\ufb03", "\u212b", "\uac00", "A\ud800\u0301\udfff\ud83d\ude80"]
        .flatMap(value => ["NFC", "NFD", "NFKC", "NFKD"].map(form =>
            `if (${JSON.stringify(value)}.normalize(${JSON.stringify(form)}) !== ${JSON.stringify(value.normalize(form))}) throw new Error("normalization ${form}");`)).join("\n");
    const comparisons: Array<readonly [string, string, string | string[], Omit<Intl.CollatorOptions, "collation"> & {collation?:string}]> = [
        ["item2", "item10", "en", {numeric:true}],
        ["item2", "item10", "en-u-kn-true", {}],
        ["item2", "item10", "en-u-kn-true", {numeric:false}],
        ["é", "e", "fr", {sensitivity:"base"}],
        ["é", "e", "fr", {sensitivity:"accent"}],
        ["A", "a", "en", {sensitivity:"case"}],
        ["ä", "z", "sv", {}],
        ["ä", "z", "de", {}],
        ["é", "e\u0301", "en", {}],
        ["ä", "z", ["zz-ZZ", "sv"], {}],
        ["ä", "z", ["zz-ZZ", "sv-SE"], {localeMatcher:"lookup"}],
        ["ä", "z", ["de", "sv"], {localeMatcher:"best fit"}],
        ["A", "a", ["en"], {caseFirst:"upper"}],
        ["A", "a", "en-u-kf-upper", {caseFirst:"lower"}],
        ["A", "a", "en-u-kf-upper", {caseFirst:"false"}],
        ["ab", "a-b", "en", {ignorePunctuation:true}],
        ["ab", "a-b", "en", {ignorePunctuation:false}],
        ["$a", "a", "en", {ignorePunctuation:true}],
        ["a", "ä", "de", {usage:"search", sensitivity:"base"}],
        ["ä", "ae", "de", {collation:"phonebk", sensitivity:"base"}],
        ["ä", "ae", "de-u-co-phonebk", {collation:"foobar", sensitivity:"base"}],
        ["ä", "ae", "de-u-co-phonebk", {collation:"standard", sensitivity:"base"}],
        ["ä", "ae", "de-u-co-phonebk", {collation:"search", sensitivity:"base"}],
        ["a", "A", "en-u-ks-level1", {}],
        ["a", "a-", "th", {}],
        ["a", "a-", "th", {ignorePunctuation:false}],
        ["same", "same", [], {}],
        ["x2", "x10", "en-u-kn", {}],
        ["x2", "x10", "en-u-kn-false", {}],
        ["x2", "x10", "en-u-kn-invalid", {}],
        ["A", "a", "en-u-kf-invalid", {}],
        ["A", "a", "en-u-kf-false", {}],
        ["A", "a", "en-u-kf-upper", {}],
        ["ä", "ae", "de-u-co-phonebk", {collation:"PHONEBK", sensitivity:"base"}],
    ];
    const collation = comparisons.map(([left, right, locale, options], index) => {
        const expression = `Math.sign(${JSON.stringify(left)}.localeCompare(${JSON.stringify(right)}, ${JSON.stringify(locale)}, ${JSON.stringify(options)}))`;
        const sign: unknown = runInNewContext(expression);
        assert.equal(typeof sign, "number");
        return `if (${expression} !== ${sign}) throw new Error("collation ${index}");`;
    }).join("\n");
    const result = compileSource(`${normalization}\n${collation}
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
    `, {fileName:"test/locale-entry.ts"});
    assert.ok(result.manifest.features.includes("data:locale"));
    const directory = resolve("artifacts/locale-check");
    mkdirSync(directory, {recursive:true});
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", source, "native/src/pal_locale.cpp", "icu.lib"]);
    execFileSync(executable, {stdio:"pipe"});
});

test("unlowered collation option contracts refuse explicitly", () => {
    assert.throws(() => compileSource(`const a = "a"; a.localeCompare("b", "en", {get sensitivity() { return "base"; }});`), /record of collation options/);
    assert.throws(() => compileSource(`const a = "a"; a.localeCompare("b", [1, 2]);`), /string/);
});
