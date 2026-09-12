import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {resolve} from "node:path";
import test from "node:test";
import {promisify} from "node:util";
import {compileSource} from "../src/compiler.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("runtime HTTP preserves request bytes, response status, body consumption and rejection", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const requests: {path:string; method:string; body:string; contentType:string|undefined}[] = [];
    const server = createServer((request, response) => {
        const chunks:Buffer[] = [];
        request.on("data", (chunk:Buffer) => chunks.push(chunk));
        request.on("end", () => {
            requests.push({path:request.url!, method:request.method!, body:Buffer.concat(chunks).toString("utf8"), contentType:request.headers["content-type"]});
            if (request.url === "/redirect") { response.writeHead(303, {location:"/final"}); response.end(); return; }
            if (request.url === "/bytes") { response.end(Buffer.from([0xef,0xbb,0xbf,0x61,0xe0,0x80,0xe2,0x82])); return; }
            if (request.url === "/disconnect") { request.socket.destroy(); return; }
            response.writeHead(request.url === "/missing" ? 404 : 201, {"content-type":"application/json"});
            response.end('{"answer":42}');
        });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const directory = resolve("artifacts/runtime-http");
    mkdirSync(directory, {recursive:true});
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const source = `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const request = fetch;
        async function run():Promise<void> {
            const response = await request("${base}/submit", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({message:"hello 🌍"})});
            if (!response.ok || response.status !== 201 || response.bodyUsed) throw new Error("response metadata");
            const text = await response.text();
            if (text !== '{"answer":42}' || !response.bodyUsed) throw new Error("response text");
            let refused = false;
            try { await response.text(); } catch { refused = true; }
            if (!refused) throw new Error("body read twice");
            const missing = await fetch("${base}/missing", {});
            if (missing.ok || missing.status !== 404) throw new Error("HTTP status became rejection");
            const document = await missing.json();
            if (document.answer !== 42) throw new Error("response JSON");
            const redirected = await request("${base}/redirect", {method:"POST", body:"body"});
            if (redirected.url !== "${base}/final") throw new Error("redirect URL");
            const binary = await request("${base}/bytes");
            if (await binary.text() !== "a���") throw new Error("UTF-8 replacement decoding");
            let failed = false;
            try { await request("unsupported://host", {}); } catch { failed = true; }
            if (!failed) throw new Error("transport failure must reject");
            let disconnected = false;
            try { await request("${base}/disconnect", {}); } catch { disconnected = true; }
            if (!disconnected) throw new Error("connection failure must reject");
            globalThis.close();
        }
        run();
    `;
    const entry = resolve(directory, "entry.ts");
    writeFileSync(entry, source);
    const compiled = compileSource(source, {fileName:entry});
    assert.ok(compiled.manifest.features.includes("platform:http"));
    assert.ok(compiled.manifest.runtimeSources.includes("src/pal_http.cpp"));
    const cpp = resolve(directory, "main.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(cpp, compiled.cpp);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/MD", "/DBBLITE_WORKERS=1",
        `/I${resolve("native/include")}`, `/I${nativeFixtureVcpkgRoot}/include`, cpp, "native/src/pal_http.cpp",
        `/Fo${directory}/`, `/Fe${executable}`, "/link", "winhttp.lib"]);
    const output = await promisify(execFile)(executable, [], {timeout:15000});
    assert.equal(output.stdout + output.stderr, "");
    assert.deepEqual(requests[0], {path:"/submit", method:"POST", body:'{"message":"hello 🌍"}', contentType:"application/json"});
    assert.deepEqual(requests.filter(request => request.path === "/final").map(request => [request.method, request.body]), [["GET", ""]]);
    assert.equal(requests.find(request => request.path === "/redirect")?.contentType, "text/plain;charset=UTF-8");
});
