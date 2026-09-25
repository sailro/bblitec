import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { prepareAssetDecoders } from "../src/asset-decoders.js";
import { compileSource } from "../src/compiler.js";
import { resolveGlbGeometry } from "../src/compressed-geometry.js";
import { transcodeKtx2Texture } from "../src/basis-transcode.js";
import { resolveBrowserPath } from "../src/browser-path.js";

test("decoder setup preserves application locations for packaging", () => {
    const directory = resolve("artifacts/decoder-configuration/public");
    const result = compileSource(
        `
        import {setKtx2DecoderUrl,setDracoBaseUrl} from "@babylonjs/lite";
        setKtx2DecoderUrl("/decoders/ktx2.js", {
            MSCTranscoder:{JSModuleURL:"/decoders/basis.js",WasmModuleURL:"/decoders/basis.wasm"},
            ZSTDDecoder:{WasmModuleURL:"/decoders/zstd.wasm"}
        });
        setDracoBaseUrl("/decoders/draco");
    `,
        { publicDir: directory },
    );
    assert.deepEqual(result.manifest.assetDecoders, {
        ktx2: {
            javascript: resolve(directory, "decoders/ktx2.js"),
            wasmUrls: {
                MSCTranscoder: {
                    JSModuleURL: resolve(directory, "decoders/basis.js"),
                    WasmModuleURL: resolve(directory, "decoders/basis.wasm"),
                },
                ZSTDDecoder: {
                    WasmModuleURL: resolve(directory, "decoders/zstd.wasm"),
                },
            },
        },
        draco: {
            javascript: resolve(directory, "decoders/draco/draco_decoder.js"),
            wasm: resolve(directory, "decoders/draco/draco_decoder.wasm"),
        },
    });
    assert.equal(
        result.manifest.assets.length,
        0,
        "configuration alone does not load or package a decoder",
    );
});

test("decoder setup refuses runtime selection and retained mutable overrides", () => {
    const imports =
        'import {setKtx2DecoderUrl,setDracoBaseUrl} from "@babylonjs/lite";';
    const deployment = { publicUrl: "https://cdn.example.invalid/" };
    assert.throws(
        () =>
            compileSource(
                imports + 'if(Math.random()>0.5)setDracoBaseUrl("/chosen/");',
                deployment,
            ),
        /definite setup/,
    );
    assert.throws(
        () =>
            compileSource(
                imports +
                    `
        const urls={ZSTDDecoder:{WasmModuleURL:"/first.wasm"}};
        setKtx2DecoderUrl("/decoder.js",urls);
        urls.ZSTDDecoder.WasmModuleURL="/later.wasm";
    `,
                deployment,
            ),
        /fresh object literals/,
    );
});

test("module URL provenance survives nested decoder bootstrap helpers", () => {
    const publicDir = resolve("artifacts/decoder-configuration/public");
    const result = compileSource(
        `
        import {setDracoBaseUrl, setMeshoptBaseUrl} from "@babylonjs/lite";
        function asset(path: string, moduleUrl: string): string {
            const url = new URL(path, moduleUrl);
            return url.href;
        }
        function setup(moduleUrl: string): void {
            const base = asset("./decoders/", moduleUrl);
            setDracoBaseUrl(base);
            setMeshoptBaseUrl(base);
        }
        setup(import.meta.url);
    `,
        { publicDir },
    );
    assert.deepEqual(result.manifest.assetDecoders, {
        draco: {
            javascript: resolve(publicDir, "decoders/draco_decoder.js"),
            wasm: resolve(publicDir, "decoders/draco_decoder.wasm"),
        },
        meshopt: {
            javascript: resolve(publicDir, "decoders/meshopt_decoder.js"),
        },
    });
});

test("meshopt packaging isolates configured decoders across concurrent assets", async () => {
    const input = () => ({
        json: {
            asset: { version: "2.0" },
            extensionsUsed: ["EXT_meshopt_compression"],
            buffers: [{ byteLength: 4 }],
            bufferViews: [
                {
                    buffer: 0,
                    byteLength: 4,
                    extensions: {
                        EXT_meshopt_compression: {
                            buffer: 0,
                            byteOffset: 0,
                            byteLength: 4,
                            byteStride: 1,
                            count: 4,
                            mode: "ATTRIBUTES",
                        },
                    },
                },
            ],
        },
        binary: Buffer.alloc(4),
    });
    const decode = async (value: number) => {
        const glb = input();
        const decoders = prepareAssetDecoders(
            { meshopt: { javascript: "decoder.js" } },
            async () =>
                new TextEncoder().encode(
                    `globalThis.MeshoptDecoder={ready:Promise.resolve(),decodeGltfBuffer(target){target.fill(${value});}};`,
                ),
        );
        assert.equal(
            await resolveGlbGeometry(glb, "configured meshopt", decoders),
            true,
        );
        return [...glb.binary];
    };
    assert.deepEqual(await Promise.all([decode(3), decode(7), decode(3)]), [
        [3, 3, 3, 3],
        [7, 7, 7, 7],
        [3, 3, 3, 3],
    ]);
    await assert.rejects(
        resolveGlbGeometry(input(), "invalid decoder", {
            meshopt: async () =>
                new TextEncoder().encode("globalThis.MeshoptDecoder={};"),
        }),
        /did not define MeshoptDecoder/,
    );
});

