import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import {
    lowerSplatStreamTransport,
    SPLAT_STREAM_TRANSPORT_MODULES,
} from "../src/lowering/splat-stream-records.js";
import {
    createJavaScriptFunction,
    transpileCommonJs,
} from "../src/typescript-transpile.js";
import { sharedUpstreamStore } from "../src/upstream-source.js";
import { webgpuFlagNamespaces } from "../src/webgpu-flags.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/**
 * The pinned splat-stream request manager and voxel collision lowered by the
 * record model, compiled with MSVC and run over deterministic fakes of
 * `bblite/splat_stream_platform.hpp`
 * (test/fixtures/splat-stream-transport-check.cpp), against the pinned
 * modules executed under Node over the same fakes written in JavaScript: a
 * virtual clock whose timers fire one per task with microtasks drained
 * between, a scripted fetch with streamed bodies and aborts, a WebP-header
 * image decoder and a logging GPU device. Equal logs are equal scheduling,
 * retries, preemption, admission, abort propagation and error wrapping.
 */

// ── The scenarios ──────────────────────────────────────────────────────

interface Variant {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: readonly number[];
    readonly chunkSize: number;
    readonly head: number;
    readonly chunk: number;
    readonly network?: boolean;
}

interface Step {
    readonly at: number;
    readonly op:
        | "create"
        | "request"
        | "promote"
        | "cancel"
        | "abort"
        | "dispose"
        | "collision";
    readonly url?: string;
    readonly fileId?: number;
    readonly generation?: number;
    readonly priority?: number;
    readonly distance?: number;
    readonly intervals?: readonly (readonly [number, number])[];
    readonly signal?: string;
    readonly custom?: boolean;
    readonly limits?: readonly [number, number, number, number];
    readonly ledger?: boolean;
    readonly reserveGpu?: boolean;
    readonly moves?: readonly Move[];
}

interface Move {
    readonly from: readonly [number, number, number];
    readonly to: readonly [number, number, number];
    readonly radius?: number;
}

interface Scenario {
    readonly name: string;
    readonly gpuBytes: number;
    readonly stale: string;
    readonly decodeDelay: number;
    readonly horizon: number;
    readonly resources: Readonly<Record<string, readonly Variant[]>>;
    readonly steps: readonly Step[];
}

const HOST = "https://splats.test/stream";
const metaUrl = (name: string): string => `${HOST}/${name}/meta.json`;
const IMAGE_FILES = [
    "means_l.webp",
    "means_u.webp",
    "scales.webp",
    "quats.webp",
    "sh0.webp",
] as const;

const bytesOf = (text: string): number[] => [...Buffer.from(text, "utf8")];

/** A 40-byte WebP head: VP8L (decodable by the fakes) or VP8X (not). */
function webp(width: number, height: number, kind = "VP8L"): number[] {
    const bytes = new Array<number>(40).fill(0);
    const put = (offset: number, text: string): void => {
        for (let index = 0; index < text.length; index++)
            bytes[offset + index] = text.charCodeAt(index);
    };
    const u32 = (offset: number, value: number, size = 4): void => {
        for (let index = 0; index < size; index++)
            bytes[offset + index] = Math.floor(value / 256 ** index) % 256;
    };
    put(0, "RIFF");
    u32(4, 32);
    put(8, "WEBP");
    put(12, kind);
    u32(16, 20);
    if (kind === "VP8L") {
        bytes[20] = 0x2f;
        u32(21, width - 1 + (height - 1) * 2 ** 14);
    } else {
        u32(24, width - 1, 3);
        u32(27, height - 1, 3);
    }
    return bytes;
}

function sogMeta(count: number): string {
    const codebook = Array.from(
        { length: 256 },
        (_, index) => (index - 128) / 16,
    );
    return JSON.stringify({
        version: 2,
        asset: { generator: "splat-transform v3.3.3" },
        count,
        means: {
            mins: [-1.5, -0.25, -2],
            maxs: [3, 1.75, 0.5],
            files: ["means_l.webp", "means_u.webp"],
        },
        scales: { codebook, files: ["scales.webp"] },
        quats: { files: ["quats.webp"] },
        sh0: {
            codebook: codebook.map((value) => value / 4),
            files: ["sh0.webp"],
        },
    });
}

function ok(
    body: readonly number[],
    type: string,
    options: Partial<Variant> = {},
): Variant {
    return {
        status: 200,
        headers: {
            "content-type": type,
            "content-length": String(body.length),
        },
        body,
        chunkSize: 1024,
        head: 4,
        chunk: 2,
        ...options,
    };
}

const failure = (status: number, body = true): Variant => ({
    status,
    headers: { "content-type": "text/plain" },
    ...(body ? { body: bytesOf(`status ${status}`) } : {}),
    chunkSize: 1024,
    head: 3,
    chunk: 1,
});

