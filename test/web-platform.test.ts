import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import ts from "typescript";
import { webPlatformConstructors } from "../src/lowering/web-platform-schema.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    serveHttpFixture,
} from "./native-fixture.js";

/**
 * The web platform lowered libraries reach (`bblite/web_platform.hpp`): its
 * seam as native/src/pal_web_platform.cpp defines it over the native services
 * and its calls over the runtime's own objects, run by
 * test/fixtures/web-platform-check.cpp against a local server; the expected
 * lines are what the web platform does (Node's TextDecoder and AbortController,
 * the Fetch and WebGPU specifications).
 */
test("the web platform seam runs fetch, image decoding and timers over the native services", async (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const base = await serveHttpFixture(t, (request, response, hold) => {
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
            hold(response);
            return;
        }
        if (request.url === "/slow") {
            response.writeHead(200, { "content-length": "1000" });
            response.write(Buffer.alloc(10, 7));
            hold(response);
            return;
        }
        response.writeHead(404);
        response.end("no");
    });

    const directory = resolve("artifacts/test-web-platform");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_IMAGE_DECODER=1",
        "/DBBLITE_HAS_WEBP_DECODER=1",
        resolve("test/fixtures/web-platform-check.cpp"),
        "native/src/pal_web_platform.cpp",
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

    const streaming = new TextDecoder();
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
    const unsupported = (member: string, value: string): string =>
        `NotSupportedError(dom):createImageBitmap ${member} ${value} is not supported natively.`;
    const expected: (string | RegExp)[] = [
        `decode [${decoded.join("][")}]`,
        `bom [${kept}]`,
        "fatal TypeError",
        // The default reason's message is the platform's own.
        /^abort 0 1 once;kept; AbortError\(dom\):.+$/,
        "reason RangeError:why",
        "timers sync;microtask;timeout; 1",
        `stream 1 200 ${base}/stream 3 none alpha-beta-gamma`,
        "missing 0 404",
        `redirect ${base}/stream`,
        /^early AbortError\(dom\):.+$/,
        "middle 10 RangeError:stop",
        "aborted TypeError:gone",
        "bitmap 1 3x2",
        "copy 1 0 12 2 3x2",
        "flip refused",
        "premultiplied refused",
        "outside refused",
        "premultiply premultiply=1",
        "from-image premultiply=0",
        `default-alpha ${unsupported("premultiplyAlpha", "undefined")}`,
        `color ${unsupported("colorSpaceConversion", '"default"')}`,
        `orientation ${unsupported("imageOrientation", '"flipY"')}`,
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

test("a lowered TextDecoder's label names UTF-8 at generation", () => {
    const decoder = webPlatformConstructors.get("TextDecoder")!;
    const construction = (label: string): ts.NewExpression =>
        ts.factory.createNewExpression(
            ts.factory.createIdentifier("TextDecoder"),
            undefined,
            [ts.factory.createStringLiteral(label)],
        );
    const argument = (index: number): string => `argument_${index}`;
    const local = (name: string): string => name;
    assert.equal(
        decoder.cpp(argument, construction(" UTF8\n"), local),
        "bbl::js::make_text_decoder(false, false)",
    );
    assert.throws(
        () => decoder.cpp(argument, construction("latin1"), local),
        /its label must be a UTF-8 literal/,
    );
});
