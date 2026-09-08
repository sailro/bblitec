import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { TextDataUpdateLowerer } from "../src/lowering/text-data-update-lowerer.js";
import { TextLayoutLowerer } from "../src/lowering/text-layout-lowerer.js";
import { TextLowerer } from "../src/lowering/text-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { materializePinnedText } from "../src/pinned-text-data.js";
import { resolveBundledAsset } from "../src/compiler/assets.js";
import { readAssetBytesSync } from "../src/compiler/asset-bytes-sync.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { stringLiteral } from "../src/cpp-literals.js";

interface PinnedData {
    width: number; height: number;
    _instanceCount: number; _styleCount: number;
    _version: number; _styleVersion: number; _layoutVersion: number;
    _dirtyStart: number; _dirtyEnd: number;
    _instances: Float32Array; _styles: Float32Array;
    runs: object[];
    _runRecords: Map<object, { _slots: number[] }>;
    _groups: { _slotCount: number; _liveCount: number; _freeSlots: number[]; _curveSet: { _atlas: { _glyphSlots: Map<number, { _index: number }> } } }[];
}

test("live text specializations refuse changed structure and retain source numeric growth", () => {
    class ChangedContext extends LoweringContext {
        private changed: ts.SourceFile | undefined;
        constructor(private readonly path: string, private readonly before: string, private readonly after: string) { super(); }
        override sourceFile(path: string): ts.SourceFile {
            const source = super.sourceFile(path);
            if (path !== this.path) return source;
            assert(source.text.includes(this.before), this.before);
            return this.changed ??= ts.createSourceFile(path, source.text.replace(this.before, this.after), ts.ScriptTarget.Latest, true);
        }
    }
    assert.throws(() => new TextDataUpdateLowerer(new ChangedContext("src/text/default-text-data.ts",
        "height: laid._height", "height: laid._height + 1")).header(), /single-run/);
    assert.throws(() => new TextDataUpdateLowerer(new ChangedContext("src/text/text-data.ts",
        "function applyReplaceRun", "function changedApplyReplaceRun")).header(), /applyReplaceRun/);
    assert.throws(() => new TextLayoutLowerer(new ChangedContext("src/text/layout.ts",
        "options?.lineHeight ?? 1.2", "options?.lineHeight ?? 1.5")).header(), /native option default/);
    const changed = new TextDataUpdateLowerer(new ChangedContext("src/text/text-data.ts",
        "data._instances.length * 2", "data._instances.length * 3")).header();
    assert.match(changed, /data\.instances\.size\(\)\) \* 3\.0/);
});

