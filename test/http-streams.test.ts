import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    serveHttpFixture,
} from "./native-fixture.js";

const LARGE_BYTES = 40 * 1024 * 1024;

test("fetch streams bodies, reads headers, honours abort and reuses connections", async (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const smallSockets = new Set<Socket>();
    let smallRequests = 0;
    let interrupted = 0;
    const base = await serveHttpFixture(t, (request, response, hold) => {
        const watchInterruption = () =>
            response.on("close", () => {
                if (!response.writableEnded) ++interrupted;
            });
        if (request.url === "/stream") {
            response.setHeader("content-type", "application/octet-stream");
            response.setHeader("x-multi", ["a", "b"]);
            response.write(Buffer.alloc(100_000, 1));
            setTimeout(() => response.write(Buffer.alloc(100_000, 2)), 20);
            setTimeout(() => response.end(Buffer.alloc(100_000, 3)), 40);
            return;
        }
        if (request.url === "/slow") {
            watchInterruption();
            response.writeHead(200, { "content-length": "1000000" });
            response.write(Buffer.alloc(10, 7));
            hold(response);
            return;
        }
        if (request.url === "/hang") {
            watchInterruption();
            hold(response);
            return;
        }
        if (request.url === "/large") {
            response.writeHead(200, { "content-length": String(LARGE_BYTES) });
            const block = Buffer.alloc(1024 * 1024, 5);
            let sent = 0;
            const pump = (): void => {
                while (sent < LARGE_BYTES) {
                    sent += block.length;
                    if (!response.write(block)) {
                        response.once("drain", pump);
                        return;
                    }
                }
                response.end();
            };
            pump();
            return;
        }
        if (request.url === "/small") {
            smallSockets.add(request.socket);
            ++smallRequests;
            response.end("ok");
            return;
        }
        if (request.url === "/empty") {
            response.writeHead(204);
            response.end();
            return;
        }
        response.writeHead(404);
        response.end();
    });
    const source = `
        async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<number> {
            let total = 0;
            for (;;) {
                const part = await reader.read();
                if (part.done) return total;
                total += part.value.byteLength;
            }
        }
        async function run(): Promise<void> {
            const response = await fetch("${base}/stream", {});
            if (response.status !== 200 || response.headers.get("Content-Type") !== "application/octet-stream") throw new Error("content type");
            if (response.headers.get("X-Multi") !== "a, b" || response.headers.get("missing") !== null || !response.headers.has("x-MULTI")) throw new Error("headers");
            const body = response.body;
            if (!body || response.body !== body || response.bodyUsed || body.locked) throw new Error("body identity");
            const reader = body.getReader();
            let locked = false;
            try { body.getReader(); } catch (error) { locked = error instanceof TypeError; }
            if (!locked || !body.locked) throw new Error("reader lock");
            const first = await reader.read();
            if (first.done || first.value.byteLength === 0 || first.value[0] !== 1) throw new Error("first chunk");
            const total = first.value.byteLength + await drain(reader);
            if (total !== 300000 || !response.bodyUsed) throw new Error("streamed total " + total);
            reader.releaseLock();
            if (body.locked) throw new Error("released lock");
            let consumed = false;
            try { await response.text(); } catch (error) { consumed = error instanceof TypeError; }
            if (!consumed) throw new Error("disturbed body read again");

            const early = new AbortController();
            const hanging = fetch("${base}/hang", { signal: early.signal });
            setTimeout(() => early.abort(), 50);
            let abortedEarly = false;
            try { await hanging; } catch (error) { abortedEarly = error instanceof DOMException && error.name === "AbortError"; }
            if (!abortedEarly) throw new Error("abort before the head");
            let alreadyAborted = false;
            try { await fetch("${base}/stream", { signal: early.signal }); } catch (error) { alreadyAborted = error instanceof DOMException && error.name === "AbortError"; }
            if (!alreadyAborted) throw new Error("aborted signal");

            const middle = new AbortController();
            const slow = await fetch("${base}/slow", { signal: middle.signal, cache: "no-store" });
            if (slow.headers.get("content-length") !== "1000000") throw new Error("declared length");
            const slowReader = slow.body!.getReader();
            const head = await slowReader.read();
            if (head.done || head.value.byteLength !== 10) throw new Error("slow head");
            const next = slowReader.read();
            // Abort cancels the transfer without waiting for its thread.
            const aborting = Date.now();
            middle.abort(new RangeError("stop"));
            if (Date.now() - aborting > 100) throw new Error("abort waited for the transport");
            let abortedRead = false;
            try { await next; } catch (error) { abortedRead = error instanceof RangeError && error.message === "stop"; }
            if (!abortedRead) throw new Error("abort mid-stream");
            let abortedAgain = false;
            try { await slowReader.read(); } catch (error) { abortedAgain = error instanceof RangeError; }
            if (!abortedAgain) throw new Error("errored stream");

            const canceled = await fetch("${base}/slow", {});
            const cancelReader = canceled.body!.getReader();
            await cancelReader.read();
            await cancelReader.cancel();
            const afterCancel = await cancelReader.read();
            if (!afterCancel.done || afterCancel.value !== undefined) throw new Error("canceled read");

            const unread = await fetch("${base}/stream", {});
            await unread.body!.cancel();
            if (!unread.bodyUsed) throw new Error("stream cancel disturbs");

            const empty = await fetch("${base}/empty", {});
            if (empty.status !== 204 || empty.body !== null || await empty.text() !== "") throw new Error("null body");

            const large = await fetch("${base}/large", {});
            if (await drain(large.body!.getReader()) !== ${LARGE_BYTES}) throw new Error("large body");

            const parallel = [0, 1, 2, 3, 4, 5].map(() => fetch("${base}/small", {}));
            for (const request of parallel) {
                const small = await request;
                if (await small.text() !== "ok") throw new Error("parallel");
            }
            for (let index = 0; index < 6; ++index) {
                const small = await fetch("${base}/small", {});
                if (await small.text() !== "ok") throw new Error("sequential");
            }
            globalThis.close();
        }
        run();
    `;
    const directory = resolve("artifacts/http-streams");
    mkdirSync(directory, { recursive: true });
    const entry = resolve(directory, "entry.ts");
    writeFileSync(entry, source);
    const compiled = compileSource(source, { fileName: entry });
    assert.equal(compiled.manifest.deferredCapabilities, undefined);
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
        timeout: 60000,
    });
    assert.equal(output.stdout + output.stderr, "");
    assert.equal(smallRequests, 12);
    assert.ok(
        smallSockets.size <= 6,
        `${smallSockets.size} connections served 12 requests`,
    );
    // The aborted head, the aborted and the canceled bodies close their transfers.
    await new Promise((done) => setTimeout(done, 200));
    assert.ok(interrupted >= 3, `${interrupted} interrupted transfers`);
});