const NETWORK: Variant = {
    status: 0,
    headers: {},
    chunkSize: 1,
    head: 6,
    chunk: 1,
    network: true,
};

/** A loose SOG v2 source: its metadata and its five images. */
function source(
    name: string,
    options: {
        readonly size?: number;
        readonly count?: number;
        readonly meta?: readonly Variant[];
        readonly image?: readonly Variant[];
    } = {},
): Record<string, readonly Variant[]> {
    const size = options.size ?? 32;
    const resources: Record<string, readonly Variant[]> = {
        [metaUrl(name)]: options.meta ?? [
            ok(bytesOf(sogMeta(options.count ?? 1000)), "application/json"),
        ],
    };
    for (const file of IMAGE_FILES)
        resources[`${HOST}/${name}/${file}`] = options.image ?? [
            ok(webp(size, size), "image/webp", { head: 3, chunk: 1 }),
        ];
    return resources;
}

const request = (
    at: number,
    name: string,
    fileId: number,
    priority: number,
    extra: Partial<Step> = {},
): Step => ({
    at,
    op: "request",
    url: metaUrl(name),
    fileId,
    generation: 1,
    priority,
    intervals: [[0, 400]],
    ...extra,
});

/** Steps in time order, ties in authored order. */
const ordered = (steps: readonly Step[]): Step[] =>
    [...steps].sort((a, b) => a.at - b.at);

const create = (
    limits: readonly [number, number, number, number],
    extra: Partial<Step> = {},
): Step => ({ at: 0, op: "create", limits, ...extra });

function scenarios(): Scenario[] {
    const scheduling: Scenario = {
        name: "scheduling",
        gpuBytes: 10_000_000,
        stale: metaUrl("s7"),
        decodeDelay: 8,
        horizon: 5000,
        resources: Object.assign(
            {},
            ...["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((name) =>
                source(name),
            ),
        ) as Record<string, readonly Variant[]>,
        steps: [
            create([2, 1, 131072, 2]),
            request(0, "s1", 1, 4, { distance: 30, intervals: [[0, 1000]] }),
            request(0, "s2", 2, 3, { distance: 20 }),
            request(10, "s3", 3, 2),
            request(12, "s4", 4, 3, { distance: 5 }),
            request(13, "s3", 3, 3, { intervals: [[500, 100]] }),
            {
                at: 20,
                op: "promote",
                url: metaUrl("s1"),
                generation: 1,
                priority: 1,
            },
            {
                at: 21,
                op: "promote",
                url: metaUrl("s4"),
                generation: 1,
                priority: 3,
                distance: 2,
            },
            {
                at: 21,
                op: "promote",
                url: metaUrl("zz"),
                generation: 1,
                priority: 0,
            },
            {
                at: 21,
                op: "promote",
                url: "not a url",
                generation: 1,
                priority: 0,
            },
            { at: 22, op: "cancel", url: metaUrl("s4") },
            request(23, "s5", 5, 4, { signal: "a" }),
            { at: 24, op: "abort", signal: "a" },
            { at: 25, op: "abort", signal: "c" },
            request(25, "s6", 6, 4, { signal: "c" }),
            request(26, "s9", 9, 4, { url: "relative/meta.json" }),
            request(30, "s2", 2, 3, { generation: 2 }),
            request(31, "s7", 7, 2),
            request(40, "s8", 8, 1, { signal: "d" }),
            { at: 50, op: "abort", signal: "d", custom: true },
            { at: 60, op: "cancel", url: metaUrl("s3") },
            request(400, "s5", 5, 3, { generation: 2 }),
            request(400, "s6", 6, 4, { generation: 2, distance: 1 }),
        ],
    };
    const retries: Scenario = {
        name: "retries",
        gpuBytes: 10_000_000,
        stale: "",
        decodeDelay: 2,
        horizon: 20000,
        resources: Object.assign(
            {},
            source("r1", {
                meta: [
                    failure(503),
                    failure(503, false),
                    ok(bytesOf(sogMeta(1000)), "application/json"),
                ],
            }),
            source("r2", { meta: [failure(404)] }),
            source("r3", { meta: [NETWORK] }),
            source("r4", {
                meta: [
                    {
                        ...ok(bytesOf(sogMeta(1000)), "application/json"),
                        headers: {
                            "content-type": "application/json",
                            "content-length": "12x",
                        },
                    },
                ],
            }),
            source("r5", { meta: [ok(bytesOf("{"), "application/json")] }),
            source("r6", {
                image: [
                    ok(
                        bytesOf("not a webp image, only some text"),
                        "image/webp",
                    ),
                ],
            }),
            source("r7", {
                meta: [
                    {
                        ...ok(bytesOf(sogMeta(1000)), "application/json"),
                        headers: { "content-type": "application/json" },
                        chunkSize: 700,
                    },
                ],
            }),
            source("r8", { meta: [failure(404, false)] }),
            source("r9", { image: [ok(webp(32, 32, "VP8X"), "image/webp")] }),
            source("r10", {
                meta: [
                    ok(bytesOf(sogMeta(1000)), "application/json", {
                        chunk: 50,
                    }),
                ],
            }),
            source("r11", {
                meta: [
                    failure(503),
                    ok(bytesOf(sogMeta(1000)), "application/json"),
                ],
            }),
            source("r12", { meta: [failure(500)] }),
            source("r13", {
                meta: [
                    failure(429),
                    NETWORK,
                    ok(bytesOf(sogMeta(1000)), "application/json"),
                ],
            }),
        ) as Record<string, readonly Variant[]>,
        steps: ordered([
            create([1, 1, 131072, 2]),
            ...Array.from({ length: 13 }, (_, index) =>
                request(index * 1000, `r${index + 1}`, index + 1, 2, {
                    signal: `r${index + 1}`,
                }),
            ),
            { at: 9030, op: "abort", signal: "r10" },
            { at: 10050, op: "abort", signal: "r11" },
        ]),
    };
    const admission: Scenario = {
        name: "admission",
        gpuBytes: 120_000,
        stale: metaUrl("a3"),
        decodeDelay: 3,
        horizon: 5000,
        resources: Object.assign(
            {},
            source("big", { size: 64, count: 4000 }),
            ...["a1", "a2", "a3", "boot", "q1", "q2", "q3"].map((name) =>
                source(name),
            ),
        ) as Record<string, readonly Variant[]>,
        steps: [
            create([0, 1, 131072, 0]),
            create([2, 2, 131072, 1.5]),
            create([2, 2, 131072, 0], { ledger: false, reserveGpu: true }),
            create([2, 2, 131072, 0], { reserveGpu: true }),
            request(0, "big", 1, 2, { intervals: [[0, 4000]] }),
            request(0, "a1", 2, 3),
            request(5, "boot", 3, 0),
            request(200, "a2", 4, 3),
            request(200, "a3", 5, 2),
            request(400, "q1", 6, 2),
            request(400, "q2", 7, 3),
            request(400, "q3", 8, 4),
            { at: 410, op: "dispose" },
            { at: 411, op: "dispose" },
            request(412, "q1", 6, 2),
        ],
    };
    return [scheduling, retries, admission, collisionScenario()];
}

