import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { jsonArray } from "./json.js";
import {
    compiledTextDataSource,
    TextDataUpdateLowerer,
    textRecordsHeader,
} from "../src/lowering/text-data-update-lowerer.js";
import { TextLayoutLowerer } from "../src/lowering/text-layout-lowerer.js";
import { TextLowerer } from "../src/lowering/text-lowerer.js";
import { TextWeightLowerer } from "../src/lowering/text-weight-lowerer.js";
import { TextRendererLowerer } from "../src/lowering/text-renderer-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { textRecordModel } from "../src/lowering/text-records.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { materializePinnedText } from "../src/pinned-text-data.js";
import { pinnedLabPublicUrl } from "../src/pinned-lab-public.js";
import { readAssetBytesSync } from "../src/compiler/asset-bytes-sync.js";
import { doctoredContext } from "./doctored-store.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";
import { stringLiteral } from "../src/cpp-literals.js";

const changed = doctoredContext;

test("text data bodies are lowered from the pin's own statements", () => {
    // A changed pinned statement is a changed native statement.
    assert.match(
        new TextDataUpdateLowerer(
            changed(
                "src/text/text-data.ts",
                "data._instances.length * 2",
                "data._instances.length * 3",
            ),
        ).header(),
        /data->instances\.size\(\)\) \* 3\.0/,
    );
    assert.match(
        new TextDataUpdateLowerer(
            changed(
                "src/text/default-text-data.ts",
                "height: laid._height",
                "height: laid._height + 1",
            ),
        ).header(),
        /->height = \(laid\.height \+ 1\.0\)/,
    );
    assert.match(
        new TextWeightLowerer(
            changed(
                "src/text/set-font-weight-offset.ts",
                "MAX_WEIGHT_OFFSET = 100",
                "MAX_WEIGHT_OFFSET = 120",
            ),
        ).header(),
        /\(120\.0\)/,
    );
    // The layout options' defaults are the pin's own `??` operands.
    assert.match(
        new TextLayoutLowerer(
            changed(
                "src/text/layout.ts",
                "options?.lineHeight ?? 1.2",
                "options?.lineHeight ?? 1.5",
            ),
        ).header(),
        /line_height : std::nullopt\), \[&\]\(\) -> double \{ return 1\.5; \}\)/,
    );
    // A local only an adapted platform call reads keeps its declaration
    // (its initializer's effects are the pin's) and may be unread.
    const unread = /\[\[maybe_unused\]\] [^\n]* ids = /;
    assert.doesNotMatch(
        new TextDataUpdateLowerer(new LoweringContext()).header(),
        unread,
    );
    assert.match(
        new TextDataUpdateLowerer(
            changed(
                "src/text/default-text-data.ts",
                "if (ids) {",
                "if (text) {",
            ),
        ).header(),
        unread,
    );
    // A construct the record model has no native form for refuses by name.
    assert.throws(
        () =>
            new TextDataUpdateLowerer(
                changed(
                    "src/text/text-data.ts",
                    "const needed = Math.max(0,",
                    "const probe = Symbol(); const needed = Math.max(0,",
                ),
            ).header(),
        /text-data\.ts:\d+:\d+/,
    );
    // The layer and renderer factories are the pin's own statements.
    assert.match(
        new TextRendererLowerer(
            changed(
                "src/text/text-renderer.ts",
                "_version: 0,",
                "_version: 1,",
            ),
        ).header(),
        /->version = 1\.0; return record_\d+; \}\(\);/,
    );
    assert.match(
        new TextRendererLowerer(
            changed(
                "src/text/text-renderer.ts",
                "opts.layers.slice()",
                "opts.layers",
            ),
        ).header(),
        /bbl::js::Array<bbl::TextLayer> layers = opts\.layers;/,
    );
});

interface PinnedGroup {
    _groupKey: unknown;
    _slotStart: number;
    _slotCount: number;
    _liveCount: number;
    _freeSlots: number[];
    _curveSet: { _atlas: { _glyphSlots: Map<number, { _index: number }> } };
}
interface PinnedRun {
    defaultColor?: readonly number[];
}
interface PinnedData {
    width: number;
    height: number;
    _instanceCount: number;
    _styleCount: number;
    _version: number;
    _styleVersion: number;
    _layoutVersion: number;
    _dirtyStart: number;
    _dirtyEnd: number;
    _instances: Float32Array;
    _instancesU32: Uint32Array;
    _styles: Float32Array;
    _freeStyleSlots: number[];
    runs: PinnedRun[];
    _runRecords: Map<
        object,
        { _groupIdx: number; _slots: number[]; _styleSlots: number[] }
    >;
    _groups: PinnedGroup[];
}

