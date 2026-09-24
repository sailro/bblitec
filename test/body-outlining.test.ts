import assert from "node:assert/strict";
import test from "node:test";
import {
    outlineFunctionBody,
    outlineFunctionDefinition,
    outlinedBodyMinimumBytes,
} from "../src/compiler/body-outlining.js";
import {
    cppStatementShape,
    parseCppLocalDeclaration,
    splitCppStatements,
    transfersControlOut,
} from "../src/compiler/cpp-statements.js";
import { cppTokens } from "../src/compiler/cpp-identifiers.js";

const tokens = (text: string) => [...cppTokens(text)];

test("statements split at their own end, keeping else, catch and do-while", () => {
    const statements = splitCppStatements(String.raw`
        auto v_a = T{1, 2};
        if (v_a) { f("}"); } else if (v_b) { g(); } else { h(); }
        try { f(); } catch (...) { g(); }
        do { f(); } while (false);
        auto v_c = [&]() -> int { return 1; }();
        { auto v_d = 1; }
        (*v_e) = 2;
    `);
    assert.deepEqual(
        statements.map(({ tokens }) => cppStatementShape(tokens)),
        [
            "declaration",
            "compound",
            "compound",
            "compound",
            "declaration",
            "compound",
            "expression",
        ],
    );
    assert.match(statements[1]!.text, /^if .* else \{ h\(\); \}$/);
});

test("declarations read their name, spelled type and constness", () => {
    const read = (text: string) =>
        parseCppLocalDeclaration(splitCppStatements(text)[0]!.tokens);
    assert.deepEqual(
        read(
            "[[maybe_unused]] const bbl::js::Array<std::pair<int, double>> v_a = {};",
        ),
        {
            name: "v_a",
            spelledType: "bbl::js::Array<std::pair<int, double>>",
            constant: true,
            reference: false,
            initializerIndex: 22,
        },
    );
    assert.equal(read("auto& v_b = v_a;")?.spelledType, undefined);
    assert.equal(read("auto& v_b = v_a;")?.reference, true);
    assert.equal(read("int v_c, v_d;"), undefined);
    assert.equal(read("auto [v_e, v_f] = pair;"), undefined);
});

test("control leaving a statement is found outside lambdas, classes and its own loops", () => {
    const leaves = (text: string) => transfersControlOut(tokens(text));
    assert.equal(leaves("if (x) { return; }"), true);
    assert.equal(leaves("f([&]() { return 1; });"), false);
    assert.equal(
        leaves("auto v = [&] { if (x) return 2; return 3; }();"),
        false,
    );
    assert.equal(leaves("struct S { int f() { return 1; } };"), false);
    assert.equal(leaves("if (x) { break; }"), true);
    assert.equal(leaves("for (;;) { if (x) break; continue; }"), false);
    assert.equal(leaves("switch (x) { case 1: break; }"), false);
    assert.equal(leaves("switch (x) { case 1: continue; }"), true);
    assert.equal(leaves("do { break; } while (false);"), false);
    assert.equal(leaves("v[0] = 1;"), false);
});

/** The given statements, then `filler` until the body is over the outlining threshold. */
const largeBody = (statements: readonly string[], filler: string): string[] => {
    const lines = [...statements];
    while (lines.join("\n").length < outlinedBodyMinimumBytes)
        lines.push(`        ${filler}`);
    return lines;
};

test("large bodies outline typed statements and keep declarations, returns and untyped reads", () => {
    const types: Record<string, string> = {
        v_scene: "bbl::Scene",
        v_count: "double",
    };
    let next = 0;
    const outlined = outlineFunctionBody({
        lines: largeBody(
            [
                "        auto v_scene = bbl::create_scene_context(v_engine);",
                "        double v_count = 0.0;",
                "        auto v_lambda = [&]() { return 1; };",
                "        v_lambda();",
                "        if (v_count > 1.0) { return 1; }",
                "        const bbl::js::Array<double> v_values = bbl::js::Array<double>{" +
                    "1.0, ".repeat(300) +
                    "2.0};",
            ],
            "bbl::use_scene(v_scene, v_count);",
        ),
        parameters: [],
        bindingType: (name) => types[name],
        allocateName: () => `bbl_outlined_${next++}`,
    });
    const text = outlined.lines.join("\n");
    assert.match(text, /auto v_scene = bbl::create_scene_context\(v_engine\);/);
    assert.match(text, /v_lambda\(\);/);
    assert.match(text, /if \(v_count > 1\.0\) \{ return 1; \}/);
    assert.match(
        text,
        /const bbl::js::Array<double> v_values = bblscene::bbl_outlined_0\(\);/,
    );
    assert.match(text, /bblscene::bbl_outlined_1\(v_scene, v_count\);/);
    assert.equal(
        outlined.segments[1]!.prototype,
        "void bbl_outlined_1([[maybe_unused]] bbl::Scene& v_scene, [[maybe_unused]] double& v_count);",
    );
    assert.match(
        outlined.segments[0]!.lines.join("\n"),
        /^bbl::js::Array<double> bbl_outlined_0\(\) \{\n {4}return bbl::js::Array<double>\{1\.0, /,
    );
});

test("a statement reading a local without a native type stays", () => {
    const outlined = outlineFunctionBody({
        lines: largeBody(["        auto v_opaque = make();"], "use(v_opaque);"),
        parameters: [],
        bindingType: () => undefined,
        allocateName: () => "never",
    });
    assert.equal(outlined.segments.length, 0);
});

test("large compound statements outline inside their blocks, not past a break", () => {
    const outlined = outlineFunctionDefinition({
        lines: [
            "void frame([[maybe_unused]] bbl::Engine& v_engine, [[maybe_unused]] double v_delta) {",
            "    do {",
            "        if (v_delta > 1.0) { break; }",
            ...largeBody([], "bbl::step(v_engine, v_delta);"),
            "    } while (false);",
            "}",
        ],
        bindingType: () => undefined,
        allocateName: () => "bbl_outlined_frame",
    });
    const text = outlined.lines.join("\n");
    assert.match(text, /^void frame\(/);
    assert.match(text, /if \(v_delta > 1\.0\) \{ break; \}/);
    assert.match(text, /bblscene::bbl_outlined_frame\(v_engine, v_delta\);/);
    assert.match(text, /\} while \(false\);/);
    for (const segment of outlined.segments)
        assert.doesNotMatch(segment.lines.join("\n"), /break/);
    assert.match(
        outlined.segments[0]!.prototype,
        /^void bbl_outlined_frame\(\[\[maybe_unused\]\] bbl::Engine& v_engine, \[\[maybe_unused\]\] double& v_delta\);$/,
    );
});