// ── The voxel scenario ─────────────────────────────────────────────────

const SOLID = 0xff000000;

/** A depth-1 octree over [0, 4]^3: a solid block, a slab leaf, the rest empty. */
function voxelFiles(nodes: readonly number[], masks: readonly number[]) {
    const header = {
        version: "1.1",
        leafSize: 4,
        gridBounds: { min: [0, 0, 0], max: [4, 4, 4] },
        voxelResolution: 0.5,
        treeDepth: 1,
        nodeCount: nodes.length,
        leafDataCount: masks.length,
    };
    const words = [...nodes, ...masks];
    const binary: number[] = [];
    for (const word of words)
        for (let index = 0; index < 4; index++)
            binary.push(Math.floor(word / 256 ** index) % 256);
    return { header: bytesOf(JSON.stringify(header)), binary };
}

function collisionScenario(): Scenario {
    const world = voxelFiles([3 * 2 ** 24 + 1, SOLID, 0], [0x0000ffff, 0]);
    const broken = voxelFiles([1 * 2 ** 24 + 1, 0], [0x1, 0]);
    const voxel = (name: string): string => `${HOST}/scene/${name}`;
    return {
        name: "collision",
        gpuBytes: 1,
        stale: "",
        decodeDelay: 0,
        horizon: 5000,
        resources: {
            [voxel("world.voxel.json?v=3")]: [
                ok(world.header, "application/json"),
            ],
            [voxel("world.voxel.bin?v=3")]: [
                ok(world.binary, "application/octet-stream", { chunkSize: 8 }),
            ],
            [voxel("short.voxel.json")]: [ok(world.header, "application/json")],
            [voxel("short.voxel.bin")]: [
                ok(world.binary.slice(0, 16), "application/octet-stream"),
            ],
            [voxel("long.voxel.json")]: [ok(world.header, "application/json")],
            [voxel("long.voxel.bin")]: [
                {
                    ...ok(world.binary, "application/octet-stream"),
                    headers: { "content-length": "4096" },
                },
            ],
            [voxel("missing.voxel.json")]: [failure(404)],
            [voxel("broken.voxel.json")]: [
                ok(broken.header, "application/json"),
            ],
            [voxel("broken.voxel.bin")]: [
                ok(broken.binary, "application/octet-stream"),
            ],
            [voxel("slow.voxel.json")]: [ok(world.header, "application/json")],
            [voxel("slow.voxel.bin")]: [
                ok(world.binary, "application/octet-stream", {
                    chunkSize: 4,
                    chunk: 10,
                }),
            ],
        },
        steps: [
            {
                at: 0,
                op: "collision",
                url: voxel("world.voxel.json?v=3"),
                moves: [
                    { from: [3, 3, 3], to: [3, 3, -1] },
                    { from: [3, 1, 3], to: [1, 1, 1] },
                    { from: [3, 1, 3], to: [3, 1, 0.1], radius: 0.25 },
                    { from: [1, 3, 3], to: [1, 0.5, 3] },
                    { from: [3.5, 3.5, 3.5], to: [9, 9, 9] },
                    { from: [3, 3, 3], to: [3, 3, 3] },
                    { from: [3, 3, 3], to: [1, 1, 1], radius: -1 },
                    { from: [3, 3, 3], to: [1, 1, 1], radius: 0 },
                ],
            },
            { at: 100, op: "collision", url: voxel("world.json") },
            { at: 101, op: "collision", url: "ftp://splats.test/a.voxel.json" },
            { at: 102, op: "collision", url: voxel("missing.voxel.json") },
            { at: 103, op: "collision", url: voxel("short.voxel.json") },
            { at: 104, op: "collision", url: voxel("long.voxel.json") },
            { at: 105, op: "collision", url: voxel("broken.voxel.json") },
            {
                at: 200,
                op: "collision",
                url: voxel("slow.voxel.json"),
                signal: "v",
            },
            { at: 230, op: "abort", signal: "v" },
        ],
    };
}

