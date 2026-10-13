import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { LoweringContext } from "../src/lowering/context.js";
import {
    lowerSplatStreamCore,
    SPLAT_STREAM_CORE_MODULES,
} from "../src/lowering/splat-stream-records.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";
import {
    type Exports,
    pinnedModules,
    splatStreamFamilyHeader,
} from "./splat-stream-fixtures.js";

/**
 * The pinned splat-stream core lowered by the record model, compiled with
 * MSVC and run over the real Trogir manifest, against the pinned modules
 * executed under Node on the same scenario: every printed number is the
 * shortest round-trip spelling of the double, so equal output is bitwise
 * equal results.
 */

const MANIFEST_URL = "https://assets.babylonjs.com/splats/Trogir/lod-meta.json";
const manifestText = brotliDecompressSync(
    readFileSync(resolve("test/fixtures/splat-stream/trogir-lod-meta.json.br")),
).toString("utf8");

type Pinned = Record<string, (...args: never[]) => unknown>;

/** The pinned core under Node; the retirement fence is never reached. */
function coreModules(): Map<string, Exports> {
    return pinnedModules(SPLAT_STREAM_CORE_MODULES, {
        stubs: new Map([
            [
                "src/engine/gpu-resource-retirement.ts",
                {
                    retireGpuResources: () => {
                        throw new Error("The test never fences on an engine.");
                    },
                },
            ],
        ]),
    });
}

function pinned(modules: Map<string, Exports>, module: string): Pinned {
    const exports = modules.get(module);
    if (!exports) throw new Error(`${module} is not loaded.`);
    return exports as Pinned;
}

// ── The scenario ───────────────────────────────────────────────────────

type Vector = readonly [number, number, number];

const subtract = (a: Vector, b: Vector): Vector => [
    a[0] - b[0],
    a[1] - b[1],
    a[2] - b[2],
];
const cross = (a: Vector, b: Vector): Vector => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vector, b: Vector): number =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: Vector): Vector => {
    const length = Math.sqrt(dot(a, a));
    return [a[0] / length, a[1] / length, a[2] / length];
};

/** A left-handed look-at view times a WebGPU (z in 0..w) perspective, as float32. */
function viewProjection(
    eye: Vector,
    target: Vector,
    up: Vector,
): { matrix: number[]; p11: number } {
    const z = normalize(subtract(target, eye));
    const x = normalize(cross(up, z));
    const y = cross(z, x);
    const view = [
        x[0],
        y[0],
        z[0],
        0,
        x[1],
        y[1],
        z[1],
        0,
        x[2],
        y[2],
        z[2],
        0,
        -dot(x, eye),
        -dot(y, eye),
        -dot(z, eye),
        1,
    ];
    const near = 0.1;
    const far = 1000;
    const f = 1 / Math.tan(0.4);
    const projection = [
        f / (16 / 9),
        0,
        0,
        0,
        0,
        f,
        0,
        0,
        0,
        0,
        far / (far - near),
        1,
        0,
        0,
        (-near * far) / (far - near),
        0,
    ];
    const product = new Float32Array(16);
    for (let column = 0; column < 4; column++)
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++)
                sum += projection[k * 4 + row]! * view[column * 4 + k]!;
            product[column * 4 + row] = sum;
        }
    return { matrix: [...product], p11: Math.fround(f) };
}

/** `rotation.z = PI` as the stream's world matrix. */
const WORLD = [
    ...new Float32Array([
        Math.cos(Math.PI),
        Math.sin(Math.PI),
        0,
        0,
        -Math.sin(Math.PI),
        Math.cos(Math.PI),
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
    ]),
];

function frame(
    eye: Vector,
    target: Vector,
    settings: Partial<{
        maxSplats: number;
        previous: number;
        held: number;
        hardBudgetPressure: boolean;
        perspective: boolean;
        targetHeight: number;
        up: Vector;
    }> = {},
): Record<string, unknown> {
    const camera = viewProjection(eye, target, settings.up ?? [0, 1, 0]);
    return {
        world: WORLD,
        viewProjection: camera.matrix,
        p11: camera.p11,
        camera: eye,
        targetHeight: settings.targetHeight ?? 720,
        near: 0.1,
        maxSplats: settings.maxSplats ?? 1_000_000,
        screenError: 2,
        lodHysteresis: 0.15,
        previous: settings.previous ?? -1,
        held: settings.held ?? -1,
        ...(settings.hardBudgetPressure !== undefined
            ? { hardBudgetPressure: settings.hardBudgetPressure }
            : {}),
        ...(settings.perspective !== undefined
            ? { perspective: settings.perspective }
            : {}),
    };
}

