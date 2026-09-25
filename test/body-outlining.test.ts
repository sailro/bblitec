import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";
import {
    outlineEmittedBody,
    outlinedBodyMinimumBytes,
} from "../src/compiler/body-outlining.js";
import {
    renderNativeEmission,
    type NativeEmission,
    type NativeStatement,
} from "../src/compiler/native-statements.js";

const emit = (statement: NativeStatement): NativeEmission => ({
    statement,
    indent: "    ",
    source: "test.ts",
});
const effect = (code: string): NativeEmission =>
    emit({ kind: "expression", code });
const declaration = (
    name: string,
    type: string,
    initializer: string,
): NativeEmission => emit({ kind: "declaration", name, type, initializer });
const largeBody = (
    prefix: readonly NativeEmission[],
    code = "use(v_scene, v_count);",
): NativeEmission[] => [
    ...prefix,
    ...Array.from(
        { length: Math.ceil(outlinedBodyMinimumBytes / code.length) },
        () => effect(code),
    ),
];
const outline = (
    body: readonly NativeEmission[],
    parameters: readonly { name: string; type: string | undefined }[] = [],
    types: Readonly<Record<string, string>> = {},
) => {
    let next = 0;
    return outlineEmittedBody({
        body,
        parameters,
        source: "test.ts",
        bindingType: (name) => types[name],
        allocateName: () => `outlined_${next++}`,
    });
};
const render = (body: readonly NativeEmission[]) =>
    body.map(renderNativeEmission).join("\n");

test("emitted declarations retain their lifetime and large initializers return the declared type", () => {
    const result = outline(
        largeBody([
            declaration("v_scene", "auto", "create_scene(v_engine)"),
            declaration("v_count", "double", "0.0"),
            declaration("v_lambda", "auto", "[&]() { return 1; }"),
            effect("v_lambda();"),
            emit({ kind: "open", code: "if (v_count > 1.0) {" }),
            emit({ kind: "control", code: "return 1;", transfer: "return" }),
            emit({ kind: "close", code: "}" }),
            declaration(
                "v_values",
                "const bbl::js::Array<double>",
                `bbl::js::Array<double>{${"1.0, ".repeat(300)}2.0}`,
            ),
        ]),
        [],
        { v_scene: "bbl::Scene" },
    );
    const text = render(result.body);
    assert.match(text, /auto v_scene = create_scene\(v_engine\);/);
    assert.match(text, /v_lambda\(\);/);
    assert.match(text, /return 1;/);
    assert.match(
        text,
        /const bbl::js::Array<double> v_values = bblscene::outlined_0\(\);/,
    );
    assert.match(
        result.segments[0]!.prototype,
        /^bbl::js::Array<double> outlined_0\(\);$/,
    );
    assert.match(
        result.segments[1]!.prototype,
        /bbl::Scene& v_scene, \[\[maybe_unused\]\] double& v_count/,
    );
    assert.ok(result.segments.every((segment) => segment.source === "test.ts"));
});

test("untyped reads stay in their scope", () => {
    const body = largeBody(
        [declaration("v_opaque", "auto", "make()")],
        "use(v_opaque);",
    );
    const result = outline(body);
    assert.equal(result.segments.length, 0);
    assert.equal(render(result.body), render(body));
});

test("static storage specifiers stay on declarations and constexpr aliases remain const", () => {
    const result = outline(
        largeBody(
            [
                declaration("v_count", "static constexpr double", "3.0"),
                declaration("v_alias", "auto&", "v_count"),
            ],
            "use(v_alias);",
        ),
    );
    assert.match(render(result.body), /static constexpr double v_count/);
    assert.ok(result.segments.length > 0);
    for (const segment of result.segments)
        assert.match(segment.prototype, /const double& v_alias/);
});

test("constant initializers remain in place and rewritten declarations retain metadata", () => {
    const initializer = `std::array<double, 400>{${"1.0, ".repeat(399)}2.0}`;
    const result = outline(
        largeBody(
            [
                declaration(
                    "v_constants",
                    "static constexpr std::array<double, 400>",
                    initializer,
                ),
                emit({
                    kind: "declaration",
                    name: "v_values",
                    type: "std::array<double, 400>",
                    initializer,
                    discardIfUnused: true,
                    dependencies: ["v_source"],
                }),
            ],
            "use(v_values, v_constants);",
        ),
    );
    assert.match(render(result.body), /static constexpr.* = std::array/);
    assert.equal(result.rewrittenDeclarations.length, 1);
    assert.equal(result.rewrittenDeclarations[0]!.discardIfUnused, true);
    assert.deepEqual(result.rewrittenDeclarations[0]!.dependencies, [
        "v_source",
    ]);
});