test("live default text allocator matches pinned bytes, capacity, slot reuse and versions through edits", async t => {
    const tools = optionalNativeFixtureTools();
    const hb = resolve(nativeFixtureVcpkgRoot, "lib/harfbuzz.lib");
    if (!tools || !existsSync(hb)) { t.skip("Native HarfBuzz fixture dependency unavailable."); return; }
    const directory = resolve("artifacts/test-text-update");
    mkdirSync(resolve(directory, "bblite"), { recursive: true });
    const bytes = readAssetBytesSync(resolveBundledAsset("/fonts/Inter.ttf"), resolve(directory, "source.ts"));
    writeFileSync(resolve(directory, "font.ttf"), bytes);
    const c = new LoweringContext();
    for (const [name, header] of [
        ["upstream_text.hpp", new TextLowerer(c).header()],
        ["upstream_text_layout.hpp", new TextLayoutLowerer(c).header()],
        ["upstream_text_update.hpp", new TextDataUpdateLowerer(c).header()],
    ]) writeFileSync(resolve(directory, "bblite", name!), header!);
    const baked = materializePinnedText(bytes, { live: true, text: "", fontSizePx: 48, options: { maxWidth: 220 } });
    assert(baked?.live);
    const { createFontFromBuffer } = await importPinnedModule<{ createFontFromBuffer(bytes: ArrayBuffer): unknown }>("text/font.js");
    const { createDefaultTextData, updateDefaultTextData } = await importPinnedModule<{
        createDefaultTextData(font: unknown, size: number, text: string, color: undefined, options: { maxWidth: number }): PinnedData;
        updateDefaultTextData(data: PinnedData, text: string): void;
    }>("text/default-text-data.js");
    const font = createFontFromBuffer(Uint8Array.from(bytes).buffer);
    const inputs = ["Type here...", "Type here...", "A", "New ffi text Ω Ж", "", "", "   ", "AV é Résumé", "office\nA\tB", "This line wraps after multiple words and changes the allocation", "A", "𝄞 x 😀", ""];
    let data: PinnedData | undefined;
    const expected = inputs.map(text => {
        if (data) { data._dirtyStart = data._dirtyEnd = 0; updateDefaultTextData(data, text); }
        else data = createDefaultTextData(font, 48, text, undefined, { maxWidth: 220 });
        const group = data._groups[0]!;
        const sourceIds = new Map([...group._curveSet._atlas._glyphSlots].map(([id, slot]) => [slot._index, id]));
        const words = new Uint32Array(data._instances.buffer, data._instances.byteOffset, data._instanceCount * 3);
        const instances = Array.from(words, (word, i) => i % 3 !== 2 || word === 0xffffffff ? word
            : (baked.live!.glyphSlots[sourceIds.get(word & 0xffff)!]! | (word & 0xffff0000)) >>> 0);
        return { width: data.width, height: data.height, instances, styles: Array.from(new Uint32Array(data._styles.buffer)),
            capacity: data._instances.length, count: data._instanceCount, styleCount: data._styleCount,
            version: data._version, styleVersion: data._styleVersion, layoutVersion: data._layoutVersion,
            dirty: [data._dirtyStart, data._dirtyEnd], slots: data._runRecords.get(data.runs[0]!)!._slots,
            slotCount: group._slotCount, liveCount: group._liveCount, free: group._freeSlots.slice() };
    });
    const source = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(source, `#include <bblite/upstream_text_update.hpp>
#include ${stringLiteral(resolve("native/src/pal_text_layout.cpp").replaceAll("\\", "/"))}
#include <nlohmann/json.hpp>
#include <fstream>
#include <iterator>
#include <cassert>
namespace bbl {
TextData create_compiled_text_data(std::uint32_t) {
    std::ifstream file("font.ttf",std::ios::binary);
    const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(file)),{});
    auto data=std::make_shared<TextDataState>();
    data->payload=std::make_shared<TextDataPayload>(); data->groups.resize(1);
    data->live=std::make_shared<TextLiveData>();
    data->live->font=pal::create_text_layout_font(bytes); data->live->font_size=48;
    data->live->options.max_width=220;
    data->live->glyph_slots={${baked.live.glyphSlots.join(",")}};
    return data;
}
}
std::vector<std::uint32_t> words(const std::vector<float>& floats, std::size_t count) {
    std::vector<std::uint32_t> result(count); if(count)std::memcpy(result.data(),floats.data(),count*sizeof(float));return result;
}
int main() {
    nlohmann::json output=nlohmann::json::array();
    bbl::TextData data;
    for(const auto text:std::vector<std::string>{${inputs.map(stringLiteral).join(",")}}) {
        if(data){data->dirty_start=0;data->dirty_end=0;bbl::update_default_text_data(data,text);}
        else data=bbl::create_live_text_data(0,text);
        const auto& live=*data->live;
        assert(data->payload->instances.bytes.size()==live.instances.size()*sizeof(float));
        assert(std::memcmp(data->payload->instances.bytes.data(),live.instances.data(),data->instance_count*3*sizeof(float))==0);
        assert(data->payload->styles.bytes.size()==live.styles.size()*sizeof(float));
        assert(std::memcmp(data->payload->styles.bytes.data(),live.styles.data(),live.styles.size()*sizeof(float))==0);
        output.push_back({{"width",data->payload->width},{"height",data->payload->height},
            {"instances",words(live.instances,data->instance_count*3)},{"styles",words(live.styles,live.styles.size())},
            {"capacity",live.instances.size()},{"count",data->instance_count},{"styleCount",data->style_count},
            {"version",data->version},{"styleVersion",data->style_version},{"layoutVersion",data->layout_version},
            {"dirty",std::array{data->dirty_start,data->dirty_end}},{"slots",live.slots},
            {"slotCount",live.slot_count},{"liveCount",data->groups.at(0).live_count},{"free",live.free_slots}});
    }
    std::ofstream("actual.json")<<output;
}
`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/fp:strict", `/I${directory}`, `/I${resolve("native/include")}`, `/I${resolve(nativeFixtureVcpkgRoot, "include")}`, `/I${resolve(nativeFixtureVcpkgRoot, "include/harfbuzz")}`, source, `/Fo${resolve(directory, "check.obj")}`, `/Fe${executable}`, "/link", hb]);
    execFileSync(executable, [], { cwd: directory, env: { ...process.env, PATH: `${resolve(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH}` }, stdio: "pipe" });
    const actual: typeof expected = JSON.parse(readFileSync(resolve(directory, "actual.json"), "utf8"));
    assert.equal(actual.length, expected.length);
    for (const [i, row] of expected.entries()) assert.deepEqual(actual[i], row, `Edit ${i}: ${JSON.stringify(inputs[i])}`);
});
