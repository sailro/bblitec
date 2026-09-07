import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const program = `
import {createEngine,createStorageBuffer,updateStorageBuffer} from "@babylonjs/lite";
function makeBuffer(size:number):ArrayBuffer {const bytes=new Uint8Array(size);return bytes.buffer;}
async function main() {
 if(!new RegExp("^views$").test("views")) throw new Error("constructor RegExp dispatch");
 const bytes=new Uint8Array(32);
 const buffer=bytes.buffer;
 const floats=new Float32Array(buffer,4.9,2.9);
 const words=new Uint32Array(buffer,4,2);
 floats[0]=1.5; floats[1]=-2;
 if(words[0]!==1069547520 || words[1]!==3221225472) throw new Error("shared byte lanes");
 words[1]=1077936128;
 if(floats[1]!==3 || floats.byteOffset!==4 || floats.byteLength!==8 || floats.length!==2) throw new Error("view extents");
 if(floats.buffer!==buffer || floats.buffer!==words.buffer) throw new Error("buffer identity");
 const alias=floats;
 const separate=new Float32Array(buffer,4,2);
 if(alias!==floats || separate===floats) throw new Error("view identity");
 const owned=new Float32Array([7,8,9]);
 const middle=new Float32Array(owned.buffer,4,1);
 middle[0]=13;
 if(owned[1]!==13 || middle.buffer!==owned.buffer) throw new Error("typed backing");
 let escaped:Float32Array;
 {const local=new Float32Array([11,12]); escaped=new Float32Array(local.buffer,4,1);}
 escaped[0]++;
 if(escaped[0]!==13) throw new Error("escaped backing");
 const signed16=new Int16Array(buffer,16,2);
 const unsigned16=new Uint16Array(buffer,16,2);
 unsigned16[0]=-1.9; signed16[1]=65537.9;
 if(signed16[0]!==-1 || unsigned16[1]!==1) throw new Error("integer coercion");
 const signed32=new Int32Array(buffer,20,1);
 const unsigned32=new Uint32Array(buffer,20,1);
 signed32[0]=4294967295.9;
 if(signed32[0]!==-1 || unsigned32[0]!==4294967295) throw new Error("wide integer coercion");
 unsigned32[0]>>>=1;
 if(unsigned32[0]!==2147483647) throw new Error("unsigned compound store");
 const doubles=new Float64Array(buffer,24,1);
 doubles[0]=1.0000000000000002;
 if(doubles[0]!==1.0000000000000002) throw new Error("double precision");
 floats[0]=16777216;
 const prefix=++floats[0]!;
 const postfix=floats[0]!++;
 if(prefix!==16777217 || postfix!==16777216 || floats[0]!==16777216) throw new Error("update result before narrow");
 let active=new Float32Array(makeBuffer(8));
 const previous=active;
 active[0]=3;
 function replace():number {previous[0]=100;active=new Float32Array(makeBuffer(8));return 2;}
 active[0]+=replace();
 if(previous[0]!==5 || active[0]!==0) throw new Error("compound owner and value order");
 const indexedBytes=new Uint8Array(16);
 let indexed=new Float32Array(indexedBytes.buffer,0,2);
 const indexedBefore=indexed;
 function replaceIndex():number {indexed=new Float32Array(indexedBytes.buffer,8,2);return 0;}
 indexed[replaceIndex()]=7;
 if(indexedBefore[0]!==7 || indexed[0]!==0) throw new Error("owner before write index");
 indexed=indexedBefore;
 const observedIndex=indexed[replaceIndex()];
 if(observedIndex!==7 || indexed[0]!==0) throw new Error("owner before read index");
 let calls=0;
 function offset():number {calls++;return 4.9;}
 function length():number {if(calls!==1) throw new Error("constructor argument order");calls++;return 1.9;}
 const ordered=new Float32Array(buffer,offset(),length());
 if(calls!==2 || ordered.byteOffset!==4 || ordered.length!==1) throw new Error("constructor argument evaluation");
 calls=0;
 const chained=new Uint8Array(buffer,offset(),length()).slice();
 if(calls!==2 || chained.length!==1) throw new Error("constructor receiver evaluated twice");
 const zero=new Float32Array(buffer,-0.9,NaN);
 const whole=new Float32Array(buffer,NaN);
 if(zero.length!==0 || whole.length!==8 || zero.byteOffset!==0) throw new Error("ToIndex after truncation");
 const trailing=new Float32Array(makeBuffer(10),0,2);
 if(trailing.length!==2) throw new Error("explicit aligned extent");
 let failures=0;
 for(const offset of [-1.1,1,36,Infinity]) {
  try {const invalid=new Float32Array(buffer,offset);failures-=100+invalid.length;} catch(error:unknown) {failures++;}
 }
 try {const invalid=new Float32Array(makeBuffer(10));failures-=100+invalid.length;} catch(error:unknown) {failures++;}
 try {const invalid=new Float32Array(buffer,0,9);failures-=100+invalid.length;} catch(error:unknown) {failures++;}
 if(failures!==6) throw new Error("constructor bounds");
 calls=0;
 try {const invalid=new Float32Array(buffer,1).fill(offset());failures-=100+invalid.length;} catch(error:unknown) {}
 if(calls!==0) throw new Error("fill argument before constructor");
 const engine=await createEngine({});
 const uploadBytes=new Uint8Array(16);
 const emptyOwner=new Float32Array(uploadBytes.buffer,4,0);
 const uploadFull=new Uint8Array(emptyOwner.buffer);
 const storage=createStorageBuffer(engine,uploadBytes);
 uploadBytes[0]=7;
 updateStorageBuffer(engine,storage,uploadFull);
 const shortOwner=new Float32Array(uploadBytes.buffer,4,1);
 const secondFull=new Uint8Array(shortOwner.buffer);
 uploadBytes[0]=9;
 updateStorageBuffer(engine,storage,secondFull);
}
`;

