import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("native numeric strings, concatenation and JSON match JavaScript across binary64 values", t => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const directory = resolve("artifacts/number-format-check");
    mkdirSync(directory, { recursive: true });
    const bits = new DataView(new ArrayBuffer(8));
    const samples = new Set<bigint>();
    for (const value of [0, -0, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE,
        Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 2147483648, -2147483649,
        1e-7, 1e-6, 1e-5, 1e20, 1e21, 1e22, 1000000000000000100, .1, Math.PI]) {
        bits.setFloat64(0, value);
        const raw = bits.getBigUint64(0);
        samples.add(raw);
        if (value > 0 && Number.isFinite(value)) {
            samples.add(raw - 1n);
            samples.add(raw + 1n);
            samples.add(raw | (1n << 63n));
        }
    }
    let random = 0x84222325cbf29cen;
    for (let index = 0; index < 8192; ++index) {
        random = BigInt.asUintN(64, random * 6364136223846793005n + 1442695040888963407n);
        samples.add(random);
    }
    const cases = [...samples].map(raw => {
        bits.setBigUint64(0, raw);
        const value = bits.getFloat64(0);
        return `${raw.toString(16)}\t${String(value)}\t${JSON.stringify(value)}`;
    });
    const input = join(directory, "cases.tsv"), executable = join(directory, "check.exe");
    writeFileSync(input, cases.join("\n") + "\n");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"),
        `/Fo:${directory}/`, `/Fe:${executable}`, "test/fixtures/number-format-check.cpp"]);
    execFileSync(executable, [input], { stdio: "pipe" });
});