function sogMeta(changes: (meta: Record<string, unknown>) => void): string {
    const codebook = Array.from(
        { length: 256 },
        (_, index) => Math.round((index / 255 - 0.5) * 1e6) / 1e5,
    );
    const meta: Record<string, unknown> = {
        version: 2,
        asset: { generator: "splat-transform v3.3.3" },
        count: 40000,
        means: {
            mins: [-1.25, -0.5, -3.75],
            maxs: [2.5, 1.125, 0.375],
            files: ["means_l.webp", "means_u.webp"],
        },
        scales: { codebook, files: ["scales.webp"] },
        quats: { files: ["quats.webp"] },
        sh0: {
            codebook: codebook.map((value) => value / 3),
            files: ["sh0.webp"],
        },
    };
    changes(meta);
    return JSON.stringify(meta);
}

function mutatedManifest(
    change: (manifest: Record<string, unknown>) => void,
): string {
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    change(manifest);
    return JSON.stringify(manifest);
}

function firstLeaf(manifest: Record<string, unknown>): Record<string, unknown> {
    let node = manifest.tree as Record<string, unknown>;
    while (Array.isArray(node.children))
        node = node.children[0] as Record<string, unknown>;
    return node;
}

const url = (name: string): string =>
    `https://assets.babylonjs.com/splats/Trogir/${name}/meta.json`;