test("lowered text data matches the pin through run, group and palette edits", async (t) => {
    const tools = optionalNativeFixtureTools();
    const hb = resolve(nativeFixtureVcpkgRoot, "lib/harfbuzz.lib");
    if (!tools || !existsSync(hb)) {
        t.skip("Native HarfBuzz fixture dependency unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-text-update");
    mkdirSync(resolve(directory, "bblite"), { recursive: true });
    const bytes = readAssetBytesSync(
        `${pinnedLabPublicUrl()}fonts/Inter.ttf`,
        resolve(directory, "source.ts"),
    );
    writeFileSync(resolve(directory, "font.ttf"), bytes);
    const c = new LoweringContext();
    for (const [name, header] of [
        ["upstream_text_records.hpp", textRecordsHeader(c)],
        ["upstream_text.hpp", new TextLowerer(c).header()],
        ["upstream_text_layout.hpp", new TextLayoutLowerer(c).header()],
        ["upstream_text_update.hpp", new TextDataUpdateLowerer(c).header()],
        ["upstream_text_weight.hpp", new TextWeightLowerer(c).header()],
    ] as const)
        writeFileSync(resolve(directory, "bblite", name), header);
    const model = textRecordModel(c);
    const baked = materializePinnedText(
        bytes,
        { live: true, text: "", fontSizePx: 48 },
        model.transportSchema(),
    );
    assert(baked?.repertoire);
    const repertoire = baked.repertoire;
    for (const [index, base64] of repertoire.storage.buffers.entries())
        writeFileSync(
            resolve(directory, `buffer-${index}.bin`),
            Buffer.from(base64, "base64"),
        );
    const storage = model.transportCpp(
        { ...repertoire.storage, buffers: [] },
        { kind: "record", name: "GlyphStorage" },
        (index) => `buffer(${index})`,
    );
    // The generated source for a live row stays well formed.
    assert.match(
        compiledTextDataSource(
            c,
            [
                {
                    id: 0,
                    font: {
                        source: "font.ttf",
                        assetOutput: "font.ttf",
                        sha256: "",
                    },
                    layout: { live: true, text: "", fontSizePx: 48 },
                    provenance: baked.provenance,
                    repertoire,
                    buffers: repertoire.storage.buffers.map((_, index) => ({
                        assetOutput: `buffer-${index}.bin`,
                        sha256: "",
                        byteLength: 0,
                    })),
                },
            ],
            true,
        ),
        /bbl::create_default_text_data\(font, 48\.0, std::move\(text\)/,
    );

    const { createFontFromBuffer } = await importPinnedModule<{
        createFontFromBuffer(this: void, bytes: ArrayBuffer): unknown;
    }>("text/font.js");
    const { createDefaultTextData, updateDefaultTextData } =
        await importPinnedModule<{
            createDefaultTextData(
                this: void,
                font: unknown,
                size: number,
                text: string,
                color: undefined,
                options: { maxWidth: number },
            ): PinnedData;
            updateDefaultTextData(
                this: void,
                data: PinnedData,
                text: string,
                color?: readonly number[],
            ): void;
        }>("text/default-text-data.js");
    const { updateTextData } = await importPinnedModule<{
        updateTextData(this: void, data: PinnedData, operation: unknown): void;
    }>("text/text-data.js");
    const { setFontWeightOffset } = await importPinnedModule<{
        setFontWeightOffset(
            this: void,
            data: PinnedData,
            run: number | object,
            offset: number,
        ): void;
    }>("text/set-font-weight-offset.js");
    const font = createFontFromBuffer(Uint8Array.from(bytes).buffer);
    let data: PinnedData | undefined;
    // Glyph indices name atlas slots, which the pin assigns in order of first
    // use and the packaged repertoire in glyph order; both are compared as
    // the glyph ids they stand for.
    const observe = () => {
        assert(data);
        const d = data;
        const glyphOf = (slot: number): number => {
            for (const group of d._groups)
                for (const [id, entry] of group._curveSet._atlas._glyphSlots)
                    if (entry._index === slot) return id;
            return -1;
        };
        const instances: (number | null)[] = [];
        for (let i = 0; i < d._instanceCount; i++) {
            const word = d._instancesU32[i * 3 + 2]!;
            instances.push(
                d._instances[i * 3]!,
                d._instances[i * 3 + 1]!,
                ...(word === 0xffffffff
                    ? [null, null]
                    : [glyphOf(word & 0xffff), word >>> 16]),
            );
        }
        return {
            width: d.width,
            height: d.height,
            instances,
            styles: Array.from(
                new Uint32Array(
                    d._styles.buffer,
                    d._styles.byteOffset,
                    d._styles.length,
                ),
            ),
            capacity: d._instances.length,
            count: d._instanceCount,
            styleCount: d._styleCount,
            freeStyles: d._freeStyleSlots.slice(),
            version: d._version,
            styleVersion: d._styleVersion,
            layoutVersion: d._layoutVersion,
            dirty: [d._dirtyStart, d._dirtyEnd],
            runs: d.runs.map((run) => {
                const record = d._runRecords.get(run)!;
                // Snapshots: later edits shift these arrays in place.
                return [
                    record._groupIdx,
                    record._slots.slice(),
                    record._styleSlots.slice(),
                ];
            }),
            groups: d._groups.map((group) => [
                group._slotStart,
                group._slotCount,
                group._liveCount,
                group._freeSlots.slice(),
                typeof group._groupKey !== "string",
            ]),
        };
    };
    const expected: ReturnType<typeof observe>[] = [];
    const actions: string[] = [];
    const act = (cpp: string, action: () => void) => {
        if (data) data._dirtyStart = data._dirtyEnd = 0;
        action();
        expected.push(observe());
        actions.push(
            `if(data){data->dirty_start=0;data->dirty_end=0;}\n    ${cpp};\n    record();`,
        );
    };
    const color = (values: readonly number[]) =>
        `bbl::js::Tuple<4>{${values.map((value) => value.toFixed(3)).join(",")}}`;
    const copy = (index: number, values: readonly number[]) =>
        `[&]{auto r=std::make_shared<bbl::GlyphRun>(*data->runs[${index}]);r->default_color=${color(values)};return r;}()`;
    const update = (fields: string) =>
        `bbl::update_text_data(data,[&]{bbl::TextDataUpdate u;${fields};return u;}())`;
    for (const [index, text] of [
        "Type here...",
        "Type here...",
        "A",
        "New ffi text Ω Ж",
        "",
        "   ",
        "AV é Résumé",
        "office\nA\tB",
        "This line wraps after multiple words and changes the allocation",
        "𝄞 x 😀",
    ].entries())
        act(
            index === 0
                ? `data=bbl::create_default_text_data(font,48,${stringLiteral(text)},std::nullopt,bbl::TextLayoutOptions{.max_width=220.0})`
                : `bbl::update_default_text_data(data,${stringLiteral(text)})`,
            () => {
                if (data) updateDefaultTextData(data, text);
                else
                    data = createDefaultTextData(font, 48, text, undefined, {
                        maxWidth: 220,
                    });
            },
        );
    const pinnedCopy = (index: number, values: readonly number[]) => ({
        ...data!.runs[index]!,
        defaultColor: values,
    });
    act(
        `bbl::update_default_text_data(data,"AV ffi",${color([0.2, 0.4, 0.6, 1])})`,
        () => updateDefaultTextData(data!, "AV ffi", [0.2, 0.4, 0.6, 1]),
    );
    // Several runs in one group: add, insert before, replace by index.
    act(update(`u.update="addRun";u.run=${copy(0, [1, 0, 0, 1])}`), () =>
        updateTextData(data!, {
            update: "addRun",
            run: pinnedCopy(0, [1, 0, 0, 1]),
        }),
    );
    act(
        update(
            `u.update="addRun";u.run=${copy(1, [0, 1, 0, 1])};u.insert_before=0.0`,
        ),
        () =>
            updateTextData(data!, {
                update: "addRun",
                run: pinnedCopy(1, [0, 1, 0, 1]),
                insertBefore: 0,
            }),
    );
    act(
        update(
            `u.update="replaceRun";u.previous=bbl::TextRunRef{1.0};u.run=${copy(2, [0, 0, 1, 1])}`,
        ),
        () =>
            updateTextData(data!, {
                update: "replaceRun",
                previous: 1,
                run: pinnedCopy(2, [0, 0, 1, 1]),
            }),
    );
    // A weighted run is its own draw group; others keep theirs.
    for (const offset of [20, 20, 35])
        act(
            `bbl::set_font_weight_offset(data,bbl::TextRunRef{1.0},${offset})`,
            () => setFontWeightOffset(data!, 1, offset),
        );
    act(update(`u.update="removeRun";u.run=bbl::TextRunRef{0.0}`), () =>
        updateTextData(data!, { update: "removeRun", run: 0 }),
    );
    act(
        update(
            `u.update="reset";u.runs=bbl::js::Array<bbl::TextRun>{data->runs[1],data->runs[0]}`,
        ),
        () =>
            updateTextData(data!, {
                update: "reset",
                runs: [data!.runs[1]!, data!.runs[0]!],
            }),
    );
    act(
        update(`u.update="removeRun";u.run=bbl::TextRunRef{data->runs[0]}`),
        () =>
            updateTextData(data!, { update: "removeRun", run: data!.runs[0]! }),
    );
    act(update(`u.update="reset"`), () =>
        updateTextData(data!, { update: "reset" }),
    );
    act(`bbl::set_font_weight_offset(data,bbl::TextRunRef{0.0},0)`, () =>
        setFontWeightOffset(data!, 0, 0),
    );
    act(
        `bbl::update_default_text_data(data,"Another wrapped line of text")`,
        () => updateDefaultTextData(data!, "Another wrapped line of text"),
    );
    act(`bbl::update_default_text_data(data,"")`, () =>
        updateDefaultTextData(data!, ""),
    );
    const source = resolve(directory, "check.cpp"),
        executable = resolve(directory, "check.exe");
    writeFileSync(
        source,
        `#include <bblite/upstream_text_weight.hpp>
#include ${stringLiteral(resolve("native/src/pal_text_layout.cpp").replaceAll("\\", "/"))}
#include <nlohmann/json.hpp>
#include <fstream>
#include <iterator>
std::vector<std::uint8_t> read(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(file), {}};
}
bbl::js::ArrayBuffer buffer(int index) {
    static std::map<int, bbl::js::ArrayBuffer> buffers;
    auto found = buffers.find(index);
    if (found == buffers.end())
        found = buffers.emplace(index, bbl::js::ArrayBuffer(read("buffer-" + std::to_string(index) + ".bin"))).first;
    return found->second;
}
double glyph_of(const bbl::TextData& data, double slot) {
    for (const auto& group : data->groups)
        for (const auto& entry : group->curve_set->atlas->glyph_slots)
            if (entry.second.index == slot) return entry.first;
    return -1;
}
int main() {
    auto font = bbl::pal::create_text_layout_font(read("font.ttf"));
    font->curve_set_id = ${stringLiteral(repertoire.curveSetId)};
    font->packaged_storage = [] { return ${storage.replaceAll("\n", "\n    ")}; };
    nlohmann::json output = nlohmann::json::array();
    bbl::TextData data;
    const auto record = [&] {
        nlohmann::json instances = nlohmann::json::array();
        for (std::size_t i = 0; i < static_cast<std::size_t>(data->instance_count); ++i) {
            const auto word = data->instances_u32.load(i * 3 + 2);
            instances.push_back(data->instances.load(i * 3));
            instances.push_back(data->instances.load(i * 3 + 1));
            if (word == 0xffffffffu) { instances.push_back(nullptr); instances.push_back(nullptr); }
            else { instances.push_back(glyph_of(data, word & 0xffffu)); instances.push_back(word >> 16); }
        }
        std::vector<std::uint32_t> styles(data->styles.size());
        if (!styles.empty()) std::memcpy(styles.data(), data->styles.buffer().data() + data->styles.byte_offset(), styles.size() * 4);
        nlohmann::json runs = nlohmann::json::array();
        for (const auto& run : data->runs) {
            const auto rec = bbl::pinned::map_get(data->run_records, run);
            runs.push_back({rec->group_idx, std::vector<double>(rec->slots.begin(), rec->slots.end()), std::vector<double>(rec->style_slots.begin(), rec->style_slots.end())});
        }
        nlohmann::json groups = nlohmann::json::array();
        for (const auto& group : data->groups)
            groups.push_back({group->slot_start, group->slot_count, group->live_count, std::vector<double>(group->free_slots.begin(), group->free_slots.end()), static_cast<bool>(group->group_key.object)});
        output.push_back({{"width", data->width}, {"height", data->height}, {"instances", instances}, {"styles", styles},
            {"capacity", data->instances.size()}, {"count", data->instance_count}, {"styleCount", data->style_count},
            {"freeStyles", std::vector<double>(data->free_style_slots.begin(), data->free_style_slots.end())},
            {"version", data->version}, {"styleVersion", data->style_version}, {"layoutVersion", data->layout_version},
            {"dirty", std::array{data->dirty_start, data->dirty_end}}, {"runs", runs}, {"groups", groups}});
    };
    ${actions.join("\n    ")}
    std::ofstream("actual.json") << output;
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/EHsc",
        "/W4",
        "/WX",
        "/bigobj",
        "/utf-8",
        "/fp:strict",
        "/DBBLITE_HAS_TEXT=1",
        `/I${directory}`,
        `/I${resolve("native/include")}`,
        `/I${resolve(nativeFixtureVcpkgRoot, "include")}`,
        `/I${resolve(nativeFixtureVcpkgRoot, "include/harfbuzz")}`,
        source,
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${executable}`,
        "/link",
        hb,
    ]);
    execFileSync(executable, [], {
        cwd: directory,
        env: {
            ...process.env,
            PATH: `${resolve(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH}`,
        },
        stdio: "pipe",
    });
    const actual = jsonArray(
        JSON.parse(readFileSync(resolve(directory, "actual.json"), "utf8")),
    );
    assert.equal(actual.length, expected.length);
    for (const [i, row] of expected.entries())
        assert.deepEqual(
            actual[i],
            JSON.parse(JSON.stringify(row)),
            `Step ${i}: ${actions[i]}`,
        );
});