// ── The pinned modules over JavaScript fakes ───────────────────────────

type Exports = Record<string, unknown>;
type Callable = (...args: never[]) => unknown;

const transpiled = new Map<string, string>();

/** The pinned modules as CommonJS, their web globals bound to `globals`. */
function pinnedModules(
    globals: Readonly<Record<string, unknown>>,
): Map<string, Exports> {
    const store = sharedUpstreamStore();
    const loaded = new Map<string, Exports>();
    const names = Object.keys(globals);
    const load = (module: string): Exports => {
        const known = loaded.get(module);
        if (known) return known;
        const exports: Exports = {};
        loaded.set(module, exports);
        const require = (specifier: string): Exports => {
            const target = store.resolveImport(module, specifier);
            if (!target)
                throw new Error(`${module} imports unresolved ${specifier}.`);
            return load(target);
        };
        let code = transpiled.get(module);
        if (code === undefined) {
            code = transpileCommonJs(store.getSource(module), module);
            transpiled.set(module, code);
        }
        createJavaScriptFunction(
            "exports",
            "require",
            ...names,
            code,
        )(exports, require, ...names.map((name) => globals[name]));
        return exports;
    };
    for (const module of SPLAT_STREAM_TRANSPORT_MODULES) load(module);
    load("src/loader-splat-stream/splat-stream-gpu-ledger.ts");
    return loaded;
}

function exported<T extends Callable>(
    modules: Map<string, Exports>,
    module: string,
    name: string,
): T {
    const value = modules.get(module)?.[name];
    if (typeof value !== "function")
        throw new Error(`${module} does not export ${name}.`);
    return value as T;
}

const num = (value: number): string =>
    Object.is(value, -0) ? "-0" : String(value);

interface Timer {
    readonly id: number;
    readonly due: number;
    readonly callback: () => void;
}

interface FakeListener {
    readonly listener: () => void;
    readonly once: boolean;
}

interface PinnedSource {
    readonly width: number;
    readonly height: number;
    readonly count: number;
    readonly gpuBytes: number;
    readonly textures: readonly unknown[];
    readonly _gpuReserved?: boolean;
    readonly meansMin: Float32Array;
    readonly meansMax: Float32Array;
}

interface PinnedManager {
    readonly cpuBytes: number;
    readonly fetchedBytes: number;
    readonly pendingRequests: number;
    readonly queuedFiles: number;
    readonly disposed: boolean;
    request(request: unknown): Promise<PinnedSource>;
    promote(
        url: string,
        generation: number,
        priority: number,
        distance?: number,
    ): boolean;
    cancel(url: string): void;
    dispose(): void;
}

interface PinnedLedger {
    readonly residentBytes: number;
    readonly allocatedBytes: number;
    readonly heldBytes: number;
    tryReserve(bytes: number): boolean;
}

