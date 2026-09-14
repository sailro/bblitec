import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const native = optionalNativeFixtureTools(false);

test("Date values retain identity, mutable timestamps and UTC formatting", {skip: !native}, () => {
    const timestamps = [0, -1, 1, -0.9, 0.9, 951782400123, -62167219200000, -62198755200000,
        253402300800000, -8640000000000000, 8640000000000000];
    const result = compileSource(`
        function format(value: Date): string { return value.toISOString(); }
        ${timestamps.map((stamp, index) => `
            const date${index} = new Date(${stamp});
            if (format(date${index}) !== ${JSON.stringify(new Date(stamp).toISOString())}) throw new Error("UTC date ${index}");
        `).join("\n")}
        const original = new Date(0);
        let reseated = new Date(0);
        const retained = reseated;
        reseated = new Date(42);
        if (retained.getTime() !== 0 || reseated.getTime() !== 42) throw new Error("Date binding copies identity");
        const copy = new Date(original);
        const state = { date: original };
        if (state.date !== original || copy === original) throw new Error("Date identity");
        const seen = new Map<Date, string>();
        seen.set(original, "first");
        if (seen.get(state.date) !== "first" || seen.has(copy)) throw new Error("Date map keys");
        state.date.setTime(1234.9);
        if (original.getTime() !== 1234 || copy.getTime() !== 0) throw new Error("Date alias or copy");
        let target = original;
        function moveTarget(): number { target = copy; return 23; }
        target.setTime(moveTarget());
        if (original.getTime() !== 23 || target.getTime() !== 0) throw new Error("Date receiver before arguments");
        const dates: Date[] = [original];
        if (!dates[0] || dates[1] || !original) throw new Error("Date object truthiness");
        let factoryCalls = 0;
        function dateFactory(): Date { factoryCalls++; return original; }
        if (!dateFactory() || factoryCalls !== 1) throw new Error("Date truthiness preserves factory effects");
        const absent = dates[1] ?? null;
        if (absent) throw new Error("Date missing array entry");
        const now = new Date();
        if (now.getTime() < Date.now() - 10000 || now.getTime() > Date.now()) throw new Error("wall clock");
        const invalid = new Date(Infinity);
        if (!Number.isNaN(invalid.valueOf())) throw new Error("invalid date value");
        let caught = false;
        try { invalid.toISOString(); } catch { caught = true; }
        if (!caught) throw new Error("invalid date ISO must throw");
        const formatter = Intl.DateTimeFormat();
        const first = formatter.resolvedOptions();
        if (!first.timeZone) throw new Error("resolved time zone");
        if (formatter.resolvedOptions().timeZone !== ${JSON.stringify(Intl.DateTimeFormat().resolvedOptions().timeZone)}) throw new Error("default time zone");
        const fresh = new Intl.DateTimeFormat();
        const alias = formatter;
        if (!formatter || alias !== formatter || fresh === formatter) throw new Error("formatter identity");
        if (fresh.resolvedOptions().timeZone !== formatter.resolvedOptions().timeZone) throw new Error("formatter construction");
    `);
    const directory = resolve("artifacts/date-values");
    mkdirSync(directory, {recursive:true});
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(native!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${directory}/`, `/Fe:${executable}`, "/I", "native/include", source]);
    assert.equal(execFileSync(executable, {encoding:"utf8"}), "");
});