test("numeric buffer views preserve JavaScript aliases, stores, order and ToIndex", async () => {
    const javascript = ts.transpileModule(program, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    // Engine creation/upload are the only seams; the source performs every
    // view operation with the host JavaScript typed-array constructors.
    let uploads = 0;
    await new Function("createEngine", "createStorageBuffer", "updateStorageBuffer",
        `${javascript.replace(/^import[^\n]+\n/m, "")}\nreturn main();`)(
        async () => ({}), (_engine: unknown, bytes: Uint8Array) => bytes.slice(),
        (_engine: unknown, storage: Uint8Array, bytes: Uint8Array) => {
            storage.set(bytes);
            assert.equal(storage.length, 16);
            assert.equal(storage[0], 7 + uploads++ * 2);
        });
    assert.equal(uploads, 2);
    const compiled = compileSource(program);
    assert.match(compiled.cpp, /bbl::js::F32Array\(v_bblite_view_buffer_/);
    assert.match(compiled.cpp, /typed_array_byte_offset/);
});

const tools = optionalNativeFixtureTools(false);
test("native byte-backed numeric views match the same observing program and refuse contiguous methods", { skip: !tools }, () => {
    const output = resolve("artifacts/numeric-buffer-views-check");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(source,
        `#include <bblite/runtime.hpp>\nnamespace bbl { template<class Data> void observe_upload(Engine&, StorageBufferHandle, const Data&, double); }\n` +
        `#define main generated_scene_main\n${compileSource(program).cpp.replaceAll("bbl::update_storage_buffer(", "bbl::observe_upload(")}\n#undef main\n` +
        readFileSync("test/fixtures/numeric-buffer-views-check.cpp", "utf8"));
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2", "/Gy",
        "/I", "native/include", `/Fo:${output}\\`, `/Fe:${executable}`, source, "/link", "/OPT:REF",
    ]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /numeric-buffer-views-check: ok/);
});
