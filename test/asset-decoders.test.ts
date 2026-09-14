import assert from "node:assert/strict";
import {resolve} from "node:path";
import test from "node:test";
import {prepareAssetDecoders} from "../src/asset-decoders.js";
import {compileSource} from "../src/compiler.js";
import {resolveGlbGeometry} from "../src/compressed-geometry.js";
import {transcodeKtx2Texture} from "../src/basis-transcode.js";
import {resolveBrowserPath} from "../src/browser-path.js";

test("decoder setup preserves application locations for packaging", () => {
    const directory = resolve("artifacts/decoder-configuration/public");
    const result = compileSource(`
        import {setKtx2DecoderUrl,setDracoBaseUrl} from "@babylonjs/lite";
        setKtx2DecoderUrl("/decoders/ktx2.js", {
            MSCTranscoder:{JSModuleURL:"/decoders/basis.js",WasmModuleURL:"/decoders/basis.wasm"},
            ZSTDDecoder:{WasmModuleURL:"/decoders/zstd.wasm"}
        });
        setDracoBaseUrl("/decoders/draco");
    `, {publicDir: directory});
    assert.deepEqual(result.manifest.assetDecoders, {
        ktx2:{javascript:resolve(directory,"decoders/ktx2.js"),wasmUrls:{
            MSCTranscoder:{JSModuleURL:resolve(directory,"decoders/basis.js"),WasmModuleURL:resolve(directory,"decoders/basis.wasm")},
            ZSTDDecoder:{WasmModuleURL:resolve(directory,"decoders/zstd.wasm")},
        }},
        draco:{javascript:resolve(directory,"decoders/draco/draco_decoder.js"),wasm:resolve(directory,"decoders/draco/draco_decoder.wasm")},
    });
    assert.equal(result.manifest.assets.length, 0, "configuration alone does not load or package a decoder");
});

test("decoder setup refuses runtime selection and retained mutable overrides", () => {
    const imports = 'import {setKtx2DecoderUrl,setDracoBaseUrl} from "@babylonjs/lite";';
    assert.throws(() => compileSource(imports+'if(Math.random()>0.5)setDracoBaseUrl("/chosen/");'), /definite setup/);
    assert.throws(() => compileSource(imports+`
        const urls={ZSTDDecoder:{WasmModuleURL:"/first.wasm"}};
        setKtx2DecoderUrl("/decoder.js",urls);
        urls.ZSTDDecoder.WasmModuleURL="/later.wasm";
    `), /fresh object literals/);
});

test("loaded assets retain their realm's decoder setup and refuse later changes", () => {
    const program=(later:string)=>`
        import {createEngine,loadGltf,setDracoBaseUrl} from "@babylonjs/lite";
        async function main(){
            setDracoBaseUrl("https://example.test/draco/");
            const engine=await createEngine({});
            await loadGltf(engine,"https://example.test/model.glb");
            ${later}
        }
        void main();`;
    const result=compileSource(program(""));
    assert.deepEqual(result.manifest.assets.find(asset=>asset.kind==="gltf")!.assetDecoders,{
        draco:{javascript:"https://example.test/draco/draco_decoder.js",wasm:"https://example.test/draco/draco_decoder.wasm"},
    });
    assert.throws(()=>compileSource(program('setDracoBaseUrl("https://example.test/other/");')),/before compressed asset loads/);
});

test("configured decoder resources are lazy, deduplicated and retry failed reads", async () => {
    const reads:string[]=[];
    let failing=true;
    const decoders=prepareAssetDecoders({
        ktx2:{javascript:"https://example.test/decoder.js?v=1",wasmUrls:{First:{WasmModuleURL:"shared.wasm"},Second:{WasmModuleURL:"shared.wasm"}}},
        draco:{javascript:"draco.js",wasm:"draco.wasm"},
    }, async source => {
        reads.push(source);
        if(source==="draco.wasm"&&failing)throw new Error("temporary read failure");
        return new TextEncoder().encode(source);
    });
    assert.deepEqual(reads,[]);
    const [first,second]=await Promise.all([decoders.ktx2!(),decoders.ktx2!()]);
    assert.equal(first,second);
    assert.match(first.url,/\/decoder\.js$/);
    assert.equal(first.wasmUrls!.First!.WasmModuleURL,first.wasmUrls!.Second!.WasmModuleURL);
    assert.deepEqual(reads.sort(),["https://example.test/decoder.js?v=1","shared.wasm"].sort());
    await assert.rejects(decoders.draco!(),/temporary read failure/);
    failing=false;
    const loaded=await decoders.draco!();
    assert.equal(new TextDecoder().decode(loaded.wasm),"draco.wasm");
});

test("Draco packaging executes the supplied decoder and keeps configurations separate", async () => {
    const input = () => ({json:{asset:{version:"2.0"},extensionsUsed:["KHR_draco_mesh_compression"],
        buffers:[{byteLength:4}],bufferViews:[{buffer:0,byteOffset:0,byteLength:4}],
        meshes:[{primitives:[{attributes:{},extensions:{KHR_draco_mesh_compression:{bufferView:0,attributes:{}}}}]}]},
        binary:Buffer.alloc(4)});
    const make=(value:number)=>prepareAssetDecoders({draco:{javascript:"decoder.js",wasm:"decoder.wasm"}},async source=>
        source.endsWith(".js") ? new TextEncoder().encode(
            'globalThis.DracoDecoderModule=async options=>{throw new Error("configured decoder "+options.wasmBinary[0]);};') : new Uint8Array([value]));
    await assert.rejects(resolveGlbGeometry(input(),"first",make(3)),/configured decoder 3/);
    await assert.rejects(resolveGlbGeometry(input(),"second",make(7)),/configured decoder 7/);
    let reads=0;
    await resolveGlbGeometry({json:{asset:{version:"2.0"}},binary:Buffer.alloc(0)},"plain",{
        draco:async()=>{reads++;throw new Error("unused decoder");},
    });
    assert.equal(reads,0);
});

test("KTX2 packaging applies supplied decoder URLs and invalidates cached decoder bytes", async t => {
    try {resolveBrowserPath();} catch {t.skip("Chromium is unavailable.");return;}
    const javascript = new TextEncoder().encode(`globalThis.KTX2DECODER={
        MSCTranscoder:{},WASMMemoryManager:{},Palette:{},
        KTX2Decoder:class {async decode(){
            const bytes=new Uint8Array(await(await fetch(globalThis.KTX2DECODER.Palette.WasmModuleURL)).arrayBuffer());
            return {transcodedFormat:32856,mipmaps:[{width:1,height:1,data:new Uint8Array([bytes[0],0,0,255])}]};
        }}
    };`);
    const transcode=async(red:number)=>{
        const decoders=prepareAssetDecoders({ktx2:{javascript:"decoder.js",wasmUrls:{Palette:{WasmModuleURL:"palette.wasm"}}}},
            async source=>source.endsWith(".js")?javascript:new Uint8Array([red]));
        return transcodeKtx2Texture("fixture.ktx2",new Uint8Array([1,2,3]),await decoders.ktx2!());
    };
    const first=await transcode(3),second=await transcode(7);
    assert.equal(first.gpuFormat,"rgba8unorm");
    assert.deepEqual([...first.mips[0]!.bytes],[3,0,0,255]);
    assert.deepEqual([...second.mips[0]!.bytes],[7,0,0,255]);
});
