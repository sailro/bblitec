import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { bakedDirectionMinimumLength, pinnedVertexNormalization } from "../src/lowering/pinned-vertex-normalization.js";
import { emitShaderCppExpression } from "../src/shader-cpp-emitter.js";
import { parseWgslExpression } from "../src/shader-ir.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

class EditedStore extends UpstreamSourceStore {
    public edit?: (source: string) => string;
    public override getSourceFile(module: string): ts.SourceFile {
        return this.edit && module === "src/material/pbr/pbr-template.ts"
            ? ts.createSourceFile(module, this.edit(super.getSource(module)), ts.ScriptTarget.Latest, true)
            : super.getSourceFile(module);
    }
}

test("vertex normalization derives the pin's common f32 normal/tangent operation", () => {
    const source = pinnedVertexNormalization(new LoweringContext());
    assert.equal(bakedDirectionMinimumLength, 1e-6);
    assert.match(source, /const std::array<float, 3>/);
    assert.match(source, /const float shader_normalize_length_\d+ = std::sqrt/);
    assert.equal(source.match(/> 0.000001f \?/g)?.length, 3);
    assert.equal(source.match(/\/ shader_normalize_length_\d+/g)?.length, 3);
    assert.doesNotMatch(source, /\bdouble\b|hypot|normalize_vec3_object/);
    const pal = readFileSync(resolve("native/src/pal_gpu_shared.hpp"), "utf8");
    assert.doesNotMatch(pal, /inline Vec3 normalize_vec3\(/);
    assert.equal(pal.match(/upstream::normalize_baked_direction\(/g)?.length, 2);
});

test("vertex normalization tolerates formatting and local shader aliases", () => {
    const expected = pinnedVertexNormalization(new LoweringContext());
    const store = new EditedStore();
    store.edit = source => source.replaceAll("normalize(", "normalize( /* normalization */ ")
        .replaceAll("T_local", "localTangent");
    assert.equal(pinnedVertexNormalization(new LoweringContext(store)), expected);
});

test("CPU normalization shares resolved output and world alias chains with the vertex stage", () => {
    const expected = pinnedVertexNormalization(new LoweringContext());
    const store = new EditedStore();
    store.edit = source => source
        .replace("var out:VertexOutput", "var result:VertexOutput")
        .replaceAll("out.", "result.").replaceAll("return out;", "return result;")
        .replace("var finalWorld=mesh.world;", "let firstWorld=mesh.world;let secondWorld=firstWorld;var finalWorld=secondWorld;")
        .replace("let T_local=normalize(tangent.xyz);", "let firstTangent=normalize(tangent.xyz);let secondTangent=firstTangent;let T_local=secondTangent;");
    assert.equal(pinnedVertexNormalization(new LoweringContext(store)), expected);
});

test("vertex normalization follows common expression changes and refuses mismatched directions", () => {
    const store = new EditedStore();
    store.edit = source => source.replaceAll("normalize(${normVar})", "normalize(${normVar} * 2.0)")
        .replaceAll("normalize(tangent.xyz)", "normalize(tangent.xyz * 2.0)");
    assert.match(pinnedVertexNormalization(new LoweringContext(store)), /value\.x \* 2\.0f/);
    store.edit = source => source.replaceAll("normalize(tangent.xyz)", "normalize(tangent.xyz * 2.0)");
    assert.throws(() => pinnedVertexNormalization(new LoweringContext(store)), /normalization contract changed/);
    store.edit = source => source.replaceAll("normalize(${normVar})", "${normVar}");
    assert.throws(() => pinnedVertexNormalization(new LoweringContext(store)), /normalization contract changed/);
    store.edit = source => source.replaceAll("normalize(${normVar})", "normalize(unbound)")
        .replaceAll("normalize(tangent.xyz)", "normalize(unbound)");
    assert.throws(() => pinnedVertexNormalization(new LoweringContext(store)), /unbound input/);
});

test("WGSL normalize projection validates dimensions and only guards when explicitly requested", () => {
    for (const width of [2, 3, 4]) {
        const bindings = new Map([["value", Array.from({ length: width }, (_, index) => ({ cpp: `v[${index}]` }))]]);
        const expression = parseWgslExpression("normalize(value)");
        const raw = emitShaderCppExpression(expression, bindings);
        assert.equal(raw.components.length, width);
        assert.ok(raw.components.every(component => !component.includes("?")));
        const guarded = emitShaderCppExpression(expression, bindings, { minimumNormalizeLength: 0 });
        assert.ok(guarded.components.every(component => component.includes("> 0.0f ?")));
        for (const threshold of [-1, NaN, Infinity, 1e100]) {
            assert.throws(() => emitShaderCppExpression(expression, bindings, { minimumNormalizeLength: threshold }), /threshold/);
        }
    }
    assert.throws(() => emitShaderCppExpression(parseWgslExpression("normalize()"), new Map()), /one vector/);
    assert.throws(() => emitShaderCppExpression(parseWgslExpression("normalize(1.0)"), new Map()), /lane vector/);
    assert.throws(() => emitShaderCppExpression(parseWgslExpression("normalize(value)"),
        new Map([["value", Array.from({ length: 5 }, () => ({ cpp: "v" }))]])), /lane vector/);
    assert.throws(() => emitShaderCppExpression(parseWgslExpression("value[0]"),
        new Map([["value", [{ cpp: "v" }]]])), /does not support indexed values/);
});

const tools = optionalNativeFixtureTools();
test("generated vertex normalization preserves f32 bits, the strict threshold and degenerate vectors", { skip: !tools }, () => {
    const output = resolve("artifacts/pinned-vertex-normalization-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "normalization.hpp"), `#pragma once
#include <bblite/runtime.hpp>
#include <array>
#include <cmath>
namespace bbl::upstream {
${pinnedVertexNormalization(new LoweringContext())}
}
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", "/fp:precise",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native/include", "test/fixtures/pinned-vertex-normalization-check.cpp"]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /pinned-vertex-normalization-check: ok/);
});
