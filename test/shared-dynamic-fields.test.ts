import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("a record field holding a parsed array shares it with the record type it is stored as", (t) => {
    // The returned literal keeps the parsed config's array; stored as `Snap`
    // it stays that one array, so a later push and an identity test agree.
    const source = `
interface Snap { n: number; stops: readonly number[] }
interface Config { stops: number[] }
const config = JSON.parse('{"stops":[1,2,3]}') as Config;
const listeners = new Set<(s: Snap) => void>();
let seen = 0;
let same = false;
listeners.add((s) => { seen = s.n + s.stops.length; same = s.stops === config.stops; });
const snapshot = (): Snap => ({ n: 1, stops: config.stops });
const snap = snapshot();
config.stops.push(4);
for (const listener of listeners) listener(snap);
if (seen !== 5 || !same) throw new Error("shared stops " + seen);
`;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const { cpp } = compileSource(source, {
        fileName: resolve("shared-dynamic-fields.ts"),
    });
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "shared-dynamic-fields", cpp, {
        expectedOutput: "",
    });
});
