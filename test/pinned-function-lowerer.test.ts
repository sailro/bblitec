import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerPinnedFunction, type PinnedFunctionParameter } from "../src/lowering/pinned-function-lowerer.js";
import { sharedUpstreamStore } from "../src/upstream-source.js";

class FunctionContext extends LoweringContext {
    constructor(private readonly source: string) { super(sharedUpstreamStore()); }
    override sourceFile(module: string): ts.SourceFile {
        return ts.createSourceFile(module, this.source, ts.ScriptTarget.Latest, true);
    }
}

const input: readonly PinnedFunctionParameter[] = [{ pinned: "input", kind: "number", cpp: "input" }];

test("pinned local storage retains its initializer contract and typed stores", () => {
    const source = "function body(input: number) { const out = allocate(); out[0] = input / 3; return out[0]; }";
    const lower = (text: string) => lowerPinnedFunction(new FunctionContext(text), "storage.ts", "body", input, {
        cppName: "body", returns: "double",
        localStorage: [{ pinned: "out", initializer: "allocate()", declaration: "std::array<float, 1> result{};",
            binding: { cpp: "result", type: "f32" } }],
    });
    const cpp = lower(source);
    assert.match(cpp, /std::array<float, 1> result\{\}/);
    assert.match(cpp, /result\[.*\] = static_cast<float>\(.*input \/ 3\.0/);
    assert.doesNotMatch(cpp, /allocate\(/);
    for (const changed of [source.replace("allocate()", "allocate(2)"),
        source.replace("const out = allocate();", ""),
        source.replace("const out = allocate();", "const out = allocate(); const out = allocate();")]) {
        assert.throws(() => lower(changed), /storage.ts:.*(?:initializer|one unbound pinned local)/);
    }
});

test("pinned guard specialization retains surrounding work and refuses ambiguous guards", () => {
    const source = "function body(input: number) { let value = 2; if (input) { value += input; } else { value *= 3; } return value + 1; }";
    const lower = (text: string, arm: "then" | "else") => lowerPinnedFunction(new FunctionContext(text), "arms.ts", "body", input, {
        cppName: "body", returns: "double", armOf: { condition: "input", arm },
    });
    assert.match(lower(source, "then"), /double value = 2\.0;\n    value \+= input;\n    return \(value \+ 1\.0\);/);
    assert.match(lower(source, "else"), /double value = 2\.0;\n    value \*= 3\.0;\n    return \(value \+ 1\.0\);/);
    for (const changed of [source.replace("if (input)", "if (!input)"),
        source.replace(" else { value *= 3; }", ""),
        source.replace("return value + 1;", "if (input) {} else {} return value + 1;")]) {
        assert.throws(() => lower(changed, "then"), /arms.ts:.*one pinned 'input' guard/);
    }
});

test("pinned parameter contracts check optionality and specialized defaults", () => {
    const lower = (source: string) => lowerPinnedFunction(new FunctionContext(source), "parameters.ts", "body", [
        { pinned: "input", kind: "number", cpp: "input", optional: true },
        { pinned: "offset", kind: "number", cpp: "offset", defaultValue: 0,
            specialized: true, binding: { cpp: "0.0", type: "scalar" } },
    ], { cppName: "body", returns: "double" });
    assert.match(lower("function body(input?: number, offset = 0) { return offset; }"), /return 0\.0;/);
    assert.throws(() => lower("function body(input: number, offset = 0) { return offset; }"), /stay optional/);
    assert.throws(() => lower("function body(input?: number, offset = 1) { return offset; }"), /default to 0/);
});
