import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {copyFileSync, mkdirSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("packaged fetch owns responses, snapshots selections and rejects missing or consumed bodies", t => {
    const directory = resolve("artifacts/packaged-fetch");
    const publicDir = join(directory, "public");
    const files = join(publicDir, "files");
    mkdirSync(files, {recursive:true});
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    writeFileSync(join(files, "bytes.bin"), Buffer.from([1,2,255]));
    writeFileSync(join(files, "text.txt"), Buffer.from([0xef,0xbb,0xbf,0x61,0xe0,0x80,0xe2,0x82]));
    writeFileSync(join(files, "document.json"), '{"answer":42}');
    writeFileSync(join(files, "missing.bin"), "exists only while compiling");
    const result = compileSource(`
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});
        worker.terminate();
        async function load(name:string):Promise<Response>{return fetch("/files/"+name);}
        function retain(response:Response):Response{return response;}
        let calls=0;
        function select():string{calls++;return calls===1?"bytes.bin":"text.txt";}
        function unknownName():string{return calls===2?"unknown.bin":"bytes.bin";}
        void(async()=>{
            const pending=load(select());
            const second=load(select());
            const response=await pending;
            const alias=retain(response);
            if(calls!==2||!response.ok||response.status!==200||response.bodyUsed||response.url!=="https://assets.example/files/bytes.bin")
                throw new Error("response metadata or selection snapshot");
            const bytes=new Uint8Array(await alias.arrayBuffer());
            if(bytes.length!==3||bytes[0]!==1||bytes[2]!==255||!response.bodyUsed) throw new Error("owned response bytes");
            let consumed=false;
            try{await response.text();}catch{consumed=true;}
            if(!consumed) throw new Error("shared body consumption");
            const text=await second.then(value=>value.text());
            if(text!=="a���") throw new Error("UTF-8 replacement and BOM");
            const document=await fetch("/files/document.json").then(value=>value.json());
            if(document.answer!==42) throw new Error("owned JSON response");
            const responses:Response[]=[await load("bytes.bin"),await load("text.txt")];
            const stored=responses[0];
            const storedBytes=await stored.arrayBuffer();
            if(storedBytes.byteLength!==3||!responses[0].bodyUsed) throw new Error("stored response identity");
            let missing=false;
            try{await load("missing.bin");}catch{missing=true;}
            if(!missing) throw new Error("file failure must reject");
            let unknown=false;
            try{await load(unknownName());}catch{unknown=true;}
            if(!unknown) throw new Error("closed selection must reject");
            const [first,other]=await Promise.all([load("bytes.bin").then(value=>value.arrayBuffer()),load("text.txt").then(value=>value.text())]);
            if(first.byteLength!==3||other!=="a���") throw new Error("concurrent owned bodies");
            const sized=new Uint8Array(await Promise.resolve(3));
            const sequence=new Uint8Array(await Promise.resolve([258,3]));
            if(sized.length!==3||sequence[0]!==2||sequence[1]!==3) throw new Error("awaited typed array constructor");
            globalThis.close();
        })().catch(error=>{console.log(error);globalThis.close();});
    `, {fileName:join(directory,"entry.ts"),publicDir,siteUrl:"https://assets.example/"});
    assert.ok(result.manifest.features.includes("platform:packaged-fetch"));
    assert.ok(!result.manifest.features.includes("platform:http"));
    assert.ok(!result.manifest.runtimeSources.includes("src/pal_http.cpp"));
    for(const asset of result.manifest.assets) {
        if(asset.source.endsWith("missing.bin")) continue;
        const output=join(directory,asset.output);
        mkdirSync(dirname(output),{recursive:true});
        copyFileSync(resolve(directory,asset.source),output);
    }
    const native=optionalNativeFixtureTools();
    if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const cpp=join(directory,"check.cpp"),exe=join(directory,"check.exe");
    writeFileSync(cpp,result.cpp);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD","/DBBLITE_WORKERS=1",
        "/I","native/include",`/I${nativeFixtureVcpkgRoot}/include`,`/Fo:${directory}/`,`/Fe:${exe}`,cpp,"test/fixtures/packaged-fetch-check.cpp"]);
    assert.equal(execFileSync(exe,{cwd:directory,encoding:"utf8",timeout:10000}),"");
});
