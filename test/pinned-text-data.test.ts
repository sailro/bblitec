import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { readNativeHostUi } from "../src/native-host-ui.js";
import { readAssetBytesSync } from "../src/compiler/asset-bytes-sync.js";
import { resolveBundledAsset } from "../src/compiler/assets.js";
import { sameCompiledValue } from "../src/compiler/types.js";
import type { CompileManifest } from "../src/compiler/types.js";
import { parseDataUrl } from "../src/data-url.js";
import { importPinnedModule, readPinnedLibraryModule } from "../src/pinned-shader-composer.js";
import { executePinnedText, materializePinnedText, textSha256, type StaticTextLayout, type TextBlob } from "../src/pinned-text-data.js";

const output = resolve("artifacts/test-pinned-text-data");
mkdirSync(output, { recursive: true });
const fileName = resolve(output, "source.ts");
const fontBytes = readAssetBytesSync(resolveBundledAsset("/fonts/Roboto-Regular.ttf"), fileName);
const fontPath = resolve(output, "Roboto-Regular.ttf");
writeFileSync(fontPath, fontBytes);
const program = (body: string) => `import {createEngine,loadFont,createDefaultTextData,createTextRenderable,updateDefaultTextData,onBeforeRender,createSceneContext, type DefaultTextData} from "@babylonjs/lite";
async function main(){ const engine=await createEngine({}); const font=await loadFont("./Roboto-Regular.ttf"); ${body} }`;
const compile = (body: string) => compileSource(program(body), { fileName });

test("static text materialization preserves every pinned initial byte, range and source identity", async () => {
    const compiled = compile(`
        const color: readonly [number,number,number,number]=[242/255,31/255,41/255,1];
        const first=createDefaultTextData(font,180,"A2C",color);
        const alias=first;
        const second=createDefaultTextData(font,180,"A2C",color);
        if(first===second)throw new Error("distinct text identity");
        if(first!==alias)throw new Error("text alias identity");
        function measure(data:DefaultTextData):number{return data.width+data.height;}
        const measured=measure(alias);
        if(measured!==551.654296875)throw new Error("layout");
    `);
    const [first, second] = compiled.manifest.textData!;
    assert.ok(first && second);
    assert.equal(first!.id, 0);
    assert.equal(second!.id, 1);
    assert.equal(first!.width, 335.654296875);
    assert.equal(first!.height, 216);
    assert.equal(first!.font.sha256, "56a45233d29f11b4dfb86d248e921939d115778f87325e7ae8cc108383d6664d");
    assert.deepEqual(first!.instances, second!.instances);
    assert.equal(sameCompiledValue({ kind: "text-data", cpp: "first" }, { kind: "text-data", cpp: "second" }), false);
    assert.equal(sameCompiledValue({ kind: "text-data", cpp: "first" }, { kind: "text-data", cpp: "first" }), true);
    assert.ok(compiled.manifest.features.includes("text:data"));
    assert.match(compiled.cpp, /distinct text identity/);
    assert.doesNotMatch(compiled.cpp, /\(\s*==\s*\)/);
    const raw = (blob: TextBlob): Buffer => {
        const asset = compiled.manifest.assets.find((asset) => asset.output === blob.assetOutput)!;
        const bytes = Buffer.from(parseDataUrl(compiled.assetPayloads!.get(asset.source)!)!.bytes);
        assert.equal(bytes.byteLength, blob.byteLength);
        assert.equal(textSha256(bytes), blob.sha256);
        return bytes;
    };
    const pin = await executePinnedText(fontBytes, first!.layout);
    assert.ok(pin);
    assert.deepEqual(raw(first!.instances.bytes), Buffer.from(pin.instances.bytes, "base64"));
    assert.deepEqual(raw(first!.styles.bytes), Buffer.from(pin.styles.bytes, "base64"));
    for (const [index, atlas] of first!.atlases.entries()) {
        const expected: NonNullable<Awaited<ReturnType<typeof executePinnedText>>>["atlases"][number] = pin.atlases[index]!;
        assert.deepEqual(raw(atlas.curves.bytes), Buffer.from(expected.curves.bytes, "base64"));
        assert.deepEqual(raw(atlas.bands.bytes), Buffer.from(expected.bands.bytes, "base64"));
        assert.deepEqual(raw(atlas.metadata.bytes), Buffer.from(expected.metadata.bytes, "base64"));
        assert.ok(atlas.curves.bytes.byteLength > atlas.curves.usedTexels * 16);
        assert.ok(atlas.metadata.capacityBytes >= atlas.metadata.bytes.byteLength);
    }
    assert.ok(first!.provenance.modules.some((entry) => entry.path.startsWith("_chunks/vendor/text-shaper")));
    for (const module of first!.provenance.modules) assert.equal(module.sha256, textSha256(readPinnedLibraryModule(module.path)));
    assert.deepEqual(first!.provenance, second!.provenance);
});