function scenario(): Record<string, unknown> {
    return {
        manifestUrl: MANIFEST_URL,
        options: [
            {},
            {
                maxSplats: 1_000_000,
                maxCapacitySplats: 1_010_000,
                maxGpuBytes: 256 * 1024 * 1024,
                maxCpuBytes: 64 * 1024 * 1024,
                screenError: 2,
            },
            {
                maxSplats: 4_000_000,
                maxCapacitySplats: 4_010_000,
                maxGpuBytes: 1024 * 1024 * 1024,
                maxCpuBytes: 192 * 1024 * 1024,
                lodHysteresis: 0,
                lodCooldownMs: 250,
                maxRetries: 8,
                maxConcurrentRequests: 32,
                maxConcurrentDecodes: 8,
            },
            { screenError: 0 },
            { lodHysteresis: 1.5 },
            { lodCooldownMs: -1 },
            { maxRetries: 9 },
            { maxSplats: 1.5 },
            { maxSplats: 10, maxCapacitySplats: 9 },
            { maxConcurrentRequests: 33 },
            { maxConcurrentDecodes: 0 },
        ],
        invalidManifests: [
            mutatedManifest((manifest) => (manifest.version = 2)),
            mutatedManifest((manifest) => (manifest.lodLevels = 33)),
            mutatedManifest((manifest) => (manifest.extra = true)),
            mutatedManifest((manifest) => (manifest.filenames = [])),
            mutatedManifest(
                (manifest) =>
                    ((manifest.filenames as string[])[3] = "../escape.json"),
            ),
            mutatedManifest(
                (manifest) =>
                    ((manifest.filenames as string[])[2] = "packed.sog"),
            ),
            mutatedManifest(
                (manifest) =>
                    ((manifest.filenames as string[])[1] = "%E0%A4%A.json"),
            ),
            mutatedManifest(
                (manifest) =>
                    ((manifest.filenames as string[])[5] = "/absolute.json"),
            ),
            mutatedManifest(
                (manifest) =>
                    ((manifest.filenames as string[])[4] =
                        "data:application/json,{}"),
            ),
            // Duplicate filenames share one source.
            mutatedManifest(
                (manifest) =>
                    ((manifest.filenames as string[])[7] = (
                        manifest.filenames as string[]
                    )[0]!),
            ),
            mutatedManifest((manifest) => (manifest.lodErrors = "yes")),
            mutatedManifest((manifest) => {
                manifest.lodErrors = false;
            }),
            mutatedManifest((manifest) => (manifest.counts = [1, 2])),
            mutatedManifest((manifest) => {
                (firstLeaf(manifest).errors as number[])[2] = -1;
            }),
            mutatedManifest((manifest) => {
                firstLeaf(manifest).children = [];
            }),
            mutatedManifest((manifest) => {
                const lods = firstLeaf(manifest).lods as Record<
                    string,
                    unknown
                >;
                lods["07"] = lods["0"];
            }),
            mutatedManifest((manifest) => {
                const lods = firstLeaf(manifest).lods as Record<
                    string,
                    Record<string, number>
                >;
                lods["1"]!.file = 999;
            }),
            mutatedManifest((manifest) => {
                const bound = firstLeaf(manifest).bound as Record<
                    string,
                    number[]
                >;
                bound.min = [5, 0, 0];
                bound.max = [1, 2, 3];
            }),
            mutatedManifest((manifest) => {
                const lods = firstLeaf(manifest).lods as Record<
                    string,
                    Record<string, number>
                >;
                lods["2"]!.offset = 2 ** 53;
            }),
            mutatedManifest((manifest) => {
                const leaf = firstLeaf(manifest);
                const lods = leaf.lods as Record<
                    string,
                    Record<string, number>
                >;
                for (const key of Object.keys(lods)) lods[key]!.count = 0;
            }),
            mutatedManifest((manifest) => {
                manifest.environment = null;
                manifest.asset = {
                    generator: "",
                    chunkGaussians: 1,
                    chunkExtent: 1,
                };
            }),
            mutatedManifest((manifest) => {
                manifest.environment = null;
                delete manifest.asset;
                delete manifest.counts;
                delete manifest.count;
            }),
        ],
        sog: {
            url: url("0_0"),
            metas: [
                sogMeta(() => undefined),
                sogMeta((meta) => (meta.version = 1)),
                sogMeta((meta) => (meta.shN = {})),
                sogMeta(
                    (meta) =>
                        ((meta.scales as Record<string, unknown>).codebook = [
                            1,
                        ]),
                ),
                sogMeta(
                    (meta) =>
                        ((meta.means as Record<string, unknown>).files = [
                            "a.webp",
                        ]),
                ),
                sogMeta(
                    (meta) =>
                        ((meta.quats as Record<string, unknown>).files = [
                            "?query.webp",
                        ]),
                ),
                sogMeta((meta) => (meta.count = 0)),
            ],
            images: [
                {
                    meta: 0,
                    maxCpuBytes: 64 * 1024 * 1024,
                    images: Array.from({ length: 5 }, (_, index) => ({
                        width: 200,
                        height: 200,
                        mimeType: "image/webp; charset=binary",
                        url: `https://example.com/${index}.WEBP?x=1`,
                    })),
                    intervals: [
                        { offset: 0, count: 100 },
                        { offset: 39000, count: 1000 },
                    ],
                },
                {
                    meta: 0,
                    maxCpuBytes: 100,
                    images: Array.from({ length: 5 }, () => ({
                        width: 200,
                        height: 200,
                        mimeType: "image/webp",
                    })),
                    intervals: [],
                },
                {
                    meta: 0,
                    maxCpuBytes: 64 * 1024 * 1024,
                    images: Array.from({ length: 5 }, (_, index) => ({
                        width: index === 3 ? 201 : 200,
                        height: 200,
                        mimeType: "image/webp",
                    })),
                    intervals: [],
                },
                {
                    meta: 0,
                    maxCpuBytes: 64 * 1024 * 1024,
                    images: Array.from({ length: 5 }, () => ({
                        width: 200,
                        height: 200,
                        mimeType: "image/png",
                        url: "https://example.com/a.png",
                    })),
                    intervals: [],
                },
                {
                    meta: 0,
                    maxCpuBytes: 64 * 1024 * 1024,
                    images: Array.from({ length: 5 }, () => ({
                        width: 100,
                        height: 100,
                        mimeType: "image/webp",
                    })),
                    intervals: [],
                },
                {
                    meta: 0,
                    maxCpuBytes: 64 * 1024 * 1024,
                    images: Array.from({ length: 5 }, () => ({
                        width: 200,
                        height: 200,
                        mimeType: "image/webp",
                    })),
                    intervals: [{ offset: 39999, count: 2 }],
                },
                {
                    meta: 0,
                    maxCpuBytes: 64 * 1024 * 1024,
                    images: Array.from({ length: 4 }, () => ({
                        width: 200,
                        height: 200,
                    })),
                    intervals: [],
                },
            ],
        },
        frames: [
            frame([0, 15, 60], [0, 5, -80]),
            frame([0, 8, -60], [20, 5, -120]),
            frame([-50, 40, -100], [10, 0, -90], { maxSplats: 4_000_000 }),
            frame([0, 200, 0], [0, 0, -80]),
            frame([0, 15, 58], [0, 5, -80], { previous: 0 }),
            frame([0, 8, -61], [20, 5, -120], {
                previous: 1,
                held: 1,
                maxSplats: 200_000,
            }),
            frame([0, 8, -61], [20, 5, -120], {
                previous: 1,
                held: 1,
                hardBudgetPressure: true,
            }),
            frame([0, 15, 60], [0, 5, -80], { perspective: false }),
            frame([0, 15, 60], [0, 5, -80], { targetHeight: 0 }),
            frame([0, 15, 60], [0, 5, -80], { maxSplats: 50 }),
        ],
        merged: {
            plans: [0, 1, 2],
            maxSplats: 1_000_000,
            screenError: 2,
            lodHysteresis: 0.15,
            previous: 0,
            hard: false,
        },
        cache: {
            maxGpuBytes: 1000,
            maxCpuBytes: 600,
            distances: {
                [url("a")]: 5,
                [url("b")]: 10,
                [url("c")]: 20,
                [url("chunk-2")]: 40,
                [url("chunk_10")]: 40,
                [url("Chunk-3")]: 40,
            },
            invalidBudgets: [
                [0, 10],
                [10, 1.5],
                [Infinity, 1],
            ],
            ops: [
                admit("a", 1, 300, 100, 1),
                admit("b", 1, 300, 100, 2),
                admit("c", 1, 300, 100, 3),
                { op: "protect", url: url("a"), refs: { pinCount: 1 } },
                { op: "canReserve", bytes: 300 },
                { op: "reserve", bytes: 300 },
                { op: "flush" },
                { op: "reserve", bytes: 300 },
                admit("d", 1, 300, 100, 4, true),
                admit("a", 1, 300, 100, 5),
                admit("a", 2, 300, 100, 5),
                {
                    op: "protect",
                    url: url("a"),
                    refs: { pinCount: 0, lastUsedFrame: 7 },
                },
                { op: "protect", url: url("b"), refs: { displayedRefs: 2 } },
                { op: "evict", url: url("b") },
                { op: "protect", url: url("b"), refs: { displayedRefs: 0 } },
                { op: "distance", url: url("d"), value: 30 },
                admit("e", 1, 500, 450, 8),
                { op: "protect", url: url("b"), refs: { activeRefs: -1 } },
                { op: "evict", url: url("d") },
                { op: "evict", url: url("b") },
                { op: "flush" },
                admit("chunk-2", 1, 100, 50, 9),
                admit("chunk_10", 1, 100, 50, 9),
                admit("Chunk-3", 1, 100, 50, 9),
                { op: "canReserve", bytes: 2000 },
                { op: "canReserve", bytes: -1 },
                { op: "reserve", bytes: 600 },
                { op: "flush" },
                { op: "dispose" },
                { op: "flush" },
                admit("f", 1, 100, 50, 10),
                { op: "reserve", bytes: 1 },
            ],
        },
        ledger: {
            maxBytes: 1000,
            ops: [
                { op: "tryReserve", bytes: 400 },
                { op: "tryHold", bytes: 500 },
                { op: "tryHold", bytes: 200 },
                { op: "tryReserve", bytes: 1.5 },
                { op: "commitHold", bytes: 500 },
                { op: "retire", bytes: 400, name: "first" },
                { op: "tryReserve", bytes: 200 },
                { op: "flush" },
                { op: "tryReserve", bytes: 200 },
                { op: "retireToHold", bytes: 200, name: "second" },
                { op: "restoreHold", bytes: 100 },
                { op: "flush" },
                { op: "releaseHold", bytes: 300 },
                { op: "retire", bytes: 500, name: "third", throws: true },
                { op: "flush" },
                { op: "release", bytes: 100 },
                { op: "tryHold", bytes: -1 },
            ],
        },
    };
}

