import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { TextLayoutLowerer } from "../src/lowering/text-layout-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { resolveBundledAsset } from "../src/compiler/assets.js";
import { readAssetBytesSync } from "../src/compiler/asset-bytes-sync.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { stringLiteral } from "../src/cpp-literals.js";

test("native live layout matches the pinned shaper and layout over editing, wrapping and paragraph batches", async t => {
    const tools = optionalNativeFixtureTools();
    const hb = resolve(nativeFixtureVcpkgRoot, "lib/harfbuzz.lib");
    if (!tools || !existsSync(hb)) { t.skip("Native HarfBuzz fixture dependency unavailable."); return; }
    const directory = resolve("artifacts/test-text-layout");
    mkdirSync(directory, { recursive: true });
    const bytes = readAssetBytesSync(resolveBundledAsset("/fonts/Inter.ttf"), resolve(directory, "source.ts"));
    writeFileSync(resolve(directory, "font.ttf"), bytes);
    writeFileSync(resolve(directory, "layout.hpp"), new TextLayoutLowerer(new LoweringContext()).header());
    const { createFontFromBuffer } = await importPinnedModule<{ createFontFromBuffer(bytes: ArrayBuffer): unknown }>("text/font.js");
    const { layoutText } = await importPinnedModule<{ layoutText(font: unknown, text: string, size: number, options: { maxWidth: number; align: string; lineHeight: number; letterSpacing: number; tabSize: number }): { _glyphs: {glyphId: number; x: number; y: number}[]; _width: number; _height: number; _pixelsPerFontUnit: number } }>("text/layout.js");
    const font = createFontFromBuffer(Uint8Array.from(bytes).buffer);
    const inputs = ["Type here...", "", "Hello, TextRenderer!\nNo scene. No camera.\nJust pixels.", "AV fi ffi office", "A\t  B\n\n C", "Résumé é Ω Ж", "This long line wraps onto multiple lines after editing.", Array.from({length: 40}, (_,i) => `row ${i}: AV`).join("\n")];
    const cases = inputs.flatMap(text => ["left", "center", "right"].map(align => ({ text, align, maxWidth: 220, lineHeight: 1.4, letterSpacing: 3.25, tabSize: 4 })));
    const expected = cases.map(input => {
        const result = layoutText(font, input.text, 48, input);
        return [result._width, result._height, result._pixelsPerFontUnit, ...result._glyphs.flatMap(glyph => [glyph.glyphId,glyph.x,glyph.y])];
    });
    const source = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(source, `#include "layout.hpp"
#include ${stringLiteral(resolve("native/src/pal_text_layout.cpp").replaceAll("\\", "/"))}
#include <nlohmann/json.hpp>
#include <fstream>
#include <iterator>
int main() {
    std::ifstream file("font.ttf", std::ios::binary);
    const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(file)), {});
    const auto font = bbl::pal::create_text_layout_font(bytes);
    nlohmann::json output = nlohmann::json::array();
    ${cases.map(input => `{
        const auto result = bbl::layout_text(*font, ${stringLiteral(input.text)}, 48, {${input.maxWidth}, ${input.lineHeight}, ${stringLiteral(input.align)}, ${input.letterSpacing}, ${input.tabSize}});
        std::vector<double> row{result.width,result.height,result.pixels_per_font_unit};
        for (const auto& glyph : result.glyphs) { row.push_back(glyph.glyph_id); row.push_back(glyph.x); row.push_back(glyph.y); }
        output.push_back(row);
    }`).join("\n")}
    std::ofstream("actual.json") << output;
}
`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/fp:strict", `/I${resolve("native/include")}`, `/I${resolve(nativeFixtureVcpkgRoot,"include")}`, `/I${resolve(nativeFixtureVcpkgRoot,"include/harfbuzz")}`, source, `/Fo${resolve(directory,"check.obj")}`, `/Fe${executable}`, "/link", hb]);
    execFileSync(executable, [], { cwd: directory, env: { ...process.env, PATH: `${resolve(nativeFixtureVcpkgRoot,"bin")};${process.env.PATH}` }, stdio: "pipe" });
    const actual: number[][] = JSON.parse(readFileSync(resolve(directory,"actual.json"), "utf8"));
    assert.equal(actual.length, expected.length);
    for (const [i,row] of expected.entries()) {
        assert.equal(actual[i]!.length, row.length, `${JSON.stringify(cases[i])}: glyph count`);
        for (const [j,value] of row.entries()) assert.ok(Math.abs(actual[i]![j]! - value) < 1e-12, `${JSON.stringify(cases[i])} lane ${j}: ${actual[i]![j]} versus ${value}`);
    }
});
