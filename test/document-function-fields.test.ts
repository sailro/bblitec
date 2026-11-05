import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("a record type with methods that parsed values reach is a document whose methods are called or refused", async (t) => {
    // One record type holds a literal with its method and parsed records
    // that never carry one: a call runs the literal's method and throws a
    // TypeError for a parsed record, and a parsed record keeps the keys its
    // type does not declare.
    const source = `"use strict";
interface FileHandle { name: string; kind?: "file"; getFile: () => Promise<string> }
function stored(text: string): FileHandle | null {
    return JSON.parse(text) as FileHandle | null;
}
function isMarker(value: unknown): value is { dir: string } {
    return typeof value === "object" && value !== null && typeof (value as { dir?: unknown }).dir === "string";
}
async function main(): Promise<string> {
    const made: FileHandle = { name: "made", getFile: async () => "contents" };
    const handles: (FileHandle | null)[] = [made, stored('{"name":"saved"}'), stored('{"dir":"d","name":"marker"}'), stored("null")];
    const seen: string[] = [];
    for (const handle of handles) {
        if (!handle) {
            seen.push("none");
            continue;
        }
        if (isMarker(handle)) {
            seen.push("marker " + handle.dir);
            continue;
        }
        try {
            seen.push(handle.name + " " + (await handle.getFile()));
        } catch (error) {
            seen.push(handle.name + " " + (error instanceof TypeError ? "TypeError" : "other"));
        }
    }
    return seen.join("|");
}
main().then((result) => {
    if (result !== "made contents|saved TypeError|marker d|none") throw new Error(result);
});
`;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const { cpp } = compileSource(source, {
        fileName: resolve("document-function-fields.ts"),
    });
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "document-function-fields", cpp, {
        expectedOutput: "",
    });
});