function admit(
    name: string,
    generation: number,
    gpuBytes: number,
    cpuBytes: number,
    lastUsedFrame: number,
    gpuReserved?: boolean,
): Record<string, unknown> {
    return {
        op: "admit",
        url: url(name),
        generation,
        width: 16,
        height: 8,
        count: 100,
        gpuBytes,
        cpuBytes,
        lastUsedFrame,
        ...(gpuReserved !== undefined ? { gpuReserved } : {}),
    };
}

// ── The pin's run, printed as the fixture prints it ────────────────────

const num = (value: number): string =>
    Object.is(value, -0) ? "-0" : String(value);
const vector3 = (values: ArrayLike<number>): string =>
    `${num(values[0]!)},${num(values[1]!)},${num(values[2]!)}`;

interface Representation {
    leafId: number;
    lod: number;
    fileId: number;
    offset: number;
    count: number;
    error: number;
}
interface TreeNode {
    kind: "leaf" | "branch";
    id: number;
    boundMin: Float32Array;
    boundMax: Float32Array;
    center: Float32Array;
    radius: number;
    alternatives: Representation[];
    children: TreeNode[];
}
interface Plan {
    selections: {
        leaf: TreeNode;
        target: Representation;
        projectedError: number;
        distanceToCamera: number;
        projectedRadius: number;
    }[];
    visibleLeaves: number;
    selectedSplats: number;
    holdsApplied?: boolean;
}
interface CacheEntry {
    url: string;
}
interface Cache {
    entries: Map<string, CacheEntry>;
    ledger: {
        residentBytes: number;
        allocatedBytes: number;
        heldBytes: number;
    };
    residentGpuBytes: number;
    allocatedGpuBytes: number;
    retiringGpuBytes: number;
    residentCpuBytes: number;
    admissionVersion: number;
    disposed: boolean;
}
interface Ledger {
    residentBytes: number;
    allocatedBytes: number;
    heldBytes: number;
    [method: string]: unknown;
}

