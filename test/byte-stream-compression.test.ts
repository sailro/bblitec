import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gunzipSync, gzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runNativeFixtureCompiler,
    serveHttpFixture,
} from "./native-fixture.js";

/** The fixture's deterministic payload, in the program and here. */
function payload(length: number): Buffer {
    const bytes = Buffer.alloc(length);
    for (let index = 0; index < length; index++)
        bytes[index] = (index % 97) + ((index >> 11) % 3) * 50;
    return bytes;
}

const pipelines = `
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function compress(bytes: Uint8Array, format: CompressionFormat): Promise<Uint8Array> {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function decompress(bytes: Uint8Array, format: CompressionFormat): Promise<Uint8Array> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function decompressGzipResponse(response: Response): Promise<Uint8Array> {
    if (/\\bgzip\\b/i.test(response.headers?.get("content-encoding") ?? "")) {
        return new Uint8Array(await response.arrayBuffer());
    }
    const compressed = response.body ?? new Blob([await response.arrayBuffer()]).stream();
    const stream = compressed.pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
`;

test("byte pipelines lower in strict mode and refuse unlowered stream forms", () => {
    const result = compileSource(
        `${pipelines}
        void deflateRaw(new Uint8Array(1)).then(inflateRaw);
        void compress(new Uint8Array(1), "gzip").then((bytes) => decompress(bytes, "gzip"));
        void fetch("https://example.test/bundle.gz", {}).then(decompressGzipResponse);
    `,
    );
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.ok(result.manifest.features.includes("platform:compression"));
    assert.ok(
        result.manifest.runtimeSources.includes("src/pal_compression.cpp"),
    );
    assert.match(result.cpp, /#include <bblite\/pal_compression\.hpp>/);
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "native-compression-streams",
        ),
    );
    // A Blob stream and a stream Response alone link no compression library.
    const plain = compileSource(`
        void new Response(new Blob(["text"]).stream()).text();
    `);
    assert.ok(!plain.manifest.features.includes("platform:compression"));
    assert.ok(
        !plain.manifest.runtimeSources.includes("src/pal_compression.cpp"),
    );
    const refusals: [string, RegExp][] = [
        [`new Response("text");`, /other bodies are not lowered/],
        [
            `new Response(new Blob([]).stream(), JSON.parse("{}") as ResponseInit);`,
            /A Response init is lowered from a record of status, statusText and headers/,
        ],
        [
            `new Blob([]).stream().pipeThrough(new CompressionStream("gzip"), { preventClose: true });`,
            /pipeThrough options are not lowered/,
        ],
        [
            `const pair = { readable: new Blob([]).stream(), writable: new WritableStream<Uint8Array>() };
             new Blob([]).stream().pipeThrough(pair);`,
            /CompressionStream or DecompressionStream transform|Unsupported/,
        ],
        [
            `new CompressionStream("gzip").writable;`,
            /writable side is not lowered/,
        ],
        [`new Blob([]).stream().tee();`, /ReadableStream\.tee is not lowered/],
    ];
    for (const [source, message] of refusals)
        assert.throws(() => compileSource(source), message, source);
});

test("byte stream admission refuses other payloads and preserves authored stream names", () => {
    for (const chunk of ["string", "unknown", "number"]) {
        assert.throws(
            () =>
                compileSource(`
            const stream = new Blob(['x']).stream() as unknown as ReadableStream<${chunk}>;
            new Response(stream);
        `),
            /represented|native|data|Unsupported|owned|byte ReadableStream/,
        );
    }
    const authored = compileSource(`
        class CompressionStream { constructor(readonly label: string) {} }
        const source = {stream: () => ({pipeThrough: (transform: CompressionStream) => transform.label})};
        if (source.stream().pipeThrough(new CompressionStream('authored')) !== 'authored') throw new Error('authored stream');
    `);
    assert.ok(!authored.manifest.features.includes("platform:compression"));
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "byte-stream-compression/authored",
        authored.cpp,
        {
            expectedOutput: "",
        },
    );
});

