import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("packaged fetch owns responses, snapshots selections and rejects missing or consumed bodies", (t) => {
    const directory = resolve("artifacts/packaged-fetch");
    const publicDir = join(directory, "public");
    const files = join(publicDir, "files");
    mkdirSync(files, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    writeFileSync(join(files, "bytes.bin"), Buffer.from([1, 2, 255]));
    writeFileSync(
        join(files, "text.txt"),
        Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xe0, 0x80, 0xe2, 0x82]),
    );
    writeFileSync(join(files, "document.json"), '{"answer":42}');
    writeFileSync(join(files, "missing.bin"), "exists only while compiling");
    const moduleFiles = join(publicDir, "module-files");
    mkdirSync(moduleFiles, { recursive: true });
    writeFileSync(join(moduleFiles, "sound.bin"), Buffer.from([7, 8, 9]));
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});
        worker.terminate();
        function moduleUrl(path: string, source: string): string {
            const value = new URL(path, source);
            value.pathname = value.pathname.replace("/unused/", "/");
            return value.href;
        }
        function fileUrl(name: string): string { return moduleUrl(\`/module-files/\${name}\`, import.meta.url); }
        async function fetchSelected(urlFor: (name: string) => string, name: string): Promise<ArrayBuffer> {
            const response = await fetch(urlFor(name)); return response.arrayBuffer();
        }
        async function load(name:string):Promise<Response>{return fetch("/files/"+name);}
        function retain(response:Response):Response{return response;}
        let calls=0;
        let cacheReads=0;
        function cacheMode(): "no-store" { cacheReads++; return "no-store"; }
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
            const uncached=await fetch("/files/document.json",{cache:cacheMode()}).then(value=>value.json());
            if(uncached.answer!==42 || cacheReads!==1) throw new Error("cache mode on a packaged response");
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
            const selected=new Uint8Array(await fetchSelected(fileUrl, "sound.bin"));
            if(selected.length!==3||selected[0]!==7||selected[2]!==9) throw new Error("module-relative callback assets");
            globalThis.close();
        })();
    `,
        {
            fileName: join(directory, "entry.ts"),
            publicDir,
            siteUrl: "https://assets.example/",
        },
    );
    assert.ok(result.manifest.features.includes("platform:packaged-fetch"));
    assert.ok(!result.manifest.features.includes("platform:http"));
    assert.ok(!result.manifest.runtimeSources.includes("src/pal_http.cpp"));
    assert(
        result.manifest.assets.some((asset) =>
            asset.source.endsWith("sound.bin"),
        ),
    );
    for (const asset of result.manifest.assets) {
        if (asset.source.endsWith("missing.bin")) continue;
        const output = join(directory, asset.output);
        mkdirSync(dirname(output), { recursive: true });
        copyFileSync(resolve(directory, asset.source), output);
    }
    runPackagedProgram(t, directory, result.cpp);
});

function runPackagedProgram(
    t: test.TestContext,
    directory: string,
    program: string,
): void {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cpp = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(cpp, program);
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/I",
        "native/include",
        `/I${nativeFixtureVcpkgRoot}/include`,
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        cpp,
        "test/fixtures/packaged-fetch-check.cpp",
    ]);
    assert.equal(
        execFileSync(exe, { cwd: directory, encoding: "utf8", timeout: 10000 }),
        "",
    );
}