interface PinnedCollision {
    readonly min: readonly number[];
    readonly max: readonly number[];
    readonly resolution: number;
    readonly depth: number;
    readonly nodes: Uint32Array;
    readonly masks: Uint32Array;
}

async function pinnedRun(scenario: Scenario): Promise<string> {
    const events: string[] = [];
    const out = (line: string): void => {
        events.push(line);
    };

    // The virtual clock.
    let now = 0;
    let nextTimer = 0;
    const timers: Timer[] = [];
    const schedule = (milliseconds: number, callback: () => void): number => {
        const id = ++nextTimer;
        timers.push({ id, due: now + Math.max(0, milliseconds), callback });
        return id;
    };
    const unschedule = (id: number): void => {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index >= 0) timers.splice(index, 1);
    };
    const takeTimer = (limit: number): Timer | undefined => {
        let best: Timer | undefined;
        for (const timer of timers)
            if (
                timer.due <= limit &&
                (!best ||
                    timer.due < best.due ||
                    (timer.due === best.due && timer.id < best.id))
            )
                best = timer;
        if (best) timers.splice(timers.indexOf(best), 1);
        return best;
    };

    // DOMException and the abort signal.
    class FakeDOMException extends Error {
        constructor(message = "", name = "Error") {
            super(message);
            this.name = name;
        }
    }
    class FakeAbortSignal {
        aborted = false;
        reason: Error | undefined = undefined;
        listeners: FakeListener[] = [];
        addEventListener(
            type: string,
            listener: () => void,
            options?: { once?: boolean },
        ): void {
            if (type !== "abort")
                throw new Error("Only abort listeners are admitted.");
            if (this.listeners.some((entry) => entry.listener === listener))
                return;
            this.listeners.push({ listener, once: options?.once ?? false });
        }
        removeEventListener(type: string, listener: () => void): void {
            if (type !== "abort")
                throw new Error("Only abort listeners are admitted.");
            this.listeners = this.listeners.filter(
                (entry) => entry.listener !== listener,
            );
        }
    }
    class FakeAbortController {
        readonly signal = new FakeAbortSignal();
        abort(reason?: Error): void {
            const signal = this.signal;
            if (signal.aborted) return;
            signal.aborted = true;
            signal.reason =
                reason === undefined
                    ? new FakeDOMException(
                          "This operation was aborted",
                          "AbortError",
                      )
                    : reason;
            for (const entry of [...signal.listeners]) {
                if (!signal.listeners.includes(entry)) continue;
                if (entry.once)
                    signal.listeners = signal.listeners.filter(
                        (other) => other !== entry,
                    );
                entry.listener();
            }
        }
    }

    /** An aborted signal's reason (every abort sets one). */
    const reasonOf = (signal: FakeAbortSignal): Error =>
        signal.reason ?? new Error("The signal was not aborted.");

    // fetch and its streamed bodies.
    class FakeStream {
        readonly chunks: Uint8Array[] = [];
        next = 0;
        canceled = false;
        error: Error | undefined = undefined;
        pending: { id: number; reject: (reason: Error) => void } | undefined;
        constructor(
            readonly url: string,
            readonly delay: number,
            body: readonly number[],
            size: number,
        ) {
            for (let start = 0; start < body.length; start += size)
                this.chunks.push(
                    Uint8Array.from(body.slice(start, start + size)),
                );
        }
        cancel(): Promise<void> {
            out(`body-cancel ${this.url}`);
            this.canceled = true;
            return Promise.resolve();
        }
        getReader(): FakeReader {
            return new FakeReader(this);
        }
        fail(reason: Error): void {
            if (this.error) return;
            this.error = reason;
            const pending = this.pending;
            if (pending) {
                this.pending = undefined;
                unschedule(pending.id);
                pending.reject(reason);
            }
        }
    }
    class FakeReader {
        constructor(readonly stream: FakeStream) {}
        read(): Promise<{ done: boolean; value: Uint8Array | undefined }> {
            const stream = this.stream;
            if (stream.error) return Promise.reject(stream.error);
            return new Promise((resolveRead, rejectRead) => {
                const id = schedule(stream.delay, () => {
                    stream.pending = undefined;
                    if (stream.canceled || stream.next >= stream.chunks.length)
                        resolveRead({ done: true, value: undefined });
                    else
                        resolveRead({
                            done: false,
                            value: stream.chunks[stream.next++]!,
                        });
                });
                stream.pending = { id, reject: rejectRead };
            });
        }
        cancel(): Promise<void> {
            out(`reader-cancel ${this.stream.url}`);
            this.stream.canceled = true;
            return Promise.resolve();
        }
        releaseLock(): void {
            out(`release ${this.stream.url}`);
        }
    }
    class FakeResponse {
        readonly ok: boolean;
        readonly status: number;
        readonly body: FakeStream | null;
        readonly headers: { get(name: string): string | null };
        constructor(
            readonly url: string,
            variant: Variant,
        ) {
            this.status = variant.status;
            this.ok = variant.status >= 200 && variant.status <= 299;
            this.headers = {
                get: (name) => variant.headers[name] ?? null,
            };
            this.body = variant.body
                ? new FakeStream(
                      url,
                      variant.chunk,
                      variant.body,
                      variant.chunkSize,
                  )
                : null;
        }
    }
    const attempts = new Map<string, number>();
    const fetch = (
        input: string | URL,
        init?: { signal?: FakeAbortSignal },
    ): Promise<FakeResponse> => {
        const url = typeof input === "string" ? input : input.href;
        out(`fetch ${url}`);
        const variants = scenario.resources[url];
        if (!variants) throw new Error(`No scripted resource ${url}`);
        const attempt = attempts.get(url) ?? 0;
        attempts.set(url, attempt + 1);
        const variant = variants[Math.min(attempt, variants.length - 1)]!;
        const signal = init?.signal;
        if (signal?.aborted) return Promise.reject(reasonOf(signal));
        const response = new FakeResponse(url, variant);
        let settled = false;
        return new Promise((resolveFetch, rejectFetch) => {
            if (signal)
                signal.addEventListener(
                    "abort",
                    () => {
                        if (!settled) {
                            settled = true;
                            rejectFetch(reasonOf(signal));
                        } else response.body?.fail(reasonOf(signal));
                    },
                    { once: true },
                );
            schedule(variant.head, () => {
                if (settled) return;
                settled = true;
                if (variant.network)
                    rejectFetch(new TypeError("Failed to fetch"));
                else resolveFetch(response);
            });
        });
    };

    // Blob, image decoding, text decoding.
    class FakeBlob {
        readonly bytes: Uint8Array;
        readonly type: string;
        constructor(parts: readonly Uint8Array[], options?: { type?: string }) {
            this.bytes = Uint8Array.from(parts.flatMap((part) => [...part]));
            this.type = options?.type ?? "";
        }
        text(): Promise<string> {
            return Promise.resolve(Buffer.from(this.bytes).toString("utf8"));
        }
    }
    const createImageBitmap = (
        blob: FakeBlob,
        options: Record<string, string>,
    ): Promise<{ width: number; height: number; close(): void }> => {
        out(
            `decode ${blob.bytes.length} ${blob.type} ${options.premultiplyAlpha} ${options.colorSpaceConversion} ${options.imageOrientation}`,
        );
        const b = blob.bytes;
        if (
            b.length < 25 ||
            Buffer.from(b.subarray(12, 16)).toString("latin1") !== "VP8L"
        )
            return Promise.reject(
                new FakeDOMException(
                    "The source image could not be decoded.",
                    "InvalidStateError",
                ),
            );
        const bits =
            (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >>> 14) & 0x3fff) + 1;
        return new Promise((resolveBitmap) => {
            schedule(scenario.decodeDelay, () =>
                resolveBitmap({
                    width,
                    height,
                    close: () => out(`close ${num(width)}x${num(height)}`),
                }),
            );
        });
    };
    class FakeTextDecoder {
        decode(bytes: Uint8Array): string {
            return Buffer.from(bytes).toString("utf8");
        }
    }

    // Timers and the GPU device.
    const setTimeout = (callback: () => void, milliseconds: number): number => {
        out(`timeout ${num(milliseconds)}`);
        return schedule(milliseconds, () => callback());
    };
    const clearTimeout = (id: number): void => {
        out("clear-timeout");
        unschedule(id);
    };
    const gpuObject = (name: string) => ({
        name,
        destroy: () => out(`destroy ${name}`),
    });
    const device = {
        createTexture(descriptor: {
            size: { width: number; height: number };
            format: string;
            usage: number;
        }) {
            out(
                `texture ${num(descriptor.size.width)}x${num(descriptor.size.height)} ${descriptor.format} usage=${num(descriptor.usage)}`,
            );
            return gpuObject("texture");
        },
        createBuffer(descriptor: { size: number; usage: number }) {
            out(
                `buffer size=${num(descriptor.size)} usage=${num(descriptor.usage)}`,
            );
            return gpuObject("buffer");
        },
        queue: {
            writeBuffer(
                buffer: { name: string },
                offset: number,
                data: ArrayBufferView,
            ) {
                out(
                    `write ${buffer.name} offset=${num(offset)} bytes=${data.byteLength}`,
                );
            },
            copyExternalImageToTexture(
                copySource: {
                    source: { width: number; height: number };
                    flipY: boolean;
                },
                destination: { premultipliedAlpha: boolean },
                size: { width: number; height: number },
            ) {
                out(
                    `copy ${num(copySource.source.width)}x${num(copySource.source.height)} flip=${String(copySource.flipY)} premultiplied=${String(destination.premultipliedAlpha)} size=${num(size.width)}x${num(size.height)}`,
                );
            },
        },
    };

    const modules = pinnedModules({
        globalThis: { fetch, createImageBitmap, ...webgpuFlagNamespaces },
        fetch,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        performance: { now: () => now },
        AbortController: FakeAbortController,
        DOMException: FakeDOMException,
        Blob: FakeBlob,
        TextDecoder: FakeTextDecoder,
    });
    const REQUESTS = "src/loader-splat-stream/splat-stream-requests.ts";
    const COLLISION = "src/collision/splat-voxel-collision.ts";
    const createManager = exported<(...args: unknown[]) => PinnedManager>(
        modules,
        REQUESTS,
        "createSplatStreamRequestManager",
    );
    const PressureError = exported(
        modules,
        REQUESTS,
        "SplatGpuBudgetPressureError",
    );
    const createLedger = exported<(...args: unknown[]) => PinnedLedger>(
        modules,
        "src/loader-splat-stream/splat-stream-gpu-ledger.ts",
        "createSplatStreamGpuLedger",
    );
    const loadCollision = exported<
        (...args: unknown[]) => Promise<PinnedCollision>
    >(modules, COLLISION, "loadSplatVoxelCollision");
    const moveCamera = exported<(...args: unknown[]) => number[]>(
        modules,
        COLLISION,
        "moveSplatVoxelCamera",
    );

    const describe = (error: unknown): string => {
        if (!(error instanceof Error)) return `value ${String(error)}`;
        let text = `${error.name} ${error.message}`;
        if (error instanceof FakeDOMException) text += " dom";
        if (error instanceof PressureError)
            text += ` required=${num((error as unknown as { requiredBytes: number }).requiredBytes)}`;
        const cause = (error as { cause?: unknown }).cause;
        if (cause !== undefined)
            text += ` cause=(${cause instanceof SyntaxError ? "SyntaxError" : describe(cause)})`;
        return text;
    };

    const ledger = createLedger(scenario.gpuBytes, (dispose: () => void) =>
        dispose(),
    );
    const controllers = new Map<string, FakeAbortController>();
    const controller = (name: string): FakeAbortController => {
        let found = controllers.get(name);
        if (!found) {
            found = new FakeAbortController();
            controllers.set(name, found);
        }
        return found;
    };
    let manager: PinnedManager | undefined;
    const stats = (label: string): void => {
        if (!manager) return;
        out(
            `${label} stats cpu=${num(manager.cpuBytes)} fetched=${num(manager.fetchedBytes)} pending=${num(manager.pendingRequests)} queued=${num(manager.queuedFiles)} disposed=${String(manager.disposed)} ledger=${num(ledger.residentBytes)},${num(ledger.allocatedBytes)},${num(ledger.heldBytes)}`,
        );
    };
    const point = (value: readonly number[]): number[] => [...value];

    const runStep = (step: Step, index: number): void => {
        const label = `step ${index} ${step.op}`;
        out(`${label} at ${num(now)}`);
        try {
            switch (step.op) {
                case "create": {
                    const [requests, decodes, cpu, retries] = step.limits!;
                    manager = createManager(requests, decodes, cpu, retries, {
                        device,
                        isGenerationCurrent: (url: string) =>
                            url !== scenario.stale,
                        ...(step.ledger === false ? {} : { gpuLedger: ledger }),
                        ...(step.reserveGpu
                            ? {
                                  reserveGpuBytes: (
                                      url: string,
                                      bytes: number,
                                  ) => {
                                      out(`reserve-gpu ${url} ${num(bytes)}`);
                                      return ledger.tryReserve(bytes);
                                  },
                              }
                            : {}),
                    });
                    out(`${label} created`);
                    break;
                }
                case "request": {
                    const url = step.url!;
                    manager!
                        .request({
                            url,
                            fileId: step.fileId,
                            generation: step.generation,
                            priority: step.priority,
                            ...(step.distance !== undefined
                                ? { distance: step.distance }
                                : {}),
                            intervals: step.intervals!.map(
                                ([offset, count]) => ({
                                    offset,
                                    count,
                                }),
                            ),
                            ...(step.signal
                                ? { signal: controller(step.signal).signal }
                                : {}),
                        })
                        .then(
                            (prepared) =>
                                out(
                                    `settle ${url} ok ${num(prepared.width)}x${num(prepared.height)} count=${num(prepared.count)} gpu=${num(prepared.gpuBytes)} textures=${prepared.textures.length} reserved=${String(prepared._gpuReserved ?? false)} means=${num(prepared.meansMin[0]!)},${num(prepared.meansMax[2]!)}`,
                                ),
                            (error: unknown) =>
                                out(`settle ${url} error ${describe(error)}`),
                        );
                    break;
                }
                case "promote":
                    out(
                        `${label} result ${String(manager!.promote(step.url!, step.generation!, step.priority!, step.distance))}`,
                    );
                    break;
                case "cancel":
                    manager!.cancel(step.url!);
                    break;
                case "abort":
                    controller(step.signal!).abort(
                        step.custom ? new Error("custom reason") : undefined,
                    );
                    break;
                case "dispose":
                    manager!.dispose();
                    break;
                case "collision": {
                    const url = step.url!;
                    loadCollision(
                        url,
                        step.signal
                            ? controller(step.signal).signal
                            : undefined,
                    ).then(
                        (collision) => {
                            out(
                                `collision ${url} min=${collision.min.map(num).join(",")} max=${collision.max.map(num).join(",")} resolution=${num(collision.resolution)} depth=${num(collision.depth)} nodes=${collision.nodes.length} masks=${collision.masks.length}`,
                            );
                            (step.moves ?? []).forEach((move, moveIndex) => {
                                try {
                                    const position = moveCamera(
                                        collision,
                                        point(move.from),
                                        point(move.to),
                                        move.radius,
                                    );
                                    out(
                                        `move ${moveIndex} ${position.map(num).join(",")}`,
                                    );
                                } catch (error) {
                                    out(
                                        `move ${moveIndex} error ${describe(error)}`,
                                    );
                                }
                            });
                        },
                        (error: unknown) =>
                            out(`collision ${url} error ${describe(error)}`),
                    );
                    break;
                }
            }
        } catch (error) {
            out(`${label} threw ${describe(error)}`);
        }
        stats(label);
    };

    // One task per timer or step, each followed by its microtasks.
    let step = 0;
    for (;;) {
        const finished = step >= scenario.steps.length;
        const target = finished ? scenario.horizon : scenario.steps[step]!.at;
        const timer = takeTimer(target);
        if (timer) {
            now = timer.due;
            timer.callback();
        } else if (finished) {
            break;
        } else {
            now = target;
            runStep(scenario.steps[step]!, step);
            step++;
        }
        await new Promise((resolveTurn) => setImmediate(resolveTurn));
    }
    return events.map((line) => `${line}\n`).join("");
}