test("static options and complex text use actual pin layout and raw mixed instance words", async () => {
    const { createFontFromBuffer } = await importPinnedModule<{ createFontFromBuffer(bytes: ArrayBuffer): unknown }>("text/font.js");
    const { createDefaultTextData } = await importPinnedModule<{ createDefaultTextData(font: unknown, size: number, text: string, color: readonly number[] | undefined, options: StaticTextLayout["options"]): {
        width: number; height: number; _instances: Float32Array; _instancesU32: Uint32Array; _instanceCount: number;
    } }>("text/default-text-data.js");
    const font = createFontFromBuffer(Uint8Array.from(fontBytes).buffer);
    for (const layout of [
        { fontSizePx: 48, text: "AV office\nGreek Ω\twrap words", options: { maxWidth: 140, align: "center" as const, letterSpacing: 3, lineHeight: 1.4, tabSize: 2 } },
        { fontSizePx: 31, text: "" },
    ]) {
        const expected = createDefaultTextData(font, layout.fontSizePx, layout.text, undefined, layout.options);
        const actual = materializePinnedText(fontBytes, layout)!;
        assert.equal(actual.width, expected.width);
        assert.equal(actual.height, expected.height);
        assert.equal(actual.instances.count, expected._instanceCount);
        assert.deepEqual(Buffer.from(actual.instances.bytes, "base64"), Buffer.from(expected._instancesU32.buffer, expected._instancesU32.byteOffset, actual.instances.count * actual.instances.strideBytes));
    }
    const compiled = compile(`const data=createDefaultTextData(font,48,"AV office",undefined,{maxWidth:140,align:"right",letterSpacing:3,lineHeight:1.4,tabSize:2});`);
    assert.deepEqual(compiled.manifest.textData![0]!.layout.options, { maxWidth: 140, align: "right", letterSpacing: 3, lineHeight: 1.4, tabSize: 2 });
});

test("static text arguments and font content participate in provenance", () => {
    const first = materializePinnedText(fontBytes, { fontSizePx: 40, text: "A" })!;
    const changed = materializePinnedText(fontBytes, { fontSizePx: 41, text: "A" })!;
    assert.notEqual(first.provenance.argumentsSha256, changed.provenance.argumentsSha256);
    assert.notEqual(first.styles.bytes, changed.styles.bytes);
    const paddedFont = new Uint8Array(fontBytes.length + 4);
    paddedFont.set(fontBytes);
    const changedFont = materializePinnedText(paddedFont, { fontSizePx: 40, text: "A" })!;
    assert.notEqual(first.provenance.argumentsSha256, changedFont.provenance.argumentsSha256);
    assert.equal(first.instances.bytes, changedFont.instances.bytes);
    assert.throws(() => materializePinnedText(new Uint8Array(16)), /Pinned static font\/text data/);
    writeFileSync(resolve(output, "bad.ttf"), new Uint8Array(16));
    assert.throws(() => compileSource(program("").replace("Roboto-Regular.ttf", "bad.ttf"), { fileName }), /Pinned font materialization failed/);
});

