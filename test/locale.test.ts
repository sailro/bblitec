import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("native Unicode normalization and collation match JavaScript", t => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native compiler required"); return; }
    const normalization = ["", "e\u0301", "\ufb03", "\u212b", "\uac00", "A\ud800\u0301\udfff\ud83d\ude80"]
        .flatMap(value => ["NFC", "NFD", "NFKC", "NFKD"].map(form =>
            `if (${JSON.stringify(value)}.normalize(${JSON.stringify(form)}) !== ${JSON.stringify(value.normalize(form))}) throw new Error("normalization ${form}");`)).join("\n");
    const comparisons = [
        ["item2", "item10", "en", {numeric:true}],
        ["item2", "item10", "en-u-kn-true", {}],
        ["item2", "item10", "en-u-kn-true", {numeric:false}],
        ["é", "e", "fr", {sensitivity:"base"}],
        ["é", "e", "fr", {sensitivity:"accent"}],
        ["A", "a", "en", {sensitivity:"case"}],
        ["ä", "z", "sv", {}],
        ["ä", "z", "de", {}],
        ["é", "e\u0301", "en", {}],
    ] as const;
    const collation = comparisons.map(([left, right, locale, options]) => {
        const sign = Math.sign(left.localeCompare(right, locale, options));
        return `if (Math.sign(${JSON.stringify(left)}.localeCompare(${JSON.stringify(right)}, ${JSON.stringify(locale)}, ${JSON.stringify(options)})) !== ${sign}) throw new Error("collation");`;
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
    assert.throws(() => compileSource(`const a = "a"; a.localeCompare("b", "en", {ignorePunctuation:true});`), /ignorePunctuation.*not lowered/);
    assert.throws(() => compileSource(`const a = "a"; a.localeCompare("b", ["en", "fr"]);`), /string/);
});