const tools = optionalNativeFixtureTools();
test(
    "large emitted native functions retain parameter storage, mutations and early returns",
    { skip: !tools },
    () => {
        const count = 650;
        const result = compileSource(`
        function update(values: number[], delta: number): number {
            if (delta < 0) return values[0];
            ${"values[0] += delta;\n".repeat(count)}
            return values[0];
        }
        const values = [0];
        const first = update(values, 1);
        const skipped = update(values, -1);
        const second = update(values, 2);
        if (first !== ${count} || skipped !== ${count} || second !== ${count * 3}) throw new Error("outlined mutations");
    `);
        assert.match(result.cpp, /bbl_outlined_\d+/);
        const output = resolve("artifacts/structured-outlining-check");
        mkdirSync(output, { recursive: true });
        const source = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(source, result.cpp);
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/MD",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            source,
        ]);
        execFileSync(executable, { encoding: "utf8" });
    },
);

test("single-run scopes outline their bodies without moving an outward break", () => {
    const result = outline(
        [
            emit({ kind: "open", code: "do {", breaks: true }),
            emit({ kind: "open", code: "if (v_delta > 1.0) {" }),
            emit({ kind: "control", code: "break;", transfer: "break" }),
            emit({ kind: "close", code: "}" }),
            ...largeBody([], "step(v_engine, v_delta);"),
            emit({ kind: "close", code: "} while (false);" }),
        ],
        [
            { name: "v_engine", type: "Engine" },
            { name: "v_delta", type: "double" },
        ],
    );
    assert.match(render(result.body), /break;/);
    assert.match(render(result.body), /while \(false\)/);
    assert.ok(result.segments.length > 0);
    for (const segment of result.segments)
        assert.doesNotMatch(segment.lines.join("\n"), /break;/);
});

test("a loop and its breaks move whole without per-iteration outline calls", () => {
    const result = outline(
        [
            emit({
                kind: "open",
                code: "while (v_count > 0.0) {",
                iteration: true,
            }),
            ...largeBody([], "step(v_count);"),
            emit({ kind: "control", code: "break;", transfer: "break" }),
            emit({ kind: "close", code: "}" }),
        ],
        [{ name: "v_count", type: "double" }],
    );
    assert.equal(result.segments.length, 1);
    assert.match(
        result.segments[0]!.lines.join("\n"),
        /while.*\{[\s\S]*break;/,
    );
    assert.doesNotMatch(
        result.segments[0]!.lines.join("\n"),
        /bblscene::outlined_/,
    );
    assert.doesNotMatch(render(result.body), /while/);
});

test("branches use their own declared locals and preserve const aliases", () => {
    const result = outline([
        declaration("v_count", "const double", "3.0"),
        declaration("v_alias", "auto&", "v_count"),
        emit({ kind: "open", code: "if (condition()) {" }),
        declaration("v_inner", "double", "2.0"),
        ...largeBody([], "use(v_inner, v_alias);"),
        emit({ kind: "branch", code: "} else {" }),
        ...largeBody([], "use(v_alias);"),
        emit({ kind: "close", code: "}" }),
    ]);
    assert.ok(result.segments.length > 1);
    assert.ok(
        result.segments.some((segment) =>
            /const double& v_alias/.test(segment.prototype),
        ),
    );
    assert.ok(
        result.segments.some((segment) =>
            /double& v_inner/.test(segment.prototype),
        ),
    );
    assert.match(render(result.body), /else/);
});

test("text inside expressions cannot create statement boundaries or outward returns", () => {
    const code = 'consume(R"tag(}; return; else {)tag", [] { return 1; }());';
    const result = outline(largeBody([], code));
    assert.ok(result.segments.length > 0);
    assert.ok(
        result.segments.every((segment) =>
            segment.lines.includes(`    ${code}`),
        ),
    );
});

test("an opaque declaration or incomplete emission fragment cannot export a hidden local", () => {
    for (const prefix of [
        emit({ kind: "verbatim", code: "auto [left, right] = pair();" }),
        emit({ kind: "close", code: "}" }),
    ]) {
        const body = largeBody([prefix], "use(left, right);");
        const result = outline(body);
        assert.equal(result.segments.length, 0);
        assert.equal(render(result.body), render(body));
    }
});

import {
    cppDeclaredNames,
    splitCppDeclarations,
} from "../src/compiler/cpp-declarations.js";
import { renderSourceUnits } from "../src/compiler/source-units.js";

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