test("packaged response headers and bodies promote an entry to its application realm", async () => {
    const directory = resolve("artifacts/byte-stream-compression/headers");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "payload.bin"), Buffer.from([31, 139, 8]));
    const source = `
        let keys = 0, after = 0;
        function headerName(): string { keys++; return 'content-encoding'; }
        async function run(): Promise<void> {
            const response = await fetch('./payload.bin');
            if (response.headers?.get(headerName()) !== null || keys !== 1) throw new Error('packaged header');
            const reader = response.body!.getReader();
            const part = await reader.read();
            if (part.done || part.value.length !== 3 || part.value[1] !== 139) throw new Error('packaged body');
            if (!(await reader.read()).done) throw new Error('packaged end');
            after++;
            globalThis.close();
        }
        run();
    `;
    const result = compileSource(source, {
        fileName: join(directory, "entry.ts"),
    });
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.ok(result.manifest.features.includes("platform:packaged-fetch"));
    assert.ok(!result.manifest.features.includes("platform:http"));
    assert.ok(!result.manifest.features.includes("platform:compression"));
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    await runPackaged(tools, directory, result, []);
});

test("Headers values keep native nullable storage and authored names keep their implementation", () => {
    const source = `
        const reads:Array<(headers:Headers)=>string|null>=[headers=>headers.get('content-type')];
        const optional:Array<(headers:Headers|undefined)=>boolean|undefined>=[headers=>headers?.has('content-type')];
        if(optional[0]!(undefined)!==undefined)throw new Error('absent Headers');
        class LocalHeaders {get(key:string):string|null{return key==='content-type'?'image/png':null;}}
        const local=new LocalHeaders();
        const response={headers:local};
        if(response.headers.get('content-type')!=='image/png')throw new Error('authored method');
    `;
    const result = compileSource(source);
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.match(result.cpp, /bbl::pal::HttpHeaders/);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "byte-stream-compression/retained", result.cpp, {
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

test("compression streams run the application's byte pipelines natively", async (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip(
            "The native compiler and the development vcpkg install are required.",
        );
        return;
    }
    // Native console output is erased: the program posts its report here.
    let report: string | undefined;
    const base = await serveHttpFixture(t, (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => (body += chunk));
        request.on("end", () => {
            report = body;
            response.end();
        });
    });
    const directory = resolve("artifacts/byte-stream-compression/pipelines");
    mkdirSync(directory, { recursive: true });
    // Standard gzip output, served as a packaged file with no Content-Encoding.
    writeFileSync(join(directory, "bundle.bin.gz"), gzipSync(payload(300000)));
    const source = `${pipelines}
function payload(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++)
        bytes[index] = (index % 97) + ((index >> 11) % 3) * 50;
    return bytes;
}
function same(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++)
        if (left[index] !== right[index]) return false;
    return true;
}
function hex(bytes: Uint8Array): string {
    let text = "";
    for (let index = 0; index < bytes.length; index++)
        text += (bytes[index]! < 16 ? "0" : "") + bytes[index]!.toString(16);
    return text;
}
function described(error: unknown): string {
    return error instanceof TypeError ? "TypeError: " + error.message : "other";
}
async function responseFailure(work: () => Promise<Uint8Array>): Promise<string> {
    try {
        await work();
    } catch (error) {
        return described(error);
    }
    return "fulfilled";
}
async function readerFailure(bytes: Uint8Array, format: CompressionFormat): Promise<string> {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
    try {
        for (;;) if ((await reader.read()).done) return "done";
    } catch (error) {
        return described(error);
    }
}
function thrown(work: () => void): string {
    try {
        work();
    } catch (error) {
        return described(error);
    }
    return "returned";
}
let formatName = "br";
async function run(): Promise<void> {
    const lines: string[] = [];
    const response = await fetch("./bundle.bin.gz");
    if (!response.ok || response.headers.has("content-encoding")) throw new Error("packaged headers");
    if (!same(await decompressGzipResponse(response), payload(300000))) throw new Error("packaged gzip body");
    if (!response.bodyUsed || response.body!.locked) throw new Error("packaged body after the pipe");

    for (const length of [0, 1, 100000]) {
        const original = payload(length);
        const packed = await deflateRaw(original);
        if (!same(await inflateRaw(packed), original)) throw new Error("deflate-raw " + length);
        lines.push("deflate-raw " + length + " " + hex(packed));
    }
    for (const format of ["gzip", "deflate"] as const) {
        const packed = await compress(payload(100000), format);
        if (!same(await decompress(packed, format), payload(100000))) throw new Error(format);
        lines.push(format + " 100000 " + hex(packed));
    }
    const gzip = await compress(payload(5000), "gzip");

    const chained = new Blob([payload(200000)]).stream()
        .pipeThrough(new CompressionStream("deflate"))
        .pipeThrough(new DecompressionStream("deflate"));
    const reader = chained.getReader();
    let chunks = 0, total = 0, largest = 0;
    for (;;) {
        const part = await reader.read();
        if (part.done) break;
        chunks++;
        total += part.value.byteLength;
        largest = Math.max(largest, part.value.byteLength);
    }
    lines.push("chunks " + chunks + " " + largest);
    if (total !== 200000) throw new Error("chunked total " + total);

    const trailing = new Uint8Array(gzip.length + 1);
    trailing.set(gzip);
    lines.push("corrupt " + await readerFailure(new Uint8Array([1, 2, 3, 4, 5, 6]), "gzip"));
    lines.push("truncated " + await readerFailure(gzip.slice(0, gzip.length - 4), "gzip"));
    lines.push("trailing " + await readerFailure(trailing, "gzip"));
    lines.push("empty " + await readerFailure(new Uint8Array(0), "deflate-raw"));
    lines.push("response " + await responseFailure(() => decompress(new Uint8Array([1, 2, 3, 4, 5, 6]), "gzip")));
    lines.push("compression-format " + thrown(() => new CompressionStream(formatName as CompressionFormat)));
    lines.push("decompression-format " + thrown(() => new DecompressionStream(formatName as CompressionFormat)));

    const source = new Blob([payload(10)]).stream();
    const transform = new CompressionStream("gzip");
    const readable = source.pipeThrough(transform);
    if (!source.locked || transform.readable !== readable) throw new Error("pipe lock");
    lines.push("locked " + thrown(() => source.pipeThrough(new DecompressionStream("gzip"))));
    const other = new Blob([payload(10)]).stream();
    lines.push("writable " + thrown(() => other.pipeThrough(transform)) + (other.locked ? " locked" : " unlocked"));
    lines.push("disturbed " + thrown(() => new Response(source)));
    const wrapped = new Response(readable);
    if (wrapped.body !== readable || wrapped.status !== 200 || !wrapped.ok || wrapped.bodyUsed) throw new Error("response");
    if (wrapped.headers.get("content-type") !== null || wrapped.url !== "") throw new Error("response headers");
    const bytes = new Uint8Array(await wrapped.arrayBuffer());
    if (!wrapped.bodyUsed || !same(await decompress(bytes, "gzip"), payload(10))) throw new Error("wrapped body");
    if (source.locked) throw new Error("finished pipe keeps its source locked");
    lines.push("consumed " + await responseFailure(async () => new Uint8Array(await wrapped.arrayBuffer())));
    // A finished transform cancels a later source; a canceled one cancels its source.
    const later = new Blob([gzip]).stream();
    if (later.pipeThrough(transform) !== readable || later.locked || !(await later.getReader().read()).done)
        throw new Error("pipe into a finished transform");
    const canceledSource = new Blob([gzip]).stream();
    const canceled = canceledSource.pipeThrough(new DecompressionStream("gzip")).getReader();
    await canceled.cancel();
    if (!(await canceled.read()).done || canceledSource.locked) throw new Error("canceled transform");

    const order: string[] = [];
    function input(): Uint8Array { order.push("input"); return payload(4); }
    function format(): CompressionFormat { order.push("format"); return "gzip"; }
    await new Response(new Blob([input()]).stream().pipeThrough(new CompressionStream(format()))).arrayBuffer();
    lines.push("order " + order.join());
    await fetch("${base}/report", { method: "POST", body: lines.join("\\n") });
    globalThis.close();
}
run();
`;
    const result = compileSource(source, {
        fileName: join(directory, "entry.ts"),
    });
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.ok(result.manifest.features.includes("platform:compression"));
    await runPackaged(tools, directory, result, [
        "native/src/pal_compression.cpp",
        "native/src/pal_http.cpp",
        "/link",
        join(nativeFixtureVcpkgRoot, "lib/z.lib"),
        "winhttp.lib",
    ]);
    // Standard tools read every format the streams write.
    const standard = {
        "deflate-raw": inflateRawSync,
        gzip: gunzipSync,
        deflate: inflateSync,
    } as const;
    // `<format> <length> <hex>` or `<check> <result>`.
    const lines = new Map<string, string>();
    assert.ok(report !== undefined, "the program posted no report");
    for (const line of report.split("\n")) {
        const words = line.split(" ");
        const keyWords = Object.hasOwn(standard, words[0]!) ? 2 : 1;
        lines.set(
            words.slice(0, keyWords).join(" "),
            words.slice(keyWords).join(" "),
        );
    }
    for (const [key, length] of [
        ["deflate-raw", 0],
        ["deflate-raw", 1],
        ["deflate-raw", 100000],
        ["gzip", 100000],
        ["deflate", 100000],
    ] as const) {
        const written = Buffer.from(lines.get(`${key} ${length}`) ?? "", "hex");
        assert.deepEqual(standard[key](written), payload(length), key);
    }
    // zlib's gzip header, as Chromium's on Windows: no name, mtime 0, OS byte 10.
    assert.deepEqual(
        [...Buffer.from(lines.get("gzip 100000")!, "hex").subarray(0, 10)],
        [31, 139, 8, 0, 0, 0, 0, 0, 0, 10],
    );
    // Chromium's messages (measured on 155.0.8059.39).
    assert.deepEqual(
        Object.fromEntries(
            [...lines].filter(
                ([key]) => !Object.hasOwn(standard, key.split(" ")[0]!),
            ),
        ),
        {
            // Chunk count and largest chunk of the chained transforms' 200000 bytes.
            chunks: "4 65536",
            corrupt:
                "TypeError: The compressed data was not valid: incorrect header check.",
            truncated: "TypeError: Compressed input was truncated.",
            trailing: "TypeError: Junk found after end of compressed data.",
            empty: "TypeError: Compressed input was truncated.",
            response: "TypeError: Failed to fetch",
            "compression-format":
                "TypeError: Failed to construct 'CompressionStream': Unsupported compression format: 'br'",
            "decompression-format":
                "TypeError: Failed to construct 'DecompressionStream': Unsupported compression format: 'br'",
            locked: "TypeError: Failed to execute 'pipeThrough' on 'ReadableStream': Cannot pipe a locked stream",
            writable:
                "TypeError: Failed to execute 'pipeThrough' on 'ReadableStream': parameter 1's 'writable' is locked unlocked",
            disturbed:
                "TypeError: Failed to construct 'Response': Response body object should not be disturbed or locked",
            consumed: "TypeError: Response body has already been consumed.",
            order: "input,format",
        },
    );
});

/** Compile a packaged-fetch program with `extra` sources and libraries, then run it beside its assets. */
async function runPackaged(
    tools: NonNullable<ReturnType<typeof optionalNativeFixtureTools>>,
    directory: string,
    result: ReturnType<typeof compileSource>,
    extra: readonly string[],
): Promise<void> {
    for (const asset of result.manifest.assets) {
        const output = join(directory, asset.output);
        mkdirSync(dirname(output), { recursive: true });
        copyFileSync(resolve(directory, asset.source), output);
    }
    const cpp = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        cpp,
        "test/fixtures/packaged-fetch-check.cpp",
        ...extra,
    ]);
    // Asynchronous, so a loopback server in this process can answer it.
    const output = await promisify(execFile)(exe, {
        cwd: directory,
        encoding: "utf8",
        timeout: 30000,
        env: {
            ...tools.environment,
            PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools.environment.PATH ?? ""}`,
        },
    });
    assert.equal(output.stdout + output.stderr, "");
}
