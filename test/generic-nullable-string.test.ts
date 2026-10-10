import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("generic nullable strings narrow inside returned callbacks", (t) => {
    const result = compileSource(`
        interface Sink { write(value: string): void; }
        let value = "";
        let calls = 0;
        const sink: Sink = {write: text => { value = text; calls++; }};
        function relay<Token extends string>(destination: Sink | null): (item: Token | null) => void {
            return item => { if (item !== null) destination?.write(item); };
        }
        const send = relay<"north" | "south">(sink);
        send("south");
        send(null);
        if (calls !== 1 || value !== "south") throw new Error("narrowed generic string");
        const another = relay<"warm" | "cold">(sink);
        another("cold");
        send("north");
        if (calls !== 3 || value !== "north") throw new Error("independent generic instantiations");
        function reader<Item>(item: Item | null): {read(): Item | null} {
            return {read: () => item};
        }
        const number = reader<number>(7);
        const text = reader<string>("word");
        if (number.read() !== 7 || text.read() !== "word") throw new Error("generic method record");
        function writer<Item>(target: {value: Item}): {write(value: Item): void} {
            return {write: value => { target.value = value; }};
        }
        const numeric = {value: 1};
        const textual = {value: "first"};
        const writeNumber = writer<number>(numeric);
        const writeText = writer<string>(textual);
        writeNumber.write(4);
        writeText.write("last");
        if (numeric.value !== 4 || textual.value !== "last") throw new Error("generic method parameters");
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/generic-nullable-string");
    mkdirSync(directory, { recursive: true });
    const cpp = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        cpp,
    ]);
    assert.equal(
        execFileSync(executable, {
            encoding: "utf8",
            timeout: 10000,
            stdio: "pipe",
        }),
        "",
    );
});