test("packaged URL domains survive descriptor selection, base helpers and async aliases", (t) => {
    const directory = resolve("artifacts/packaged-url-domain");
    const publicDir = join(directory, "public");
    const clips = join(publicDir, "clips");
    mkdirSync(clips, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    for (const [name, bytes] of [
        ["voice_01.bin", [11, 12]],
        ["voice_02.bin", [21, 22, 23]],
        ["tone & space_1.bin", [31]],
        ["unrelated.bin", [99]],
    ] as const)
        writeFileSync(join(clips, name), Buffer.from(bytes));
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"}); worker.terminate();
        const BASE=import.meta.env.BASE_URL;
        let paths=0;
        const assetPath=(path:string):string=>{paths++;return BASE+path.replace(/^\\/+/, "");};
        interface Entry {url:string;weight:number;}
        const entries:Entry[]=[...Array.from({length:2},(_,index)=>({
            url:assetPath(\`/clips/voice_\${String(index+1).padStart(2,"0")}.bin\`),weight:1
        }))];
        function choose<T extends {url:string;weight:number}>(bank:T[], wanted:number):T {
            let fallback=bank[0]!;
            for(const entry of bank){fallback=entry;if(--wanted<0)return entry;}
            return fallback;
        }
        async function load(url:string):Promise<Response>{return fetch(url);}
        async function read(entry:Entry):Promise<Uint8Array>{return new Uint8Array(await load(entry.url).then(r=>r.arrayBuffer()));}
        let selections=0;
        function select(index:number):Entry{selections++;return choose(entries,index);}
        function numbered(index:number):string{return assetPath("/clips/voice_"+String(index).padStart(2,"0")+".bin");}
        async function numberedResponse(index:number):Promise<Response>{const url=numbered(index);return fetch(url,{cache:"no-store"});}
        function escaped(index:number):string{return assetPath(\`/clips/tone%20%26%20space_\${index}.bin?version=2#clip\`);}
        async function escapedResponse(index:number):Promise<Response>{return fetch(escaped(index));}
        void(async()=>{
            const pending=read(select(0));
            const other=read(select(1));
            const first=await pending, second=await other;
            if(selections!==2||paths!==2||first.length!==2||first[0]!==11||second.length!==3||second[2]!==23)
                throw new Error("descriptor domain or call evaluation");
            const response=await numberedResponse(2);
            if(paths!==3||response.url!=="https://assets.example/app/clips/voice_02.bin"||!response.ok||response.bodyUsed)
                throw new Error("base-relative response metadata");
            const alias=response;
            if((await alias.arrayBuffer()).byteLength!==3||!response.bodyUsed)throw new Error("owned body");
            let consumed=false;try{await response.arrayBuffer();}catch{consumed=true;}
            if(!consumed)throw new Error("body reuse");
            let rejected=false;try{await numberedResponse(3);}catch{rejected=true;}
            if(!rejected||paths!==4)throw new Error("closed domain rejection or evaluation count");
            const quoted=await escapedResponse(1);
            if(quoted.url!=="https://assets.example/app/clips/tone%20%26%20space_1.bin?version=2"||
                new Uint8Array(await quoted.arrayBuffer())[0]!==31||paths!==5)throw new Error("URL encoding/query/hash");
            globalThis.close();
        })();
    `,
        {
            fileName: join(directory, "entry.ts"),
            publicDir,
            siteUrl: "https://assets.example/app/",
        },
    );
    assert.ok(result.manifest.features.includes("platform:packaged-fetch"));
    assert.ok(!result.manifest.features.includes("platform:http"));
    assert.equal(result.manifest.assets.length, 3);
    assert.ok(
        result.manifest.assets.every(
            (asset) => !asset.source.endsWith("unrelated.bin"),
        ),
    );
    for (const asset of result.manifest.assets) {
        const output = join(directory, asset.output);
        mkdirSync(dirname(output), { recursive: true });
        copyFileSync(resolve(directory, asset.source), output);
    }
    runPackagedProgram(t, directory, result.cpp);
});

test("worker native-object mutations preserve sibling packaged URL selection", (t) => {
    const directory = resolve("artifacts/packaged-url-native-sibling");
    const publicDir = join(directory, "public");
    mkdirSync(join(publicDir, "files"), { recursive: true });
    writeFileSync(join(publicDir, "files", "bytes.bin"), Buffer.from([41]));
    writeFileSync(join(publicDir, "files", "unrelated.bin"), Buffer.from([99]));
    writeFileSync(
        join(directory, "asset.ts"),
        `
        function asset(path:string,base:string):string{const value=new URL(path,base);return value.href;}
        export const ASSET=asset("/files/bytes.bin",import.meta.url);
    `,
    );
    writeFileSync(
        join(directory, "worker.ts"),
        `
        import {ASSET} from "./asset";
        async function read(url:string=ASSET):Promise<number>{
            const response=await fetch(url);
            return new Uint8Array(await response.arrayBuffer())[0];
        }
        self.addEventListener("message",(event:MessageEvent<{canvas:OffscreenCanvas;url:string}>)=>{
            const message=event.data;
            const canvas=message.canvas;
            canvas.width=5;
            if(canvas.width!==5)throw new Error("native object mutation");
            void read(message.url).then(value=>self.postMessage(value)).catch(()=>self.postMessage(-1));
        });
    `,
    );
    const result = compileSource(
        `
        import {ASSET} from "./asset";
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});
        let loaded=false,rejected=false;
        worker.addEventListener("message",(event:MessageEvent<number>)=>{
            if(event.data===41)loaded=true;
            else if(event.data===-1)rejected=true;
            else throw new Error("sibling packaged URL bytes");
            if(loaded&&rejected)globalThis.close();
        });
        const first=new OffscreenCanvas(1,1),second=new OffscreenCanvas(1,1);
        worker.postMessage({canvas:first,url:ASSET},[first]);
        worker.postMessage({canvas:second,url:"/files/unrelated.bin"},[second]);
    `,
        { fileName: join(directory, "entry.ts"), publicDir },
    );
    assert.deepEqual(
        result.manifest.assets.map((asset) => asset.source),
        ["public/files/bytes.bin"],
    );
    for (const asset of result.manifest.assets) {
        const output = join(directory, asset.output);
        mkdirSync(dirname(output), { recursive: true });
        copyFileSync(resolve(directory, asset.source), output);
    }
    runPackagedProgram(t, directory, result.cpp);
});

test("packaged URL provenance refuses uncertain mutations, origins and unbounded domains", () => {
    const directory = resolve("artifacts/packaged-url-domain-refusals");
    const publicDir = join(directory, "public");
    const clips = join(publicDir, "clips");
    mkdirSync(clips, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    writeFileSync(join(clips, "voice_01.bin"), "one");
    writeFileSync(join(clips, "voice_02.bin"), "two");
    writeFileSync(
        join(directory, "mutable.ts"),
        'export let selected = "/clips/voice_01.bin";',
    );
    const cases = [
        `const entries=[{url:"/clips/voice_01.bin"}]; entries[0].url="/clips/voice_02.bin"; const url=entries[Math.floor(Math.random())].url;`,
        `const entries=[{url:"/clips/voice_01.bin"}]; const alias=entries; alias.push({url:"/clips/voice_02.bin"}); const url=entries[Math.floor(Math.random()*2)].url;`,
        `const entries=[{url:"/clips/voice_01.bin"}]; function edit(bank:{url:string}[]):void{bank[0].url="/clips/voice_02.bin";} edit(entries); const url=entries[Math.floor(Math.random())].url;`,
        `const record={nested:{url:"/clips/voice_01.bin"}}; const alias=record.nested; alias.url="/clips/voice_02.bin"; const url=record.nested.url;`,
        `const entries=["https://remote.invalid/a.bin","https://remote.invalid/b.bin"]; const url=entries[Math.floor(Math.random()*2)];`,
        `const entries=["/clips/../clips/voice_01.bin","/clips/%2e%2e/clips/voice_02.bin"]; const url=entries[Math.floor(Math.random()*2)];`,
        `const entries=["/clips%2fvoice_01.bin","/clips%5cvoice_02.bin"]; const url=entries[Math.floor(Math.random()*2)];`,
        `function path(index:number):string{return \`/clips/voice_\${index}.bin?version=\${index}\`;} const url=path(Math.random());`,
        `function path(index:number):string{return \`/clips/voice_\${index}.bin\`.replace(/voice/g, value=>value);} const url=path(Math.random());`,
        `import {selected} from "./mutable"; const url=selected;`,
    ];
    for (const body of cases) {
        assert.throws(
            () =>
                compileSource(
                    `
            const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
            function moduleUrl(path:string,source:string):string{const value=new URL(path,source);return value.href;}
            const unrelated=moduleUrl("/clips/voice_01.bin",import.meta.url);
            ${body}
            async function load(value:string):Promise<Response>{return fetch(value);}
            void load(url);
        `,
                    { fileName: join(directory, "entry.ts"), publicDir },
                ),
            /fetch URL .*lost its static value|Expected a compile-time string|Packaged URL provenance/,
        );
    }
    const crowded = join(publicDir, "crowded");
    mkdirSync(crowded, { recursive: true });
    for (let index = 0; index < 257; index++)
        writeFileSync(join(crowded, `clip_${index}.bin`), "x");
    assert.throws(
        () =>
            compileSource(
                `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        function path(index:number):string{return \`/crowded/clip_\${index}.bin\`;}
        async function load(index:number):Promise<Response>{const url=path(index);return fetch(url);}
        void load(Math.random());
    `,
                { fileName: join(directory, "entry.ts"), publicDir },
            ),
        /Packaged URL domain exceeds 256 candidates/,
    );
});
