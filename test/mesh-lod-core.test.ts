import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    type MeshoptDecoderValue,
    pinnedMeshoptDecoder,
    pinnedMeshoptVersion,
} from "../src/compressed-geometry.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    lowerMeshLoDCore,
    MESH_LOD_CORE_MODULES,
} from "../src/lowering/mesh-lod-records.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runFixtureExecutable,
    runNativeFixtureCompiler,
} from "./native-fixture.js";
import {
    type Exports,
    pinnedModules,
    recordFamilyHeader,
    type Vector,
    viewProjection,
} from "./pinned-library-fixtures.js";

/**
 * The pinned MeshLoD core lowered by the record model, compiled with the
 * native fixture compiler and run over the statue's three `.mlod`
 * primitives, against the pinned modules executed under Node with the pin's
 * own meshopt decoder on the same scenario: the container parse, page
 * decoding, the CPU selector, the CPU page cache and the geometry arena.
 * Every printed number is the shortest round-trip spelling of the double,
 * so equal output is bitwise equal results.
 */

const ASSETS = "corpus/babylon-lite/lab/lite/src/demos/mesh-lod";
const FILES = [0, 1, 2].map(
    (index) =>
        `${ASSETS}/harvard-yenching_institute_statue.mesh00${index}.prim000.mlod`,
);
const [ERRORS, FORMAT, DECODER, MATH, CPU, CACHE] = MESH_LOD_CORE_MODULES;

type Pinned = Record<string, (...args: never[]) => unknown>;

function pinned(modules: Map<string, Exports>, module: string): Pinned {
    const exports = modules.get(module);
    if (!exports) throw new Error(`${module} is not loaded.`);
    return exports as Pinned;
}

const num = (value: number): string =>
    Object.is(value, -0) ? "-0" : String(value);
const list = (values: ArrayLike<number>): string =>
    Array.from(values, num).join(",");

// ── The scenario ───────────────────────────────────────────────────────

interface Frame {
    readonly file: number;
    readonly position: Vector;
    readonly matrix: readonly number[];
    readonly residentModulo: number;
    readonly coneCull: boolean;
}
type CacheOp =
    | { op: "put"; page: number; pinned: boolean; frame: number }
    | { op: "get" | "touch"; page: number; frame: number }
    | { op: "budget"; bytes: number }
    | { op: "clear" };
type ArenaOp =
    | { op: "alloc"; page: number; pinned: boolean }
    | { op: "free"; page: number }
    | { op: "reserve"; page: number; frame: number; budget: number }
    | { op: "evict"; frame: number; budget: number };
interface Scenario {
    readonly decode: readonly (readonly number[])[];
    readonly frames: readonly Frame[];
    readonly cacheBudget: number;
    readonly cache: readonly CacheOp[];
    readonly arenaBlocks: number;
    readonly arena: readonly ArenaOp[];
}

interface PageRecord {
    offset: number;
    storedBytes: number;
    meaningfulBytes: number;
    decodedBytes: number;
    crc: number;
    vertexCount: number;
    localIndexCount: number;
    vertexByteOffset: number;
    indexByteOffset: number;
    firstCluster: number;
    clusterCount: number;
    pinned: boolean;
    coarse: boolean;
    minDepth: number;
    maxDepth: number;
}
interface Container {
    header: {
        boundsMin: Vector;
        boundsMax: Vector;
        containerFlags: number;
        directoryOffset: number;
        directoryBytes: number;
        hierarchyId: string;
        levelCount: number;
        attributeMask: number;
        vertexStride: number;
        maxNonterminalError: number;
    };
    sections: {
        type: number;
        flags: number;
        offset: number;
        storedBytes: number;
        decodedBytes: number;
        elementCount: number;
        crc: number;
    }[];
    groups: {
        center: Vector;
        radius: number;
        simplifiedError: number;
        depth: number;
        firstCluster: number;
        clusterCount: number;
        firstPageRef: number;
        pageRefCount: number;
        terminal: boolean;
        pinned: boolean;
        sourceTriangleCount: number;
        outputTriangleCount: number;
    }[];
    clusters: {
        center: Vector;
        radius: number;
        error: number;
        groupId: number;
        refinedGroupId: number;
        pageId: number;
        vertexOffset: number;
        indexOffset: number;
        vertexCount: number;
        triangleCount: number;
        sourceTriangleCount: number;
        normalCone?: readonly number[] | null;
    }[];
    hierarchyNodes: {
        center: Vector;
        radius: number;
        error: number;
        groupId: number;
        childOffset: number;
        childCount: number;
    }[];
    pageRecords: PageRecord[];
    groupPageRefs: Uint32Array;
}