/**
 * The realm stalls past the transport's 5 s no-progress timeout with a read
 * pending: the transport queues the first chunk, then fails, before the realm
 * runs the task that delivers the chunk. A read and an abort in the task that
 * observes the chunk still see the abort's reason, and an end the realm has
 * not observed yields to an abort the same way.
 */
test("an abort wins over a transfer end or failure the realm has not yet observed", async (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const base = await serveHttpFixture(t, (request, response, hold) => {
        if (request.url === "/slow") {
            response.writeHead(200, { "content-length": "1000" });
            response.write(Buffer.alloc(10, 7));
            hold(response);
            return;
        }
        response.end("abc");
    });
    const source = `
        function stall(milliseconds: number): void {
            const until = Date.now() + milliseconds;
            while (Date.now() < until) {}
        }
        function described(error: unknown): string {
            if (error instanceof RangeError) return "RangeError:" + error.message;
            if (error instanceof TypeError) return "TypeError:" + error.message;
            return "other";
        }
        async function abortAfter(url: string, milliseconds: number, bytes: number): Promise<void> {
            const controller = new AbortController();
            const response = await fetch(url, { signal: controller.signal });
            const reader = response.body!.getReader();
            const first = reader.read();
            stall(milliseconds);
            const head = await first;
            if (head.done || head.value.byteLength !== bytes) throw new Error(url + " head");
            const next = reader.read();
            controller.abort(new RangeError("stop"));
            let reason = "fulfilled";
            try { await next; } catch (error) { reason = described(error); }
            if (reason !== "RangeError:stop") throw new Error(url + " abort lost to " + reason);
        }
        async function run(): Promise<void> {
            await abortAfter("${base}/slow", 8000, 10);
            await abortAfter("${base}/short", 500, 3);
            globalThis.close();
        }
        run();
    `;
    const directory = resolve("artifacts/http-abort-order");
    mkdirSync(directory, { recursive: true });
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
        timeout: 60000,
    });
    assert.equal(output.stdout + output.stderr, "");
});

test("stream and signal forms without a native representation refuse", () => {
    for (const [body, message] of [
        [
            `const response = await fetch("https://example.com/a", {method:"GET"}); const reader = response.body!.getReader(); await reader.closed;`,
            /ReadableStreamDefaultReader.closed is not lowered/,
        ],
        [
            `const response = await fetch("https://example.com/a", {method:"GET"}); response.body!.getReader({ mode: "byob" });`,
            /reader options are not lowered/,
        ],
        [
            `const response = await fetch("https://example.com/a", {method:"GET"}); await response.body!.pipeTo(new WritableStream());`,
            /ReadableStream.pipeTo is not lowered/,
        ],
        [
            `const response = await fetch("https://example.com/a", {method:"GET"}); response.headers.forEach(() => {});`,
            /Headers.forEach is not lowered/,
        ],
    ] as const)
        assert.throws(
            () =>
                compileSource(
                    `async function run(): Promise<void> { ${body} } run();`,
                ),
            message,
        );
});
