import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    serveHttpFixture,
} from "./native-fixture.js";

async function checkRuntimeHttp(
    t: test.TestContext,
    deferred: boolean,
): Promise<void> {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const requests: {
        path: string;
        method: string;
        body: string;
        contentType: string | undefined;
    }[] = [];
    const base = await serveHttpFixture(t, (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            requests.push({
                path: request.url!,
                method: request.method!,
                body: Buffer.concat(chunks).toString("utf8"),
                contentType: request.headers["content-type"],
            });
            if (request.url === "/redirect") {
                response.writeHead(303, { location: "/final" });
                response.end();
                return;
            }
            if (request.url === "/bytes") {
                response.end(
                    Buffer.from([
                        0xef, 0xbb, 0xbf, 0x61, 0xe0, 0x80, 0xe2, 0x82,
                    ]),
                );
                return;
            }
            if (request.url === "/disconnect") {
                request.socket.destroy();
                return;
            }
            response.writeHead(request.url === "/missing" ? 404 : 201, {
                "content-type": "application/json",
            });
            response.end('{"answer":42}');
        });
    });
    const directory = resolve(
        `artifacts/runtime-http${deferred ? "-headers" : ""}`,
    );
    mkdirSync(directory, { recursive: true });
    // Runtime responses expose native headers and bodies in either admission mode.
    const headerProbe = deferred
        ? `
            let keys=0;
            function headerName():string{keys++;return 'content-type';}
            if(response.headers?.get(headerName())!=='application/json'||keys!==1)throw new Error('response headers');
            if(!response.body||response.bodyUsed)throw new Error('response body');
    `
        : "";
    const source = `
        const request = fetch;
        async function run():Promise<void> {
            const response = await fetch("${base}/submit", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({message:"hello 🌍"})});
            if (!response.ok || response.status !== 201 || response.bodyUsed) throw new Error("response metadata");
            ${headerProbe}
            const text = await response.text();
            if (text !== '{"answer":42}' || !response.bodyUsed) throw new Error("response text");
            let refused = false;
            try { await response.text(); } catch { refused = true; }
            if (!refused) throw new Error("body read twice");
            const missing = await fetch("${base}/missing", {});
            if (missing.ok || missing.status !== 404) throw new Error("HTTP status became rejection");
            const document = await missing.json();
            if (document.answer !== 42) throw new Error("response JSON");
            const redirected = await request("${base}/redirect", {method:"POST", body:"body", cache:"no-store"});
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
    const compiled = compileSource(source, {
        fileName: entry,
        ...(deferred ? { deferredCapabilities: "runtime-throw" as const } : {}),
    });
    assert.equal(compiled.manifest.deferredCapabilities, undefined);
    assert.ok(compiled.manifest.features.includes("platform:http"));
    assert.ok(compiled.manifest.runtimeSources.includes("src/pal_http.cpp"));
    const cpp = resolve(directory, "main.cpp"),
        executable = resolve(directory, "check.exe");
    writeFileSync(cpp, compiled.cpp);
    runNativeFixtureCompiler(native, [
        "/DBBLITE_WORKERS=1",
        cpp,
        "native/src/pal_http.cpp",
        `/Fo${directory}/`,
        `/Fe${executable}`,
        "/link",
        "winhttp.lib",
    ]);
    const output = await promisify(execFile)(executable, [], {
        timeout: 15000,
    });
    assert.equal(output.stdout + output.stderr, "");
    assert.deepEqual(requests[0], {
        path: "/submit",
        method: "POST",
        body: '{"message":"hello 🌍"}',
        contentType: "application/json",
    });
    assert.deepEqual(
        requests
            .filter((request) => request.path === "/final")
            .map((request) => [request.method, request.body]),
        [["GET", ""]],
    );
    assert.equal(
        requests.find((request) => request.path === "/redirect")?.contentType,
        "text/plain;charset=UTF-8",
    );
}

test("strict runtime HTTP preserves requests, responses and rejection", (t) =>
    checkRuntimeHttp(t, false));
test("runtime response headers and bodies stay native in deferred capability mode", (t) =>
    checkRuntimeHttp(t, true));

test("keepalive requests share a 64 KiB quota and outlive the realm", async (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const received: { path: string; bytes: number }[] = [];
    const base = await serveHttpFixture(t, (request, response) => {
        let bytes = 0;
        request.on("data", (chunk: Buffer) => (bytes += chunk.length));
        request.on("end", () => {
            received.push({ path: request.url!, bytes });
            // The held and reported requests answer after the program moved on.
            setTimeout(
                () => response.end("ok"),
                request.url === "/hold" || request.url === "/report" ? 400 : 0,
            );
        });
    });
    const directory = resolve("artifacts/runtime-http-keepalive");
    mkdirSync(directory, { recursive: true });
    const source = `
        async function rejects(url:string, size:number):Promise<boolean> {
            try { await fetch(url, {method:"POST", body:"x".repeat(size), keepalive:true}); return false; }
            catch (error) { return error instanceof TypeError; }
        }
        async function run():Promise<void> {
            if (!(await rejects("${base}/over", 70000))) throw new Error("keepalive quota");
            const held = fetch("${base}/hold", {method:"POST", body:"y".repeat(40000), keepalive:true});
            if (!(await rejects("${base}/shared", 30000))) throw new Error("keepalive bytes in flight");
            const heldResponse = await held;
            if ((await heldResponse.text()) !== "ok") throw new Error("held response");
            const after = await fetch("${base}/after", {method:"POST", body:"z".repeat(30000), keepalive:true});
            if ((await after.text()) !== "ok") throw new Error("lease returned");
            void fetch("${base}/report", {method:"POST", body:"report", keepalive:true});
            globalThis.close();
        }
        run();
    `;
    const entry = resolve(directory, "entry.ts");
    writeFileSync(entry, source);
    const compiled = compileSource(source, { fileName: entry });
    const cpp = resolve(directory, "main.cpp"),
        executable = resolve(directory, "check.exe");
    writeFileSync(cpp, compiled.cpp);
    runNativeFixtureCompiler(native, [
        "/DBBLITE_WORKERS=1",
        cpp,
        "native/src/pal_http.cpp",
        `/Fo${directory}/`,
        `/Fe${executable}`,
        "/link",
        "winhttp.lib",
    ]);
    const output = await promisify(execFile)(executable, [], {
        timeout: 15000,
    });
    assert.equal(output.stdout + output.stderr, "");
    // Over-quota requests never reach the server; the unawaited report is
    // delivered whole although the realm closed before its response.
    assert.deepEqual(
        received.map(({ path, bytes }) => [path, bytes]),
        [
            ["/hold", 40000],
            ["/after", 30000],
            ["/report", 6],
        ],
    );
});

test("fetch refuses a cache mode a native response cannot honour", () => {
    for (const options of [
        `{cache:"only-if-cached"}`,
        `{method:"POST", cache:mode}`,
    ]) {
        assert.throws(
            () =>
                compileSource(`
                    const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
                    worker.terminate();
                    const mode = Math.random() > 0.5 ? "reload" : "no-store";
                    async function run():Promise<void> { await fetch("https://example.com/data", ${options}); }
                    run();
                `),
            /fetch option 'cache' must be a static/,
        );
    }
});