const call = <T>(module: Pinned, name: string, ...args: unknown[]): T =>
    (module[name] as (...values: unknown[]) => T)(...args);

/** A primitive's bootstrap prefix parsed by the pin, as the runtime first parses it. */
function parseBootstrap(format: Pinned, bytes: Uint8Array): Container {
    const extent = call<{ bootstrapBytes: number }>(
        format,
        "readBootstrapExtent",
        bytes.subarray(0, 256),
    );
    return call<Container>(
        format,
        "parseMeshLoDContainer",
        bytes.subarray(0, extent.bootstrapBytes),
    );
}

/** Pages to decode, cameras over each primitive's bounds, and the cache and arena runs. */
function scenario(parsed: readonly Container[]): Scenario {
    const decode = parsed.map(({ pageRecords }) => {
        const pinnedIds = pageRecords.flatMap((page, id) =>
            page.pinned ? [id] : [],
        );
        const fine = pageRecords.flatMap((page, id) =>
            page.pinned ? [] : [id],
        );
        return [...pinnedIds, ...fine.slice(0, 4), fine.at(-1)!];
    });
    const frames: Frame[] = [];
    parsed.forEach(({ header }, file) => {
        const middle = (axis: number): number =>
            (header.boundsMin[axis]! + header.boundsMax[axis]!) / 2;
        const center: Vector = [middle(0), middle(1), middle(2)];
        const extent = Math.hypot(
            ...[0, 1, 2].map(
                (axis) => header.boundsMax[axis]! - header.boundsMin[axis]!,
            ),
        );
        const direction: Vector = [0.3, 0.2, -1];
        [0.35, 1.2, 6].forEach((distance, index) => {
            const position: Vector = [
                center[0] + direction[0] * extent * distance,
                center[1] + direction[1] * extent * distance,
                center[2] + direction[2] * extent * distance,
            ];
            frames.push({
                file,
                position,
                matrix: viewProjection(position, center, [0, 1, 0]).matrix,
                residentModulo: 2 + index,
                coneCull: index !== 1,
            });
        });
    });
    const records = parsed[0]!.pageRecords;
    const fine = records.flatMap((page, id) => (page.pinned ? [] : [id]));
    const stored = (id: number): number => records[id]!.storedBytes;
    const cache: CacheOp[] = [
        { op: "put", page: 0, pinned: true, frame: 0 },
        ...fine.slice(0, 6).map((page, index): CacheOp => ({
            op: "put",
            page,
            pinned: false,
            frame: index + 1,
        })),
        { op: "get", page: fine[3]!, frame: 7 },
        { op: "touch", page: fine[4]!, frame: 8 },
        { op: "put", page: fine[6]!, pinned: false, frame: 9 },
        { op: "get", page: fine[0]!, frame: 10 },
        { op: "budget", bytes: stored(0) + stored(fine[1]!) },
        { op: "clear" },
    ];
    const arena: ArenaOp[] = [
        ...records.flatMap((page, id): ArenaOp[] =>
            page.pinned ? [{ op: "alloc", page: id, pinned: true }] : [],
        ),
        ...fine
            .slice(0, 5)
            .map((page): ArenaOp => ({ op: "alloc", page, pinned: false })),
        { op: "free", page: fine[1]! },
        { op: "alloc", page: fine[5]!, pinned: false },
        { op: "reserve", page: fine[6]!, frame: 200, budget: 1 << 30 },
        { op: "reserve", page: fine[7]!, frame: 200, budget: 6 << 16 },
        { op: "evict", frame: 400, budget: 3 << 16 },
    ];
    return {
        decode,
        frames,
        cacheBudget: fine
            .slice(0, 4)
            .reduce((total, page) => total + stored(page), stored(0)),
        cache,
        arenaBlocks: 32,
        arena,
    };
}

// ── The pin's run ──────────────────────────────────────────────────────

