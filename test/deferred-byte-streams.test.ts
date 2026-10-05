import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const deferredCapabilities = "runtime-throw" as const;
const family = `
let caught = 0, effects = 0, later = 0;
function bytes(): Uint8Array { effects++; return new Uint8Array([1,2,3]); }
function format(): CompressionFormat { effects++; return 'gzip'; }
try {
    const stream = new Blob([bytes()]).stream().pipeThrough(new CompressionStream(format()));
    new Response(stream).arrayBuffer();
} catch (error) {
    if (!error.message.includes('dom:Blob.stream')) throw error;
    caught++;
}
try {
    const transform = new CompressionStream(format());
    const stored: CompressionStream[] = [transform];
    const streams: ReadableStream<Uint8Array<ArrayBuffer>>[] = [stored[0]!.readable];
    streams[0]!.pipeThrough(new DecompressionStream('gzip'));
} catch (error) {
    if (!error.message.includes('dom:CompressionStream.constructor')) throw error;
    caught++;
}
try {
    const transform = new DecompressionStream(format());
    const stream = transform.readable;
    new Response(stream).arrayBuffer();
} catch (error) {
    if (!error.message.includes('dom:DecompressionStream.constructor')) throw error;
    caught++;
}
const missing: Array<ReadableStream<Uint8Array<ArrayBuffer>> | undefined> = [undefined];
missing[0]?.pipeThrough(new CompressionStream(format()));
later++;
if (caught !== 3 || effects !== 3 || later !== 1) throw new Error('byte stream ordering');
async function inflate(input: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
let rejected = 0;
inflate(new Uint8Array([1])).catch(error => {
    if (!error.message.includes('dom:Blob.stream')) throw error;
    rejected++;
});
if (rejected !== 0) throw new Error('synchronous rejection reaction');
setTimeout(() => {
    if (rejected !== 1) throw new Error('missing stream rejection');
    globalThis.close();
}, 0);
`;

test("deferred byte pipelines retain every typed boundary and throw before later operands", () => {
    assert.throws(() => compileSource(family), /stream|Unsupported/);
    const result = compileSource(family, { deferredCapabilities });
    const sites = result.manifest.deferredCapabilities ?? [];
    assert.deepEqual(
        new Set(sites.map((site) => site.id)),
        new Set([
            "dom:Blob.stream",
            "dom:ReadableStream.pipeThrough",
            "dom:CompressionStream.constructor",
            "dom:DecompressionStream.constructor",
            "dom:CompressionStream.readable",
            "dom:DecompressionStream.readable",
            "dom:Response.constructor",
        ]),
    );
    assert.ok(sites.every((site) => site.timing === "throw"));
    assert.match(
        result.cpp,
        /std::shared_ptr<bbl::DeferredReadableByteStream>/,
    );
    assert.throws(
        () =>
            compileSource(family + "new FinalizationRegistry(() => {});", {
                deferredCapabilities,
            }),
        /Unsupported constructor/,
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "deferred-byte-streams/family",
        result.cpp +
            `
        namespace bbl::pal {
        int run_window_application(WorkerEntry initialize, EngineOptions) {
            const js::RealmScope scope;
            EventLoop loop;
            WorkerRealm realm(loop);
            loop.run([&] { initialize(realm); });
            return 0;
        }
        }
    `,
        {
            defines: ["BBLITE_WORKERS=1"],
            expectedOutput: "",
            timeoutMs: 10000,
        },
    );
});

test("packaged Body.body throws without consuming bytes or evaluating its fallback", () => {
    const directory = resolve("artifacts/deferred-byte-streams/static");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "bytes.bin"), Buffer.from([7, 8, 9]));
    const source = `
        let fallback = 0, caught = 0, after = 0;
        function bytes(): Uint8Array { fallback++; return new Uint8Array([1]); }
        async function read(): Promise<void> {
            const response = await fetch('./bytes.bin');
            try {
                const stream = response.body ?? new Blob([bytes()]).stream();
                stream.pipeThrough(new DecompressionStream('gzip'));
            } catch (error) {
                if (!error.message.includes('dom:Body.body')) throw error;
                caught++;
            }
            const original = new Uint8Array(await response.arrayBuffer());
            if (original.length !== 3 || original[0] !== 7) throw new Error('body consumed');
            after++;
        }
        read();
        if (fallback !== 0 || caught !== 1 || after !== 1) throw new Error('body boundary ordering');
    `;
    const options = { fileName: join(directory, "entry.ts") };
    assert.throws(
        () => compileSource(source, options),
        /body|static-fetch-response/,
    );
    const result = compileSource(source, { ...options, deferredCapabilities });
    assert.ok(
        result.manifest.deferredCapabilities?.some(
            (site) => site.id === "dom:Body.body" && site.operation === "read",
        ),
    );
    assert.ok(!result.manifest.features.includes("platform:http"));
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "deferred-byte-streams/static-body",
        result.cpp +
            `
        namespace bbl {
        std::string asset_path(const std::string& path) { return path; }
        namespace pal {
        std::vector<std::uint8_t> read_binary_file(const std::string&) { return {7,8,9}; }
        }
        }
    `,
        { expectedOutput: "", timeoutMs: 10000 },
    );
});

test("byte stream admission refuses other payloads and preserves authored stream names", () => {
    for (const chunk of ["string", "unknown", "number"]) {
        assert.throws(
            () =>
                compileSource(
                    `
            const stream = new Blob(['x']).stream() as unknown as ReadableStream<${chunk}>;
            new Response(stream);
        `,
                    { deferredCapabilities },
                ),
            /represented|native|data|Unsupported|owned/,
        );
    }
    const authored = compileSource(
        `
        class CompressionStream { constructor(readonly label: string) {} }
        const source = {stream: () => ({pipeThrough: (transform: CompressionStream) => transform.label})};
        if (source.stream().pipeThrough(new CompressionStream('authored')) !== 'authored') throw new Error('authored stream');
    `,
        { deferredCapabilities },
    );
    assert.equal(authored.manifest.deferredCapabilities, undefined);
    assert.throws(
        () => compileSource("new Response('text');", { deferredCapabilities }),
        /Unsupported constructor/,
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "deferred-byte-streams/authored", authored.cpp, {
        expectedOutput: "",
    });
});
