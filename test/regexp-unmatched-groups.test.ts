import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

// Unmatched captures are undefined in exec, match, matchAll, replace
// callbacks and split, and `$n` of one substitutes nothing.
const program = `
    const optional = /(a)?(b)/;
    const m = optional.exec("b");
    if (m === null) throw new Error("exec");
    if (m[1] !== undefined || m[2] !== "b" || m.length !== 3) throw new Error("exec groups");
    if ((m[1] ?? "none") !== "none") throw new Error("??");
    if (\`\${m[1]}\` !== "undefined") throw new Error("template");
    const alternation = "x".match(/(x)|(y)/);
    if (alternation === null || alternation[1] !== "x" || alternation[2] !== undefined)
        throw new Error("match alternation");
    const global = "a1b2".match(/(\\d)|z/g);
    if (global === null || global.join(",") !== "1,2") throw new Error("global match");
    let seen = "";
    for (const found of "ab ac".matchAll(/a(b)?(c)?/g))
        seen += (found[1] ?? "-") + (found[2] ?? "-") + ";";
    if (seen !== "b-;-c;") throw new Error("matchAll " + seen);
    const replaced = "b".replace(/(a)?b/, (whole: string, first?: string) =>
        first === undefined ? "U" + whole : "D");
    if (replaced !== "Ub") throw new Error("replace callback");
    if ("b".replace(/(a)?b/, "[$1]") !== "[]") throw new Error("replace $1");
    const pieces = "a1b-c".split(/(\\d)|-/);
    if (pieces.length !== 5 || pieces[1] !== "1" || pieces[3] !== undefined || pieces[4] !== "c")
        throw new Error("split " + pieces.length);
    const mandatory = /(\\d+)-(\\d+)/.exec("10-20");
    if (mandatory === null || Number(mandatory[1]) + Number(mandatory[2]) !== 30)
        throw new Error("mandatory groups");
    if ("x-y".split(/(-)/).join("|") !== "x|-|y") throw new Error("split capture");
    const unicode = "a\\u{1F600}b,c".split(/(\\u{1F600})|(,)/u);
    if (unicode.length !== 7 || unicode[1] !== "\\u{1F600}" || unicode[2] !== undefined || unicode[5] !== ",")
        throw new Error("unicode split " + unicode.length);
`;

test("unmatched RegExp captures are undefined, as in Node", () => {
    runInNewContext(
        ts.transpileModule(program, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(program);
    // Patterns whose captures always participate keep string lists.
    assert.match(result.cpp, /\.exec\(/);
    assert.match(result.cpp, /\.exec<bbl::js::Nullable<std::string>>\(/);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(tools, "regexp-unmatched-groups", result.cpp, {
        expectedOutput: "",
    });
});