interface Runtime {
    id: number;
    state: string;
    arenaOffset: number;
    arenaBytes: number;
    vertexByteOffset: number;
    indices: null;
    lastUsedFrame: number;
    priority: number;
    frameRefCount: number;
}

function pinnedRun(
    modules: Map<string, Exports>,
    files: readonly Uint8Array[],
    decoder: MeshoptDecoderValue,
    s: Scenario,
): string {
    const format = pinned(modules, FORMAT);
    const decoding = pinned(modules, DECODER);
    const math = pinned(modules, MATH);
    const cpu = pinned(modules, CPU);
    const cacheModule = pinned(modules, CACHE);
    const lines: string[] = [];
    const out = (line: string): number => lines.push(line);
    const guarded = (label: string, action: () => void): void => {
        try {
            action();
        } catch (error) {
            const thrown = error as { code?: string; message: string };
            out(`${label}: error ${thrown.code ?? "-"} ${thrown.message}`);
        }
    };
    const sums = <T>(
        records: readonly T[],
        fields: readonly ((record: T) => number)[],
    ): string =>
        fields
            .map((field) =>
                num(
                    records.reduce((total, record) => total + field(record), 0),
                ),
            )
            .join(",");
    const flag = (value: boolean): number => (value ? 1 : 0);

    // The containers.
    const parsedFiles = files.map((bytes, index) => {
        const label = `file ${index}`;
        const extent = call<{ totalFileBytes: number; bootstrapBytes: number }>(
            format,
            "readBootstrapExtent",
            bytes.subarray(0, 256),
        );
        out(
            `${label}: extent total=${num(extent.totalFileBytes)} bootstrap=${num(extent.bootstrapBytes)}`,
        );
        const parsed = parseBootstrap(format, bytes);
        const meta = call<{ [key: string]: string | number | Vector }>(
            format,
            "toMeshLoDMetadata",
            parsed,
        );
        out(
            `${label}: meta ${Object.entries(meta)
                .map(
                    ([key, value]) =>
                        `${key}=${typeof value === "number" ? num(value) : typeof value === "string" ? value : list(value)}`,
                )
                .join(" ")}`,
        );
        const { header } = parsed;
        out(
            `${label}: header flags=${num(header.containerFlags)} directory=${num(header.directoryOffset)}+${num(header.directoryBytes)} hierarchy=${header.hierarchyId} levels=${num(header.levelCount)} attributes=${num(header.attributeMask)} stride=${num(header.vertexStride)} maxError=${num(header.maxNonterminalError)}`,
        );
        out(
            `${label}: sections ${parsed.sections
                .map(
                    (section) =>
                        `${num(section.type)}:${num(section.flags)}:${num(section.offset)}:${num(section.storedBytes)}:${num(section.decodedBytes)}:${num(section.elementCount)}:${num(section.crc)}`,
                )
                .join(" ")}`,
        );
        out(
            `${label}: groups ${parsed.groups.length} ${sums(parsed.groups, [
                (group) => group.center[0],
                (group) => group.center[1],
                (group) => group.center[2],
                (group) => group.radius,
                (group) =>
                    Number.isFinite(group.simplifiedError)
                        ? group.simplifiedError
                        : 0,
                (group) => group.depth,
                (group) => group.firstCluster,
                (group) => group.clusterCount,
                (group) => group.firstPageRef,
                (group) => group.pageRefCount,
                (group) => flag(group.terminal),
                (group) => flag(group.pinned),
                (group) => group.sourceTriangleCount,
                (group) => group.outputTriangleCount,
            ])}`,
        );
        out(
            `${label}: clusters ${parsed.clusters.length} ${sums(
                parsed.clusters,
                [
                    (cluster) => cluster.center[0],
                    (cluster) => cluster.center[1],
                    (cluster) => cluster.center[2],
                    (cluster) => cluster.radius,
                    (cluster) => cluster.error,
                    (cluster) => cluster.groupId,
                    (cluster) => cluster.refinedGroupId,
                    (cluster) => cluster.pageId,
                    (cluster) => cluster.vertexOffset,
                    (cluster) => cluster.indexOffset,
                    (cluster) => cluster.vertexCount,
                    (cluster) => cluster.triangleCount,
                    (cluster) => cluster.sourceTriangleCount,
                    (cluster) => flag(cluster.normalCone != null),
                    (cluster) =>
                        cluster.normalCone
                            ? cluster.normalCone.reduce((a, b) => a + b, 0)
                            : 0,
                ],
            )}`,
        );
        out(
            `${label}: nodes ${parsed.hierarchyNodes.length} ${sums(
                parsed.hierarchyNodes,
                [
                    (node) => node.center[0],
                    (node) => node.center[1],
                    (node) => node.center[2],
                    (node) => node.radius,
                    (node) => node.error,
                    (node) => node.groupId,
                    (node) => node.childOffset,
                    (node) => node.childCount,
                ],
            )}`,
        );
        out(
            `${label}: pages ${parsed.pageRecords.length} ${sums(
                parsed.pageRecords,
                [
                    (page) => page.offset,
                    (page) => page.storedBytes,
                    (page) => page.meaningfulBytes,
                    (page) => page.decodedBytes,
                    (page) => page.crc,
                    (page) => page.vertexCount,
                    (page) => page.localIndexCount,
                    (page) => page.vertexByteOffset,
                    (page) => page.indexByteOffset,
                    (page) => page.firstCluster,
                    (page) => page.clusterCount,
                    (page) => flag(page.pinned),
                    (page) => flag(page.coarse),
                    (page) => page.minDepth,
                    (page) => page.maxDepth,
                ],
            )}`,
        );
        out(
            `${label}: refs ${parsed.groupPageRefs.length} ${num(parsed.groupPageRefs.reduce((a, b) => a + b, 0))} pinnedAllocation=${num(call<number>(cacheModule, "pinnedAllocationBytes", parsed.pageRecords))}`,
        );
        for (const id of s.decode[index]!) {
            const record = parsed.pageRecords[id]!;
            guarded(`page ${index}.${id}`, () => {
                const decoded = call<{
                    decoded: Uint8Array;
                    vertexCount: number;
                    indexCount: number;
                }>(
                    decoding,
                    "decodeMeshLoDPage",
                    bytes.subarray(
                        record.offset,
                        record.offset + record.storedBytes,
                    ),
                    record,
                    decoder,
                );
                out(
                    `page ${index}.${id}: vertices=${num(decoded.vertexCount)} indices=${num(decoded.indexCount)} bytes=${num(decoded.decoded.length)} crc=${num(call<number>(format, "crc32c", decoded.decoded))}`,
                );
            });
        }
        return parsed;
    });

    // Failures the pin reports with stable codes.
    const first = files[0]!;
    guarded("truncated", () =>
        call(format, "parseMeshLoDContainer", first.subarray(0, 200)),
    );
    guarded("bad magic", () => {
        const head = first.slice(0, 256);
        head[0] = 0;
        call(format, "readBootstrapExtent", head);
    });
    guarded("short bootstrap", () =>
        call(
            format,
            "parseMeshLoDContainer",
            first.subarray(0, parsedFiles[0]!.pageRecords[0]!.offset),
        ),
    );
    const record = parsedFiles[0]!.pageRecords[0]!;
    guarded("corrupt page", () => {
        const stored = first.slice(
            record.offset,
            record.offset + record.storedBytes,
        );
        stored[stored.length - 1]! ^= 0xff;
        call(decoding, "decodeMeshLoDPage", stored, record, decoder);
    });
    guarded("wrong record", () =>
        call(
            decoding,
            "decodeMeshLoDPage",
            first.subarray(record.offset, record.offset + record.storedBytes),
            parsedFiles[0]!.pageRecords[1]!,
            decoder,
        ),
    );

    // The CPU selector, each primitive's frames carrying its fine bits.
    const fineBits = new Map<number, Uint8Array>();
    s.frames.forEach((frame, index) => {
        const parsed = parsedFiles[frame.file]!;
        const planes = call<number[][]>(
            math,
            "extractFrustumPlanes",
            frame.matrix,
        );
        out(`frame ${index}: planes ${planes.map(list).join(" ")}`);
        const result = call<{
            selectedClusterIds: Uint32Array;
            desiredPages: { pageId: number; priority: number }[];
            pageBenefits: Map<number, number>;
            fineRequired: Uint8Array;
            visibleGroupCount: number;
            fallbackGroupCount: number;
            renderedTriangleCount: number;
            selectedMeshletCount: number;
            maximumSelectedErrorPixels: number;
            maximumUnmetErrorPixels: number;
        }>(cpu, "selectMeshLoDCpu", {
            groups: parsed.groups,
            clusters: parsed.clusters,
            nodes: parsed.hierarchyNodes,
            pageRecords: parsed.pageRecords,
            groupPageRefs: parsed.groupPageRefs,
            levelCount: parsed.header.levelCount,
            worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            camera: {
                position: frame.position,
                verticalFov: 0.8,
                near: 0.1,
                targetWidth: 1920,
                targetHeight: 1080,
            },
            frustumPlanes: planes,
            screenSpaceError: 1,
            lodHysteresis: 0.1,
            isPageResident: (pageId: number) =>
                parsed.pageRecords[pageId]!.pinned ||
                pageId % frame.residentModulo === 0,
            wasFineRequired:
                fineBits.get(frame.file) ??
                new Uint8Array(parsed.groups.length),
            coneCull: frame.coneCull,
        });
        fineBits.set(frame.file, result.fineRequired);
        let benefits = 0;
        for (const value of result.pageBenefits.values()) benefits += value;
        out(
            `frame ${index}: selected=${result.selectedClusterIds.length} ids=${num(result.selectedClusterIds.reduce((a, b) => a + b, 0))} desired=${result.desiredPages.length} ${result.desiredPages
                .slice(0, 8)
                .map((page) => `${num(page.pageId)}:${num(page.priority)}`)
                .join(
                    " ",
                )} benefits=${result.pageBenefits.size}:${num(benefits)} fine=${num(result.fineRequired.reduce((a, b) => a + b, 0))} visible=${num(result.visibleGroupCount)} fallback=${num(result.fallbackGroupCount)} triangles=${num(result.renderedTriangleCount)} meshlets=${num(result.selectedMeshletCount)} maxSelected=${num(result.maximumSelectedErrorPixels)} maxUnmet=${num(result.maximumUnmetErrorPixels)}`,
        );
    });

    // The CPU page cache over the first primitive's stored pages.
    const records = parsedFiles[0]!.pageRecords;
    const storedPage = (id: number): Uint8Array =>
        first.subarray(
            records[id]!.offset,
            records[id]!.offset + records[id]!.storedBytes,
        );
    const cache = call<{
        usedBytes: number;
        entries: Map<number, unknown>;
    }>(cacheModule, "createMeshLoDCpuPageCache", s.cacheBudget);
    s.cache.forEach((op, index) => {
        let result = "";
        if (op.op === "put")
            call(
                cacheModule,
                "putMeshLoDCpuPage",
                cache,
                op.page,
                storedPage(op.page),
                op.pinned,
                op.frame,
            );
        else if (op.op === "get") {
            const bytes = call<Uint8Array | null>(
                cacheModule,
                "getMeshLoDCpuPage",
                cache,
                op.page,
                op.frame,
            );
            result = ` got=${bytes ? num(bytes.length) : "null"}`;
        } else if (op.op === "touch")
            call(cacheModule, "touchMeshLoDCpuPage", cache, op.page, op.frame);
        else if (op.op === "budget")
            call(cacheModule, "setMeshLoDCpuCacheBudget", cache, op.bytes);
        else call(cacheModule, "clearMeshLoDCpuPageCache", cache);
        out(
            `cache ${index} ${op.op}:${result} used=${num(call<number>(cacheModule, "cpuCacheUsedBytes", cache))} ids=${[...cache.entries.keys()].join(",")}`,
        );
    });

    // The geometry arena and residency eviction over the first primitive's pages.
    const arena = {
        capacityBytes: s.arenaBlocks << 16,
        blockCount: s.arenaBlocks,
        buffer: null,
        blocks: new Uint8Array(s.arenaBlocks),
        pinnedBlocks: new Uint8Array(s.arenaBlocks),
        committedBlocks: 0,
        pinnedCount: 0,
    };
    const pages: Runtime[] = records.map((_, id) => ({
        id,
        state: "unrequested",
        arenaOffset: -1,
        arenaBytes: 0,
        vertexByteOffset: 0,
        indices: null,
        lastUsedFrame: 0,
        priority: id % 3,
        frameRefCount: 0,
    }));
    s.arena.forEach((op, index) => {
        let result = "";
        if (op.op === "alloc") {
            const offset = call<number | null>(
                cacheModule,
                "allocateArenaRun",
                arena,
                records[op.page]!.decodedBytes,
                op.pinned,
            );
            if (offset !== null)
                Object.assign(pages[op.page]!, {
                    state: "gpu-resident",
                    arenaOffset: offset,
                    arenaBytes: records[op.page]!.decodedBytes,
                    lastUsedFrame: index,
                });
            result = `offset=${offset === null ? "null" : num(offset)}`;
        } else if (op.op === "free") {
            const page = pages[op.page]!;
            call(
                cacheModule,
                "freeArenaRun",
                arena,
                page.arenaOffset,
                page.arenaBytes,
            );
            Object.assign(page, {
                state: "unrequested",
                arenaOffset: -1,
                arenaBytes: 0,
            });
        } else {
            const evicted: number[] = [];
            const policy = {
                budgetBytes: op.budget,
                currentFrame: op.frame,
                residencyHoldFrames: 120,
            };
            if (op.op === "reserve") {
                const offset = call<number | null>(
                    cacheModule,
                    "reserveMeshLoDArenaRun",
                    arena,
                    pages,
                    records,
                    records[op.page]!.decodedBytes,
                    policy,
                    evicted,
                );
                result = `offset=${offset === null ? "null" : num(offset)} `;
            } else
                call(
                    cacheModule,
                    "evictMeshLoDToBudget",
                    arena,
                    pages,
                    records,
                    policy,
                    evicted,
                );
            result += `evicted=${evicted.join(",")}`;
        }
        out(
            `arena ${index} ${op.op}: ${result} used=${num(call<number>(cacheModule, "arenaUsedBytes", arena))} committed=${num(arena.committedBlocks)} pinned=${num(arena.pinnedCount)} blocks=${Array.from(arena.blocks).join("")}`,
        );
    });
    return `${lines.join("\n")}\n`;
}