// ── The lowered transport ──────────────────────────────────────────────

function transportHeader(): string {
    const transport = lowerSplatStreamTransport(new LoweringContext());
    const includes = [
        "bblite/pinned_records.hpp",
        "bblite/gpu.hpp",
        "bblite/splat_stream_platform.hpp",
        ...transport.includes,
    ];
    return `#pragma once
${includes.map((header) => `#include <${header}>`).join("\n")}
namespace bbl {
${transport.structs}
${transport.declarations}
${transport.definitions}
} // namespace bbl
`;
}

test("the lowered splat-stream requests and voxel collision schedule, retry, abort and fail as the pin does", async (t) => {
    const header = transportHeader();
    // Async functions are coroutines over the runtime promise; platform
    // calls name the platform header; authored Error classes are records.
    assert.match(header, /co_await bbl::splat_stream_platform::reader_read\(/);
    assert.match(
        header,
        /bbl::pinned::construct_promise<bbl::js::PromiseVoid>/,
    );
    assert.match(
        header,
        /bbl::pinned::error_instance<bbl::ExclusiveAdmissionRequired>\(error\)/,
    );
    const runs = scenarios();
    const expected: string[] = [];
    for (const scenario of runs) expected.push(await pinnedRun(scenario));
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-splat-stream-transport");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "splat-stream-transport.hpp"), header);
    const exe = resolve(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        `/I${directory}`,
        resolve("test/fixtures/splat-stream-transport-check.cpp"),
        resolve("native/src/pal_locale.cpp"),
        `/Fo${directory}/`,
        `/Fe${exe}`,
        "icu.lib",
    ]);
    runs.forEach((scenario, index) => {
        const scenarioPath = resolve(directory, `${scenario.name}.json`);
        writeFileSync(scenarioPath, JSON.stringify(scenario));
        const printed = execFileSync(exe, [scenarioPath], {
            cwd: directory,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
        }).replaceAll("\r\n", "\n");
        writeFileSync(
            resolve(directory, `${scenario.name}-expected.txt`),
            expected[index]!,
        );
        writeFileSync(
            resolve(directory, `${scenario.name}-printed.txt`),
            printed,
        );
        assert.equal(printed, expected[index], `scenario ${scenario.name}`);
    });
});