test("ordinary CLI asset packaging writes the font and every referenced text blob exactly", () => {
    const source = program(`const data=createDefaultTextData(font,40,"AV");if(data.width<=0)throw new Error("width");`);
    writeFileSync(fileName, source);
    const generated = resolve(output, "generated");
    execFileSync(process.execPath, [resolve("dist/src/cli.js"), fileName, "--out", generated], { encoding: "utf8", timeout: 90_000, stdio: "pipe" });
    const manifest = JSON.parse(readFileSync(resolve(generated, "manifest.json"), "utf8")) as CompileManifest;
    const row = manifest.textData![0]!;
    assert.equal(textSha256(readFileSync(resolve(generated, "assets", row.font.assetOutput))), row.font.sha256);
    const blobs = [row.instances.bytes, row.styles.bytes, ...row.atlases.flatMap((atlas) => [atlas.curves.bytes, atlas.bands.bytes, atlas.metadata.bytes])];
    for (const blob of blobs) {
        const bytes = readFileSync(resolve(generated, "assets", blob.assetOutput));
        assert.equal(bytes.length, blob.byteLength);
        assert.equal(textSha256(bytes), blob.sha256);
    }
    assert.ok(manifest.inputs.some((input) => input.endsWith("Roboto-Regular.ttf")));
});

test("dynamic fonts, layout options and internal writes retain explicit source refusals", () => {
    for (const [body, refusal] of [
        [`const data=createDefaultTextData(font,Math.random()*40,"A");`, /Text font size must be a static number/],
        [`const scene=createSceneContext(engine); onBeforeRender(scene,()=>{const data=createDefaultTextData(font,40,"A");});`, /definite initialization/],
        [`const data=createDefaultTextData(font,40,"A",undefined,{maxWidth:Math.random()});`, /Text layout maxWidth must be a static number/],
        [`const color:[number,number,number,number]=[1,0,0,1];const alias=color;alias[0]=Math.random();createDefaultTextData(font,40,"A",color);`, /mutated or dynamic arrays/],
        [`const options={lineHeight:1.2};const alias=options;alias.lineHeight=Math.random();createDefaultTextData(font,40,"A",undefined,options);`, /direct static object literal/],
        [`createDefaultTextData(font,-0,"A");`, /not negative zero/],
        [`const data=createDefaultTextData(font,40,"A");data.width=3;`, /read-only|replacement/],
    ] as const) assert.throws(() => compile(body), refusal);
    const source = "corpus/babylon-lite/lab/lite/src/lite/scene275.ts";
    const exact = compileSource(readFileSync(source, "utf8"), { fileName: source });
    assert.ok(exact.manifest.features.includes("text:renderable"));
    assert.equal(exact.manifest.textData!.length, 2);
});

test("runtime text values and updates retain live fonts and unchanged textarea callbacks", () => {
    const dynamic=compile('const data=createDefaultTextData(font,40,String(Math.random()));updateDefaultTextData(data,"new text");');
    assert(dynamic.manifest.features.includes("text:layout"));
    assert(dynamic.manifest.textData![0]!.live!.glyphSlots.length>100);
    assert.match(dynamic.cpp,/create_live_text_data/);
    assert.match(dynamic.cpp,/update_default_text_data/);
    const later = compile('const first=createDefaultTextData(font,40,"A");updateDefaultTextData(first,String(Math.random()));const later=createDefaultTextData(font,40,"B");');
    assert(later.manifest.textData!.every(row => row.live), "Later owners remain eligible for retained update helpers");
    const fileName="corpus/babylon-lite/lab/lite/src/lite/scene181.ts";
    const result=compileSource(readFileSync(fileName,"utf8"),{fileName,nativeHostUi:readNativeHostUi("ui/scene181-host.json")});
    assert(result.manifest.features.includes("text:layout"));
    assert(result.manifest.features.includes("ui:rml"));
    assert.match(result.cpp,/ui_on_event[\s\S]*"input"/);
    assert.match(result.cpp,/ui_get_form_value/);
    assert.match(result.cpp,/attach_control/);
});
