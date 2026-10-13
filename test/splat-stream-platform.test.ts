import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/**
 * native/src/pal_splat_stream_platform.cpp, the splat-stream library's web
 * platform defined over the native services, run by
 * test/fixtures/splat-stream-platform-check.cpp against a local server; the
 * expected lines are what the web platform does (Node's URL, TextDecoder and
 * the Fetch and WebGPU specifications).
 */
test("the splat stream's platform runs over the native URL, fetch, abort, Blob, image, decoder and timer services", async (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const pending: ServerResponse[] = [];
    const server = createServer((request, response) => {
        if (request.url === "/stream") {
            response.writeHead(200, {
                "content-type": "text/plain",
                "x-chunks": "3",
            });
            response.write("alpha-");
            setTimeout(() => response.write("beta-"), 20);
            setTimeout(() => response.end("gamma"), 40);
            return;
        }
        if (request.url === "/moved") {
            response.writeHead(302, { location: "/stream" });
            response.end();
            return;
        }
        if (request.url === "/hang") {
            pending.push(response);
            return;
        }
        if (request.url === "/slow") {
            response.writeHead(200, { "content-length": "1000" });
            response.write(Buffer.alloc(10, 7));
            pending.push(response);
            return;
        }
        response.writeHead(404);
        response.end("no");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => {
        for (const response of pending) response.destroy();
        server.closeAllConnections();
        server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    const directory = resolve("artifacts/test-splat-stream-platform");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_IMAGE_DECODER=1",
        "/DBBLITE_HAS_WEBP_DECODER=1",
        resolve("test/fixtures/splat-stream-platform-check.cpp"),
        "native/src/pal_splat_stream_platform.cpp",
        "native/src/pal_http.cpp",
        "native/src/pal_image.cpp",
        "native/src/pal.cpp",
        `/Fo${directory}/`,
        `/Fe${executable}`,
        join(nativeFixtureVcpkgRoot, "lib/libwebp.lib"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3_image.lib"),
        "/link",
        "winhttp.lib",
    ]);
    const output = await promisify(execFile)(executable, [base], {
        timeout: 60000,
        env: {
            ...process.env,
            PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}`,
        },
    });
    const lines = output.stdout.replaceAll("\r\n", "\n").trimEnd().split("\n");

    const url = new URL("chunks/../data.bin?x=1#f", `${base}/root/meta.json`);
    const moved = new URL(url.href);
    moved.pathname = "/a b/c%";
    const streaming = new TextDecoder(" UTF8\n");
    const decoded = [
        streaming.decode(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0xc3), {
            stream: true,
        }),
        streaming.decode(Uint8Array.of(0xa9, 0x62, 0xe2), { stream: true }),
        streaming.decode(),
    ];
    const kept = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        Uint8Array.of(0xef, 0xbb, 0xbf, 0x61),
    );
    const expected: (string | RegExp)[] = [
        `decode [${decoded.join("][")}]`,
        `bom [${kept}]`,
        "fatal TypeError",
        // A label of another encoding is refused, not decoded.
        "label RangeError",
        /^listeners 0 1 once;kept; AbortError\(dom\):.+$/,
        "dom QuotaExceededError(dom):quota 0",
        "timers sync;microtask;timeout; 1",
        `url ${url.href} ${url.protocol} ${url.pathname}`,
        `pathname ${moved.pathname}`,
        "invalid TypeError",
        `stream 1 200 ${base}/stream 3 none alpha-beta-gamma`,
        "missing 0 404",
        `redirect ${base}/stream`,
        /^early AbortError\(dom\):.+$/,
        "middle 10 RangeError:stop",
        "application 1 TypeError:gone",
        "aborted TypeError:gone",
        "bitmap 3x2",
        "copy 1 0 12 2 3x2",
        "flip refused",
        "premultiplied refused",
        "outside refused",
        "undecodable InvalidStateError",
        "closed 0",
        // Elements 1..2 of the words, bytes 1..2 of the buffer, then 1.0f.
        "write 5,6,7,8,9,10,11,12,187,204,0,0,0,0,128,63",
    ];
    assert.equal(lines.length, expected.length, lines.join("\n"));
    expected.forEach((line, index) => {
        if (typeof line === "string") assert.equal(lines[index], line);
        else assert.match(lines[index]!, line);
    });
});