test("loaded assets retain their realm's decoder setup and refuse later changes", () => {
    const program = (later: string) => `
        import {createEngine,loadGltf,setDracoBaseUrl} from "@babylonjs/lite";
        async function main(){
            setDracoBaseUrl("https://example.test/draco/");
            const engine=await createEngine({});
            await loadGltf(engine,"https://example.test/model.glb");
            ${later}
        }
        void main();`;
    const result = compileSource(program(""));
    assert.doesNotThrow(() =>
        compileSource(
            program('setDracoBaseUrl("https://example.test/draco/");'),
        ),
    );
    assert.deepEqual(
        result.manifest.assets.find((asset) => asset.kind === "gltf")!
            .assetDecoders,
        {
            draco: {
                javascript: "https://example.test/draco/draco_decoder.js",
                wasm: "https://example.test/draco/draco_decoder.wasm",
            },
        },
    );
    assert.throws(
        () =>
            compileSource(
                program('setDracoBaseUrl("https://example.test/other/");'),
            ),
        /before compressed asset loads/,
    );
});

test("configured decoder resources are lazy, deduplicated and retry failed reads", async () => {
    const reads: string[] = [];
    let failing = true;
    const decoders = prepareAssetDecoders(
        {
            ktx2: {
                javascript: "https://example.test/decoder.js?v=1",
                wasmUrls: {
                    First: { WasmModuleURL: "shared.wasm" },
                    Second: { WasmModuleURL: "shared.wasm" },
                },
            },
            draco: { javascript: "draco.js", wasm: "draco.wasm" },
        },
        async (source) => {
            reads.push(source);
            if (source === "draco.wasm" && failing)
                throw new Error("temporary read failure");
            return new TextEncoder().encode(source);
        },
    );
    assert.deepEqual(reads, []);
    const [first, second] = await Promise.all([
        decoders.ktx2!(),
        decoders.ktx2!(),
    ]);
    assert.equal(first, second);
    assert.match(first.url, /\/decoder\.js$/);
    assert.equal(
        first.wasmUrls!.First!.WasmModuleURL,
        first.wasmUrls!.Second!.WasmModuleURL,
    );
    assert.deepEqual(
        reads.sort(),
        ["https://example.test/decoder.js?v=1", "shared.wasm"].sort(),
    );
    await assert.rejects(decoders.draco!(), /temporary read failure/);
    failing = false;
    const loaded = await decoders.draco!();
    assert.equal(new TextDecoder().decode(loaded.wasm), "draco.wasm");
});

test("Draco packaging executes the supplied decoder and keeps configurations separate", async () => {
    const input = () => ({
        json: {
            asset: { version: "2.0" },
            extensionsUsed: ["KHR_draco_mesh_compression"],
            buffers: [{ byteLength: 4 }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
            meshes: [
                {
                    primitives: [
                        {
                            attributes: {},
                            extensions: {
                                KHR_draco_mesh_compression: {
                                    bufferView: 0,
                                    attributes: {},
                                },
                            },
                        },
                    ],
                },
            ],
        },
        binary: Buffer.alloc(4),
    });
    const make = (value: number) =>
        prepareAssetDecoders(
            { draco: { javascript: "decoder.js", wasm: "decoder.wasm" } },
            async (source) =>
                source.endsWith(".js")
                    ? new TextEncoder().encode(
                          'globalThis.DracoDecoderModule=async options=>{throw new Error("configured decoder "+options.wasmBinary[0]);};',
                      )
                    : new Uint8Array([value]),
        );
    await assert.rejects(
        resolveGlbGeometry(input(), "first", make(3)),
        /configured decoder 3/,
    );
    await assert.rejects(
        resolveGlbGeometry(input(), "second", make(7)),
        /configured decoder 7/,
    );
    let reads = 0;
    await resolveGlbGeometry(
        { json: { asset: { version: "2.0" } }, binary: Buffer.alloc(0) },
        "plain",
        {
            draco: async () => {
                reads++;
                throw new Error("unused decoder");
            },
        },
    );
    assert.equal(reads, 0);
});

test("KTX2 packaging applies supplied decoder URLs and invalidates cached decoder bytes", async (t) => {
    try {
        resolveBrowserPath();
    } catch {
        t.skip("Chromium is unavailable.");
        return;
    }
    const javascript = new TextEncoder().encode(`globalThis.KTX2DECODER={
        MSCTranscoder:{},WASMMemoryManager:{},Palette:{},
        KTX2Decoder:class {async decode(){
            const bytes=new Uint8Array(await(await fetch(globalThis.KTX2DECODER.Palette.WasmModuleURL)).arrayBuffer());
            return {transcodedFormat:32856,mipmaps:[{width:1,height:1,data:new Uint8Array([bytes[0],0,0,255])}]};
        }}
    };`);
    const transcode = async (red: number) => {
        const decoders = prepareAssetDecoders(
            {
                ktx2: {
                    javascript: "decoder.js",
                    wasmUrls: { Palette: { WasmModuleURL: "palette.wasm" } },
                },
            },
            async (source) =>
                source.endsWith(".js") ? javascript : new Uint8Array([red]),
        );
        return transcodeKtx2Texture(
            "fixture.ktx2",
            new Uint8Array([1, 2, 3]),
            await decoders.ktx2!(),
        );
    };
    const first = await transcode(3),
        second = await transcode(7);
    assert.equal(first.gpuFormat, "rgba8unorm");
    assert.deepEqual([...first.mips[0]!.bytes], [3, 0, 0, 255]);
    assert.deepEqual([...second.mips[0]!.bytes], [7, 0, 0, 255]);
});
