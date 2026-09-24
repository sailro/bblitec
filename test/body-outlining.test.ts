import assert from "node:assert/strict";
import test from "node:test";
import {
    outlineFunctionBody,
    outlineFunctionDefinition,
    outlinedBodyMinimumBytes,
} from "../src/compiler/body-outlining.js";
import {
    cppDeclaredNames,
    cppStatementShape,
    parseCppLocalDeclaration,
    splitCppDeclarations,
    splitCppStatements,
    transfersControlOut,
} from "../src/compiler/cpp-statements.js";
import { cppTokens } from "../src/compiler/cpp-identifiers.js";
import { renderSourceUnits } from "../src/compiler/source-units.js";

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

test("namespace declarations split and name what they declare", () => {
    const declarations = splitCppDeclarations(String.raw`
        enum class Kind { A, B };
        struct PointData;
        using Point = bbl::js::Ref<PointData>;
        struct PointData { double x{}; };
        inline void json_write(bbl::js::JsonWriter& writer, Kind value) { writer.value(1); }
        const bbl::js::Tuple<3>& MINS();
        extern const std::array<int, 2> ORDER;
        inline auto& v_cached() { static auto value = 1; return value; }
    `);
    assert.deepEqual(
        declarations.map(({ tokens }) => cppDeclaredNames(tokens)),
        [
            { names: ["Kind"], function: false },
            { names: ["PointData"], function: false },
            { names: ["Point"], function: false },
            { names: ["PointData"], function: false },
            { names: ["json_write"], function: true },
            { names: ["MINS"], function: true },
            { names: ["ORDER"], function: false },
            { names: ["v_cached"], function: true },
        ],
    );
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

test("units hold only the declarations their code reaches, with argument-dependent overloads", () => {
    const output = renderSourceUnits({
        source: "entry.ts",
        realm: undefined,
        includes: "#include <cstdio>",
        declarations: [
            { scene: true, text: "struct UsedData { double x{}; };" },
            { scene: true, text: "struct OtherData { double y{}; };" },
            {
                scene: true,
                text: "inline void json_write(int& writer, const UsedData& value) { writer += static_cast<int>(value.x); }",
            },
            {
                scene: true,
                text: "inline void json_write(int& writer, const OtherData& value) { writer += static_cast<int>(value.y); }",
            },
            { scene: true, text: "double used(UsedData data);" },
            { scene: true, text: "double other(OtherData data);" },
        ],
        definitions: [
            {
                source: "used.ts",
                definition: "double used(UsedData data) { return data.x; }",
            },
            {
                source: "other.ts",
                definition: "double other(OtherData data) { return data.y; }",
            },
        ],
        templates: [],
        entry: "int main() { return bblscene::used({1.0}) == 1.0 ? 0 : 1; }",
        cpp: "standalone",
    });
    const unit = (source: string) =>
        output.files.get(
            output.sourceUnits.find((candidate) => candidate.source === source)!
                .path,
        )!;
    assert.equal(
        output.files.get("sources/application.hpp"),
        "#pragma once\n#include <cstdio>\n",
    );
    assert.match(unit("used.ts"), /struct UsedData/);
    assert.match(
        unit("used.ts"),
        /json_write\(int& writer, const UsedData& value\)/,
    );
    assert.doesNotMatch(unit("used.ts"), /OtherData|double other/);
    assert.match(unit("entry.ts"), /double used\(UsedData data\);/);
    assert.doesNotMatch(unit("entry.ts"), /OtherData/);
    assert.match(unit("other.ts"), /struct OtherData/);
    assert.doesNotMatch(unit("other.ts"), /UsedData/);
});