// ── The lowered core ───────────────────────────────────────────────────

test("the native meshopt decoder is the release the pinned decoder script is built from", async () => {
    const manifest = JSON.parse(readFileSync("native/vcpkg.json", "utf8")) as {
        overrides?: { name: string; version: string }[];
    };
    assert.equal(
        manifest.overrides?.find(({ name }) => name === "meshoptimizer")
            ?.version,
        await pinnedMeshoptVersion(),
    );
});

test("the lowered MeshLoD core parses, decodes, selects and caches the statue as the pin does", async (t) => {
    const family = lowerMeshLoDCore(new LoweringContext());
    const header = recordFamilyHeader(family);
    // The decoder is the platform's; the error codes stay the pin's strings.
    assert.match(header, /bbl::pal::MeshoptDecoder decoder/);
    assert.match(header, /"MLOD_PAGE_INTEGRITY"/);
    const modules = pinnedModules(MESH_LOD_CORE_MODULES);
    assert.ok(modules.has(ERRORS));
    const files = FILES.map((path) => new Uint8Array(readFileSync(path)));
    const parsed = files.map((bytes) =>
        parseBootstrap(pinned(modules, FORMAT), bytes),
    );
    const values = scenario(parsed);
    const expected = pinnedRun(
        modules,
        files,
        await pinnedMeshoptDecoder(),
        values,
    );
    const native = optionalNativeFixtureTools(true);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-mesh-lod-core");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "mesh-lod-core.hpp"), header);
    const scenarioPath = resolve(directory, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify(values));
    const exe = resolve(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        `/I${directory}`,
        resolve("test/fixtures/mesh-lod-core-check.cpp"),
        resolve("native/src/pal_meshopt.cpp"),
        `/Fo${directory}/`,
        `/Fe${exe}`,
        "/link",
        join(nativeFixtureVcpkgRoot, "lib/meshoptimizer.lib"),
    ]);
    const printed = runFixtureExecutable(exe, {
        cwd: directory,
        args: [scenarioPath, ...FILES.map((path) => resolve(path))],
        env: {
            ...native.environment,
            PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${native.environment.PATH ?? ""}`,
        },
    }).replaceAll("\r\n", "\n");
    writeFileSync(resolve(directory, "expected.txt"), expected);
    writeFileSync(resolve(directory, "printed.txt"), printed);
    assert.equal(printed, expected);
});