function pinnedRun(scenarioValue: Record<string, unknown>): string {
    const modules = coreModules();
    const types = pinned(modules, SPLAT_STREAM_CORE_MODULES[0]);
    const meta = pinned(modules, SPLAT_STREAM_CORE_MODULES[1]);
    const selection = pinned(modules, SPLAT_STREAM_CORE_MODULES[2]);
    const cacheModule = pinned(modules, SPLAT_STREAM_CORE_MODULES[3]);
    const ledgerModule = pinned(modules, SPLAT_STREAM_CORE_MODULES[4]);
    const call = <T>(module: Pinned, name: string, ...args: unknown[]): T =>
        (module[name] as (...values: unknown[]) => T)(...args);
    const lines: string[] = [];
    const out = (line: string): number => lines.push(line);
    const guarded = (label: string, action: () => void): void => {
        try {
            action();
        } catch (error) {
            out(`${label}: error ${(error as Error).message}`);
        }
    };
    const s = scenarioValue as {
        options: Record<string, number>[];
        invalidManifests: string[];
        sog: {
            url: string;
            metas: string[];
            images: {
                meta: number;
                maxCpuBytes: number;
                images: unknown[];
                intervals: unknown[];
            }[];
        };
        frames: Record<string, unknown>[];
        merged: {
            plans: number[];
            maxSplats: number;
            screenError: number;
            lodHysteresis: number;
            previous: number;
            hard: boolean;
        };
        cache: {
            maxGpuBytes: number;
            maxCpuBytes: number;
            distances: Record<string, number>;
            invalidBudgets: number[][];
            ops: Record<string, unknown>[];
        };
        ledger: { maxBytes: number; ops: Record<string, unknown>[] };
    };

    s.options.forEach((given, index) =>
        guarded(`options ${index}`, () => {
            const normalized = call<Record<string, number>>(
                types,
                "normalizeSplatStreamOptions",
                given,
            );
            out(
                `options ${index}: maxSplats=${num(normalized.maxSplats!)} maxCapacitySplats=${num(normalized.maxCapacitySplats!)} maxGpuBytes=${num(normalized.maxGpuBytes!)} maxCpuBytes=${num(normalized.maxCpuBytes!)} maxConcurrentRequests=${num(normalized.maxConcurrentRequests!)} maxConcurrentDecodes=${num(normalized.maxConcurrentDecodes!)} screenError=${num(normalized.screenError!)} lodHysteresis=${num(normalized.lodHysteresis!)} lodCooldownMs=${num(normalized.lodCooldownMs!)} maxRetries=${num(normalized.maxRetries!)}`,
            );
        }),
    );

    const manifest = call<{
        lodLevels: number;
        root: TreeNode;
        leaves: TreeNode[];
        sources: { id: number; url: string; consumers: unknown[] }[];
        environmentUrl: string | null;
    }>(
        meta,
        "parseSplatStreamManifest",
        JSON.parse(manifestText),
        MANIFEST_URL,
    );
    out(
        `manifest: lodLevels=${num(manifest.lodLevels)} leaves=${manifest.leaves.length} sources=${manifest.sources.length} environment=${manifest.environmentUrl ?? "null"}`,
    );
    for (const leaf of manifest.leaves) {
        out(
            `leaf ${num(leaf.id)}: min=${vector3(leaf.boundMin)} max=${vector3(leaf.boundMax)} center=${vector3(leaf.center)} radius=${num(leaf.radius)}`,
        );
        for (const rep of leaf.alternatives)
            out(
                `  rep leaf=${num(rep.leafId)} lod=${num(rep.lod)} file=${num(rep.fileId)} offset=${num(rep.offset)} count=${num(rep.count)} error=${num(rep.error)}`,
            );
    }
    for (const source of manifest.sources)
        out(
            `source ${num(source.id)}: ${source.url} consumers=${source.consumers.length}`,
        );
    let tree = "";
    const walk = (node: TreeNode): void => {
        if (node.kind === "leaf") {
            tree += ` l${num(node.id)}`;
            return;
        }
        tree += ` b(${num(node.radius)}`;
        for (const child of node.children) walk(child);
        tree += " )";
    };
    walk(manifest.root);
    out(`tree:${tree}`);
    s.invalidManifests.forEach((text, index) =>
        guarded(`invalid ${index}`, () => {
            const parsed = call<{ leaves: unknown[]; sources: unknown[] }>(
                meta,
                "parseSplatStreamManifest",
                JSON.parse(text),
                MANIFEST_URL,
            );
            out(
                `invalid ${index}: ok leaves=${parsed.leaves.length} sources=${parsed.sources.length}`,
            );
        }),
    );

    const metas: unknown[] = [];
    s.sog.metas.forEach((text, index) => {
        metas.push(undefined);
        guarded(`sog ${index}`, () => {
            const metadata = call<{
                count: number;
                meansMin: Float32Array;
                meansMax: Float32Array;
                scaleCodebook: Float32Array;
                sh0Codebook: Float32Array;
                imageUrls: string[];
            }>(meta, "parseLooseSogV2Metadata", JSON.parse(text), s.sog.url);
            metas[metas.length - 1] = metadata;
            out(
                `sog ${index}: count=${num(metadata.count)} meansMin=${vector3(metadata.meansMin)} meansMax=${vector3(metadata.meansMax)} scale0=${num(metadata.scaleCodebook[0]!)} sh0last=${num(metadata.sh0Codebook[255]!)} urls=${metadata.imageUrls.join("|")}`,
            );
        });
    });
    s.sog.images.forEach((given, index) =>
        guarded(`images ${index}`, () => {
            const bytes = call<number>(
                meta,
                "validateLooseSogV2Images",
                metas[given.meta],
                given.images,
                given.maxCpuBytes,
                given.intervals,
            );
            out(`images ${index}: ${num(bytes)}`);
        }),
    );

    const plans: Plan[] = [];
    const targets = (plan: Plan): Map<number, Representation> =>
        new Map(plan.selections.map((entry) => [entry.leaf.id, entry.target]));
    const printPlan = (label: string, plan: Plan): void => {
        out(
            `${label}: visible=${num(plan.visibleLeaves)} selected=${num(plan.selectedSplats)} holds=${plan.holdsApplied === undefined ? "undefined" : String(plan.holdsApplied)}`,
        );
        for (const entry of plan.selections)
            out(
                `  sel leaf=${num(entry.leaf.id)} lod=${num(entry.target.lod)} file=${num(entry.target.fileId)} offset=${num(entry.target.offset)} count=${num(entry.target.count)} projectedError=${num(entry.projectedError)} distance=${num(entry.distanceToCamera)} projectedRadius=${num(entry.projectedRadius)}`,
            );
    };
    s.frames.forEach((given, index) => {
        plans.push(undefined as unknown as Plan);
        guarded(`plan ${index}`, () => {
            const viewProjectionMatrix = new Float32Array(
                given.viewProjection as number[],
            );
            if (index === 0) {
                const planes = call<
                    { x: number; y: number; z: number; w: number }[]
                >(
                    selection,
                    "extractStreamFrustumPlanes",
                    viewProjectionMatrix,
                );
                out(
                    `planes:${planes.map((plane) => ` ${num(plane.x)},${num(plane.y)},${num(plane.z)},${num(plane.w)}`).join("")}`,
                );
            }
            const previous = given.previous as number;
            const held = given.held as number;
            const plan = call<Plan>(selection, "planStreamSelection", {
                root: manifest.root,
                worldMatrix: new Float32Array(given.world as number[]),
                viewProjectionMatrix,
                projectionP11: given.p11,
                cameraPosition: [...(given.camera as number[])],
                targetHeight: given.targetHeight,
                near: given.near,
                maxSplats: given.maxSplats,
                screenError: given.screenError,
                lodHysteresis: given.lodHysteresis,
                ...(previous >= 0
                    ? { previousTargets: targets(plans[previous]!) }
                    : {}),
                ...(held >= 0 ? { heldTargets: targets(plans[held]!) } : {}),
                ...(given.hardBudgetPressure !== undefined
                    ? { hardBudgetPressure: given.hardBudgetPressure }
                    : {}),
                ...(given.perspective !== undefined
                    ? { perspective: given.perspective }
                    : {}),
            });
            plans[plans.length - 1] = plan;
            printPlan(`plan ${index}`, plan);
        });
    });
    guarded("merged", () =>
        printPlan(
            "merged",
            call<Plan>(
                selection,
                "planMergedStreamSelection",
                s.merged.plans.map((index) => plans[index]),
                s.merged.maxSplats,
                s.merged.screenError,
                s.merged.lodHysteresis,
                targets(plans[s.merged.previous]!),
                s.merged.hard,
            ),
        ),
    );
    out(
        `bootstrap: ${num(call<{ id: number }>(selection, "selectBootstrapSource", manifest.leaves, manifest.sources).id)}`,
    );
    const bound = call<{
        boundMin: Float32Array;
        boundMax: Float32Array;
        center: Float32Array;
        radius: number;
    }>(
        selection,
        "transformStreamBound",
        manifest.leaves[0],
        new Float32Array(s.frames[0]!.world as number[]),
    );
    out(
        `bound: min=${vector3(bound.boundMin)} max=${vector3(bound.boundMax)} center=${vector3(bound.center)} radius=${num(bound.radius)} distance=${num(call<number>(selection, "distanceToStreamBound", bound, [1.5, -2.25, 40]))}`,
    );

    const destroyed: string[] = [];
    const retirements: (() => void)[] = [];
    const distances = new Map(Object.entries(s.cache.distances));
    s.cache.invalidBudgets.forEach((pair, index) =>
        guarded(`budget ${index}`, () => {
            call(cacheModule, "createSplatSourceCache", pair[0], pair[1]);
            out(`budget ${index}: ok`);
        }),
    );
    const cache = call<Cache>(
        cacheModule,
        "createSplatSourceCache",
        s.cache.maxGpuBytes,
        s.cache.maxCpuBytes,
        (dispose: () => void) => retirements.push(dispose),
        undefined,
        (key: string) => distances.get(key) ?? Infinity,
    );
    const state = (label: string): void => {
        out(
            `${label} state: resident=${num(cache.residentGpuBytes)} allocated=${num(cache.allocatedGpuBytes)} retiring=${num(cache.retiringGpuBytes)} cpu=${num(cache.residentCpuBytes)} version=${num(cache.admissionVersion)} disposed=${String(cache.disposed)} ledger=${num(cache.ledger.residentBytes)},${num(cache.ledger.allocatedBytes)},${num(cache.ledger.heldBytes)} entries=${[...cache.entries.keys()].join("|")} destroyed=${destroyed.join("|")}`,
        );
    };
    s.cache.ops.forEach((operation, index) => {
        const kind = operation.op as string;
        const label = `cache ${index} ${kind}`;
        guarded(label, () => {
            if (kind === "admit") {
                const name = `${operation.url as string}#${num(operation.generation as number)}`;
                const entry = {
                    url: operation.url,
                    generation: operation.generation,
                    width: operation.width,
                    height: operation.height,
                    count: operation.count,
                    gpuBytes: operation.gpuBytes,
                    cpuBytes: operation.cpuBytes,
                    ...(operation.gpuReserved !== undefined
                        ? { gpuReserved: operation.gpuReserved }
                        : {}),
                    lastUsedFrame: operation.lastUsedFrame,
                    pinCount: 0,
                    displayedRefs: 0,
                    pendingRefs: 0,
                    activeRefs: 0,
                    resources: {
                        textures: [
                            {
                                destroy: () =>
                                    destroyed.push(`${name}:texture`),
                            },
                        ],
                        metadataBuffer: {
                            destroy: () => destroyed.push(`${name}:metadata`),
                        },
                    },
                };
                out(
                    `${label}: ${String(call<boolean>(cacheModule, "admitSplatSource", cache, entry))}`,
                );
            } else if (kind === "protect") {
                call(
                    cacheModule,
                    "setSplatSourceProtection",
                    cache,
                    operation.url,
                    operation.refs,
                );
                out(`${label}: done`);
            } else if (kind === "canReserve") {
                out(
                    `${label}: ${String(call<boolean>(cacheModule, "canReserveSplatSourceGpuBytes", cache, operation.bytes))}`,
                );
            } else if (kind === "reserve") {
                const evicted: string[] = [];
                const reserved = call<boolean>(
                    cacheModule,
                    "reserveSplatSourceGpuBytes",
                    cache,
                    operation.bytes,
                    (entry: CacheEntry) => evicted.push(entry.url),
                );
                out(
                    `${label}: ${String(reserved)} evicted=${evicted.join("|")}`,
                );
            } else if (kind === "evict") {
                out(
                    `${label}: ${String(call<boolean>(cacheModule, "evictSplatSource", cache, operation.url))}`,
                );
            } else if (kind === "flush") {
                const pending = retirements.splice(0);
                for (const dispose of pending) dispose();
                out(`${label}: ${pending.length}`);
            } else if (kind === "distance") {
                distances.set(
                    operation.url as string,
                    operation.value as number,
                );
                out(`${label}: done`);
            } else if (kind === "dispose") {
                call(cacheModule, "disposeSplatSourceCache", cache);
                out(`${label}: done`);
            }
        });
        state(label);
    });

    const ledgerRetirements: (() => void)[] = [];
    const ledgerLog: string[] = [];
    const ledger = call<Ledger>(
        ledgerModule,
        "createSplatStreamGpuLedger",
        s.ledger.maxBytes,
        (dispose: () => void) => ledgerRetirements.push(dispose),
    );
    s.ledger.ops.forEach((step, index) => {
        const kind = step.op as string;
        const label = `ledger ${index} ${kind}`;
        guarded(label, () => {
            const bytes = typeof step.bytes === "number" ? step.bytes : 0;
            let result = "done";
            const method = (name: string) =>
                ledger[name] as (...values: unknown[]) => unknown;
            if (kind === "tryReserve" || kind === "tryHold")
                result = String(method(kind)(bytes));
            else if (
                [
                    "commitHold",
                    "restoreHold",
                    "releaseHold",
                    "release",
                ].includes(kind)
            )
                method(kind)(bytes);
            else if (kind === "retire" || kind === "retireToHold") {
                const name = step.name as string;
                const failing = step.throws === true;
                method(kind)(bytes, () => {
                    ledgerLog.push(name);
                    if (failing) throw new Error(`dispose ${name}`);
                });
            } else if (kind === "flush") {
                const pending = ledgerRetirements.splice(0);
                for (const dispose of pending) guarded(label, () => dispose());
                result = String(pending.length);
            }
            out(`${label}: ${result}`);
        });
        out(
            `${label} state: resident=${num(ledger.residentBytes)} allocated=${num(ledger.allocatedBytes)} held=${num(ledger.heldBytes)} log=${ledgerLog.join("|")}`,
        );
    });
    return `${lines.join("\n")}\n`;
}

// ── The lowered core ───────────────────────────────────────────────────

test("the lowered splat-stream core runs the real manifest, selection, cache and ledger as the pin does", (t) => {
    const header = splatStreamFamilyHeader(
        lowerSplatStreamCore(new LoweringContext()),
    );
    // The parsed document is the runtime's dynamic value; array callbacks
    // are inline lambdas; the manifest's `satisfies` literal is its record.
    assert.match(
        header,
        /parse_splat_stream_manifest\(bbl::js::JsonValue value/,
    );
    assert.match(
        header,
        /bbl::pinned::json_map<std::shared_ptr<bbl::StreamTreeNode>>/,
    );
    assert.match(header, /bbl::pinned::array_find_index\([^]*\[&\]\(/);
    const values = scenario();
    const expected = pinnedRun(values);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-splat-stream-core");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "splat-stream-core.hpp"), header);
    const scenarioPath = resolve(directory, "scenario.json");
    const manifestPath = resolve(directory, "lod-meta.json");
    writeFileSync(scenarioPath, JSON.stringify(values));
    writeFileSync(manifestPath, manifestText);
    const exe = resolve(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        `/I${directory}`,
        resolve("test/fixtures/splat-stream-core-check.cpp"),
        resolve("native/src/pal_locale.cpp"),
        `/Fo${directory}/`,
        `/Fe${exe}`,
        "icu.lib",
    ]);
    const printed = execFileSync(exe, [scenarioPath, manifestPath], {
        cwd: directory,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    }).replaceAll("\r\n", "\n");
    writeFileSync(resolve(directory, "expected.txt"), expected);
    writeFileSync(resolve(directory, "printed.txt"), printed);
    assert.equal(printed, expected);
});
