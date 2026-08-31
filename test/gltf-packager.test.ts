import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { specializeGltf } from "../src/asset-specializer.js";
import { resolveGeometryExtensions } from "../src/compressed-geometry.js";
import { packageGltf } from "../src/gltf-packager.js";
import { readUpstreamPin } from "../src/upstream-source.js";
import { buildGlb, readGlbFixture } from "./glb-fixture.js";

test("packages external glTF buffers and images into a GLB", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-package-"));
    try {
        mkdirSync(join(directory, "textures"));
        writeFileSync(join(directory, "mesh.bin"), Buffer.from([1, 2, 3, 4]));
        writeFileSync(join(directory, "textures", "color.png"), Buffer.from([5, 6, 7]));
        writeFileSync(
            join(directory, "scene.gltf"),
            JSON.stringify({
                asset: { version: "2.0" },
                buffers: [{ uri: "mesh.bin", byteLength: 4 }],
                bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
                images: [{ uri: "textures/color.png" }],
                textures: [{ source: 0 }],
                materials: [{ normalTexture: { index: 0, scale: 0.35 } }],
            }),
        );
        const glb = Buffer.from(await packageGltf("scene.gltf", directory));
        assert.equal(glb.readUInt32LE(0), 0x46546c67);
        const jsonLength = glb.readUInt32LE(12);
        const document = JSON.parse(
            glb.subarray(20, 20 + jsonLength).toString("utf8").trim(),
        ) as {
            buffers: Array<{ byteLength: number }>;
            bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }>;
            images: Array<{ bufferView: number; mimeType: string; uri?: string }>;
            materials: Array<{
                normalTexture: { index: number; scale: number };
            }>;
        };
        assert.equal(document.buffers.length, 1);
        assert.equal(document.bufferViews.length, 2);
        assert.deepEqual(document.images, [{ bufferView: 1, mimeType: "image/png" }]);
        assert.equal(document.images[0]?.uri, undefined);
        assert.deepEqual(document.materials[0]?.normalTexture, {
            index: 0,
            scale: 0.35,
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("preserves an untagged required meshopt fallback until decoding", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-meshopt-"));
    try {
        writeFileSync(
            join(directory, "compressed.bin"),
            Buffer.from([10, 20, 30, 40]),
        );
        writeFileSync(
            join(directory, "scene.gltf"),
            JSON.stringify({
                asset: { version: "2.0" },
                extensionsUsed: ["EXT_meshopt_compression"],
                extensionsRequired: ["EXT_meshopt_compression"],
                buffers: [
                    { uri: "compressed.bin", byteLength: 4 },
                    { byteLength: 12 },
                ],
                bufferViews: [
                    {
                        buffer: 1,
                        byteOffset: 0,
                        byteLength: 12,
                        byteStride: 4,
                        extensions: {
                            EXT_meshopt_compression: {
                                buffer: 0,
                                byteOffset: 0,
                                byteLength: 4,
                                byteStride: 4,
                                count: 3,
                                mode: "ATTRIBUTES",
                            },
                        },
                    },
                ],
            }),
        );

        const packaged = readGlbFixture(
            await packageGltf("scene.gltf", directory),
        );
        assert.deepEqual(packaged.document.buffers, [
            { byteLength: 4 },
            { byteLength: 12 },
        ]);
        assert.deepEqual(packaged.document.bufferViews, [
            {
                buffer: 1,
                byteOffset: 0,
                byteLength: 12,
                byteStride: 4,
                extensions: {
                    EXT_meshopt_compression: {
                        buffer: 0,
                        byteOffset: 0,
                        byteLength: 4,
                        byteStride: 4,
                        count: 3,
                        mode: "ATTRIBUTES",
                    },
                },
            },
        ]);
        assert.deepEqual([...packaged.binary.subarray(0, 4)], [10, 20, 30, 40]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("resolves meshopt packaging shapes in pinned order without leaking decoder state", async () => {
    // BrainStem bufferView 5: 18 tightly encoded MAT4 rows. Keeping one real
    // stream in the fixture exercises the pinned WASM decoder rather than only
    // the JSON packaging path.
    const compressed = Buffer.from(
        "oAUD/A/Pvr38+3AYWG8YwAAAAFgFA/wPz5STpqUw67oy68AAAAC6BQP8D88YF6eokLEgkrHAAAAAIAIAA0NAADQANAcAAACRzkkO+/zgTkDDpiFA8AAAAMOmBwAAAMCYJoJfYJ0AkT+5c5HwAAAAP7kHAAAA/ufo/V5dWNJ5VnpVefAAAABWegUD//39gRXpfZeYl+0J/BDwAAAACfwFA/wP/25t+vmB485qU+PwAAAAzmoFA/wP/yQjiYoqL4FaWC/wAAAAgVoFA/wP/6Khurn8avHKQWrwAAAA8coFA/wN/YeIeHd+8v/v8AAAAPL/AAAAAAUD/A/Pk5R0c4Vj6oVjwAAAAOoFA/wPjyIhf4AqKyorgAAAAAUD/A/PoqG6ufxqmvxqwAAAAJoFA/wNzXh3h4iBhH7AAAAAewcARLM3lA1IACIhtWJfcXBi8AAAAF9xBwBaWzE0fHsApaatPte5qz7wAAAA17kHACQlP0Y1AAA8O3ofm7IKH/AAAACbsgUD/Az87/Dv8O37E+/wAAAA+xMFA/wP/+nq7u1RETrA5xHwAAAAOsAFA/wO/hcYGRolN1oj8AAAADdaBQGYD/92mZm8eJnwAAAAmbwFAAAPP/wE//wEMAAAAP8AAAAABQP8D/+RkhESMVdKQDFX8AAAAEpABQP8D//Av4GCnXMjyZ1z8AAAACPJBQP8D//+/f791XlFadV58AAAAEVpBQP8Df1+fYGChQ+YevAAAAAPZwUD/A//b3BjZBM+WpMDPvAAAABakwUD/A//IyTr7PZb81j4W/AAAADzWAUD/A72FhWpqgO7vPAAAAC7vAUD/Aw8AwQDBP///zAAAAD/BwCfZ8f7f3oAODfub0a14G/wAAAARrUFN/yf/yIxMoiHqz7Vua0+8AAAANW5BwBITWhXaKsASknZH5uLtx/wAAAAm4sFA/wM/O/w7/Dt+4J68AAAAPuCAAAAAAcAAACYvImokjxBXdEjAPbRwAAAACMHAAAA3Cd9ewegKEjv4QAt78AAAADhBQP/j8+r5N/czjrAO4PAwAAAADsBA8wMDIH///z/BwDNW4a/sCSXv7goWpKVVVrwAAAAkpUHAK82PCZD5rLW7Hsvr3OrL/AAAACvcwcAMIZ8pYiJAAYLlbkRYGy58AAAABFgBQAYDPz/A//78AAAAAP/BwAJRr69u5yl+YRQKDfcyyjwAAAAN9wHAIRpcG9HSGpJ7gm9+ypvvfAAAAD7KgcAfcBeXT49v1UrHmyni8hs8AAAAKeLBTmZz/94//3+/f///vAAAAD9/wAAAAAAAIA/AAAAAAAAAAAAAAAAAAAAAA8AgLQAAIC/AAAAAAAAAAAAAIA/Yu8utAAAAAAAAAAAGTJqvwAAAAAAAIA/",
        "base64",
    );
    const glb = buildGlb(
        {
            asset: { version: "2.0" },
            extensionsUsed: [
                "EXT_meshopt_compression",
                "KHR_mesh_quantization",
            ],
            extensionsRequired: [
                "EXT_meshopt_compression",
                "KHR_mesh_quantization",
            ],
            buffers: [
                { byteLength: compressed.length },
                {
                    byteLength: 1152,
                    extensions: {
                        EXT_meshopt_compression: { fallback: true },
                    },
                },
            ],
            bufferViews: [
                {
                    buffer: 1,
                    byteOffset: 0,
                    byteLength: 1152,
                    byteStride: 64,
                    extensions: {
                        EXT_meshopt_compression: {
                            buffer: 0,
                            byteOffset: 0,
                            byteLength: compressed.length,
                            byteStride: 64,
                            count: 18,
                            mode: "ATTRIBUTES",
                        },
                    },
                },
            ],
            accessors: [
                {
                    bufferView: 0,
                    byteOffset: 0,
                    componentType: 5122,
                    count: 1,
                    type: "VEC4",
                },
            ],
        },
        compressed,
    );
    const decoderGlobal = globalThis as typeof globalThis & {
        MeshoptDecoder?: unknown;
    };
    const previous = Object.getOwnPropertyDescriptor(
        globalThis,
        "MeshoptDecoder",
    );
    const sentinel = Object.freeze({ sentinel: "meshopt-global" });
    Object.defineProperty(globalThis, "MeshoptDecoder", {
        configurable: true,
        value: sentinel,
        writable: true,
    });
    try {
        const resolved = readGlbFixture(
            await resolveGeometryExtensions(glb, "meshopt-fixture.glb"),
        );
        const document = resolved.document as {
            accessors: unknown[];
            bufferViews: unknown[];
            buffers: Array<{ byteLength: number }>;
            extensionsRequired?: string[];
            extensionsUsed: string[];
        };
        assert.equal(decoderGlobal.MeshoptDecoder, sentinel);
        assert.deepEqual(document.extensionsUsed, []);
        assert.equal(document.extensionsRequired, undefined);
        assert.deepEqual(document.buffers, [
            { byteLength: resolved.binary.length },
        ]);
        const decodedView = document.bufferViews[0] as {
            byteOffset: number;
            byteLength: number;
            extensions?: Record<string, unknown>;
        };
        const decoded = resolved.binary.subarray(
            decodedView.byteOffset,
            decodedView.byteOffset + decodedView.byteLength,
        );
        assert.equal(decoded.length, 1152);
        assert.equal(
            createHash("sha256").update(decoded).digest("hex"),
            "c22eed25def42824d73001b7decc35cb7dfa702cc483f47342be93c0bf487018",
        );
        assert.equal(
            decodedView.extensions?.EXT_meshopt_compression,
            undefined,
        );
        const accessor = document.accessors[0] as {
            bufferView: number;
            componentType: number;
        };
        assert.equal(accessor.componentType, 5126);
        assert.equal(accessor.bufferView, 1);

        const directory = mkdtempSync(
            // Keep the retry child below the repository so the pinned-module
            // importer can find the checkout while its cwd-relative decoder
            // cache remains isolated from the already-successful parent.
            join(process.cwd(), ".cache", "meshopt-contracts-"),
        );
        try {
            // A tagged fallback may still carry a URI. Packaging embeds both
            // physical buffers, rebases the fallback and compressed ranges
            // independently, and leaves the pinned hook to materialize the
            // same decoded view as the URI-less form above.
            writeFileSync(join(directory, "compressed.bin"), compressed);
            writeFileSync(
                join(directory, "fallback.bin"),
                Buffer.alloc(1152),
            );
            writeFileSync(
                join(directory, "uri-fallback.gltf"),
                JSON.stringify({
                    asset: { version: "2.0" },
                    extensionsUsed: ["EXT_meshopt_compression"],
                    extensionsRequired: ["EXT_meshopt_compression"],
                    buffers: [
                        {
                            uri: "compressed.bin",
                            byteLength: compressed.length,
                        },
                        {
                            uri: "fallback.bin",
                            byteLength: 1152,
                            extensions: {
                                EXT_meshopt_compression: { fallback: true },
                            },
                        },
                    ],
                    bufferViews: [
                        {
                            buffer: 1,
                            byteOffset: 0,
                            byteLength: 1152,
                            byteStride: 64,
                            extensions: {
                                EXT_meshopt_compression: {
                                    buffer: 0,
                                    byteOffset: 0,
                                    byteLength: compressed.length,
                                    byteStride: 64,
                                    count: 18,
                                    mode: "ATTRIBUTES",
                                },
                            },
                        },
                    ],
                }),
            );
            const uriPackagedBytes = await packageGltf(
                "uri-fallback.gltf",
                directory,
            );
            const uriPackaged = readGlbFixture(uriPackagedBytes);
            assert.deepEqual(uriPackaged.document.buffers, [
                { byteLength: compressed.length + 1152 },
            ]);
            const uriPackagedView = uriPackaged.document.bufferViews as Array<{
                buffer: number;
                byteOffset: number;
                extensions: {
                    EXT_meshopt_compression: {
                        buffer: number;
                        byteOffset: number;
                    };
                };
            }>;
            assert.equal(uriPackagedView[0]!.buffer, 0);
            assert.equal(uriPackagedView[0]!.byteOffset, compressed.length);
            assert.equal(
                uriPackagedView[0]!.extensions.EXT_meshopt_compression.buffer,
                0,
            );
            assert.equal(
                uriPackagedView[0]!.extensions.EXT_meshopt_compression.byteOffset,
                0,
            );
            const uriResolved = readGlbFixture(
                await resolveGeometryExtensions(
                    uriPackagedBytes,
                    "uri-fallback.gltf",
                ),
            );
            const uriResolvedView = (
                uriResolved.document.bufferViews as Array<{
                    byteOffset: number;
                    byteLength: number;
                    extensions?: Record<string, unknown>;
                }>
            )[0]!;
            assert.deepEqual(uriResolved.document.extensionsUsed, []);
            assert.equal(uriResolved.document.extensionsRequired, undefined);
            assert.equal(
                uriResolvedView.extensions?.EXT_meshopt_compression,
                undefined,
            );
            assert.equal(
                createHash("sha256")
                    .update(
                        uriResolved.binary.subarray(
                            uriResolvedView.byteOffset,
                            uriResolvedView.byteOffset +
                                uriResolvedView.byteLength,
                        ),
                    )
                    .digest("hex"),
                "c22eed25def42824d73001b7decc35cb7dfa702cc483f47342be93c0bf487018",
            );

            // Keep the compressed source in an existing GLB buffer 0, with
            // sparse indices/values following it. This forces the complete
            // meshopt -> sparse -> quantization order, then hands the result
            // to the same specializer/document reader generation uses.
            const sparseIndexOffset = compressed.length;
            const sparseValuesOffset = (sparseIndexOffset + 4) & ~3;
            const combinedBinary = Buffer.alloc(sparseValuesOffset + 6);
            compressed.copy(combinedBinary);
            combinedBinary[sparseIndexOffset] = 1;
            combinedBinary.writeInt16LE(100, sparseValuesOffset);
            combinedBinary.writeInt16LE(-200, sparseValuesOffset + 2);
            combinedBinary.writeInt16LE(300, sparseValuesOffset + 4);
            writeFileSync(
                join(directory, "combined.glb"),
                buildGlb(
                    {
                        asset: { version: "2.0" },
                        extensionsUsed: [
                            "EXT_meshopt_compression",
                            "KHR_mesh_quantization",
                        ],
                        extensionsRequired: [
                            "EXT_meshopt_compression",
                            "KHR_mesh_quantization",
                        ],
                        buffers: [
                            { byteLength: combinedBinary.length },
                            {
                                byteLength: 1152,
                                extensions: {
                                    EXT_meshopt_compression: {
                                        fallback: true,
                                    },
                                },
                            },
                        ],
                        bufferViews: [
                            {
                                buffer: 1,
                                byteOffset: 0,
                                byteLength: 1152,
                                byteStride: 64,
                                extensions: {
                                    EXT_meshopt_compression: {
                                        buffer: 0,
                                        byteOffset: 0,
                                        byteLength: compressed.length,
                                        byteStride: 64,
                                        count: 18,
                                        mode: "ATTRIBUTES",
                                    },
                                },
                            },
                            {
                                buffer: 0,
                                byteOffset: sparseIndexOffset,
                                byteLength: 1,
                            },
                            {
                                buffer: 0,
                                byteOffset: sparseValuesOffset,
                                byteLength: 6,
                            },
                        ],
                        accessors: [
                            {
                                bufferView: 0,
                                byteOffset: 0,
                                componentType: 5122,
                                count: 3,
                                type: "VEC3",
                                sparse: {
                                    count: 1,
                                    indices: {
                                        bufferView: 1,
                                        componentType: 5121,
                                    },
                                    values: { bufferView: 2 },
                                },
                            },
                        ],
                        meshes: [
                            {
                                name: "Combined",
                                primitives: [
                                    { attributes: { POSITION: 0 } },
                                ],
                            },
                        ],
                        nodes: [{ name: "CombinedNode", mesh: 0 }],
                    },
                    combinedBinary,
                ),
            );
            const combinedPackagedBytes = await packageGltf(
                "combined.glb",
                directory,
            );
            const combinedPackaged = readGlbFixture(combinedPackagedBytes);
            assert.equal(
                (
                    combinedPackaged.document.bufferViews as Array<{
                        extensions?: {
                            EXT_meshopt_compression?: { buffer: number };
                        };
                    }>
                )[0]!.extensions?.EXT_meshopt_compression?.buffer,
                0,
            );
            const combinedResolvedBytes = await resolveGeometryExtensions(
                combinedPackagedBytes,
                "combined.glb",
            );
            const combinedResolved = readGlbFixture(combinedResolvedBytes);
            const combinedAccessor = (
                combinedResolved.document.accessors as Array<{
                    bufferView: number;
                    byteOffset: number;
                    componentType: number;
                    normalized: boolean;
                    sparse?: unknown;
                }>
            )[0]!;
            assert.equal(combinedAccessor.sparse, undefined);
            assert.equal(combinedAccessor.componentType, 5126);
            assert.equal(combinedAccessor.normalized, false);
            assert.deepEqual(combinedResolved.document.extensionsUsed, []);
            assert.equal(
                combinedResolved.document.extensionsRequired,
                undefined,
            );
            const combinedView = (
                combinedResolved.document.bufferViews as Array<{
                    byteOffset: number;
                    byteLength: number;
                    extensions?: Record<string, unknown>;
                }>
            )[combinedAccessor.bufferView]!;
            assert.equal(combinedView.byteLength, 36);
            const overrideOffset =
                combinedView.byteOffset + combinedAccessor.byteOffset + 12;
            assert.deepEqual(
                [0, 1, 2].map((index) =>
                    combinedResolved.binary.readFloatLE(
                        overrideOffset + index * 4,
                    ),
                ),
                [100, -200, 300],
            );
            const combinedResolvedPath = join(
                directory,
                "combined-resolved.glb",
            );
            writeFileSync(
                combinedResolvedPath,
                Buffer.from(combinedResolvedBytes),
            );
            const specialization = specializeGltf(
                combinedResolvedPath,
                "combined-resolved.glb",
            );
            assert.deepEqual(specialization.extensionsUsed, []);
            assert.equal(specialization.renderItems.length, 1);
            assert.equal(specialization.renderItems[0]!.triangleCount, 1);

            // A fresh process starts with both caches empty. Two concurrent
            // requests share one failing artifact fetch; the guarded cache
            // eviction then lets two concurrent retries share one success.
            const retryFixture = join(directory, "retry.glb");
            writeFileSync(retryFixture, glb);
            const decoderArtifact = join(
                process.cwd(),
                ".cache",
                "pinned-decoders",
                readUpstreamPin().sourceVersion,
                "meshopt_decoder.js",
            );
            const compressedGeometryModule = new URL(
                "../src/compressed-geometry.js",
                import.meta.url,
            ).href;
            const retryScript = `
                import assert from "node:assert/strict";
                import { readFileSync } from "node:fs";

                const { resolveGeometryExtensions } = await import(
                    process.env.BBLITE_TEST_COMPRESSED_GEOMETRY_MODULE
                );
                const fixture = readFileSync(
                    process.env.BBLITE_TEST_MESHOPT_FIXTURE
                );
                const artifact = readFileSync(
                    process.env.BBLITE_TEST_MESHOPT_ARTIFACT
                );
                let attempts = 0;
                globalThis.fetch = async () => {
                    attempts++;
                    return attempts === 1
                        ? new Response("unavailable", { status: 503 })
                        : new Response(artifact);
                };
                const failed = await Promise.allSettled([
                    resolveGeometryExtensions(fixture, "concurrent-a.glb"),
                    resolveGeometryExtensions(fixture, "concurrent-b.glb"),
                ]);
                assert.deepEqual(
                    failed.map(({ status }) => status),
                    ["rejected", "rejected"]
                );
                assert.equal(attempts, 1);
                const retried = await Promise.all([
                    resolveGeometryExtensions(fixture, "retry-a.glb"),
                    resolveGeometryExtensions(fixture, "retry-b.glb"),
                ]);
                assert.equal(attempts, 2);
                assert.equal(retried.length, 2);
            `;
            const retry = spawnSync(
                process.execPath,
                ["--input-type=module", "--eval", retryScript],
                {
                    cwd: directory,
                    encoding: "utf8",
                    env: {
                        ...process.env,
                        BBLITE_TEST_COMPRESSED_GEOMETRY_MODULE:
                            compressedGeometryModule,
                        BBLITE_TEST_MESHOPT_FIXTURE: retryFixture,
                        BBLITE_TEST_MESHOPT_ARTIFACT: decoderArtifact,
                    },
                    maxBuffer: 1024 * 1024,
                    windowsHide: true,
                },
            );
            assert.equal(
                retry.status,
                0,
                `meshopt retry child failed:\n${retry.stdout}\n${retry.stderr}`,
            );
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    } finally {
        if (previous) {
            Object.defineProperty(globalThis, "MeshoptDecoder", previous);
        } else {
            delete decoderGlobal.MeshoptDecoder;
        }
    }
});

test("rejects a malformed meshopt fallback buffer before packaging", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-meshopt-invalid-"));
    try {
        writeFileSync(join(directory, "compressed.bin"), Buffer.from([1]));
        writeFileSync(
            join(directory, "scene.gltf"),
            JSON.stringify({
                asset: { version: "2.0" },
                extensionsUsed: ["EXT_meshopt_compression"],
                extensionsRequired: ["EXT_meshopt_compression"],
                buffers: [
                    { uri: "compressed.bin", byteLength: 1 },
                    {
                        byteLength: 4,
                        extensions: {
                            EXT_meshopt_compression: { fallback: true },
                        },
                    },
                ],
                bufferViews: [
                    { buffer: 1, byteOffset: 0, byteLength: 4 },
                ],
            }),
        );

        await assert.rejects(
            packageGltf("scene.gltf", directory),
            /fallback buffer 1 is referenced by bufferView 0 without EXT_meshopt_compression/,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("rejects a URI-less meshopt fallback absent from extensionsUsed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-meshopt-used-"));
    try {
        writeFileSync(join(directory, "compressed.bin"), Buffer.from([1]));
        writeFileSync(
            join(directory, "scene.gltf"),
            JSON.stringify({
                asset: { version: "2.0" },
                extensionsRequired: ["EXT_meshopt_compression"],
                buffers: [
                    { uri: "compressed.bin", byteLength: 1 },
                    { byteLength: 4 },
                ],
                bufferViews: [
                    {
                        buffer: 1,
                        byteOffset: 0,
                        byteLength: 4,
                        extensions: {
                            EXT_meshopt_compression: {
                                buffer: 0,
                                byteOffset: 0,
                                byteLength: 1,
                                byteStride: 4,
                                count: 1,
                                mode: "ATTRIBUTES",
                            },
                        },
                    },
                ],
            }),
        );

        await assert.rejects(
            packageGltf("scene.gltf", directory),
            /must be listed in extensionsUsed/,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("rejects invalid meshopt fallback and compressed source ranges", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-meshopt-range-"));
    try {
        writeFileSync(join(directory, "compressed.bin"), Buffer.from([1]));
        const document = {
            asset: { version: "2.0" },
            extensionsUsed: ["EXT_meshopt_compression"],
            extensionsRequired: ["EXT_meshopt_compression"],
            buffers: [
                { uri: "compressed.bin", byteLength: 1 },
                { byteLength: 4 },
            ],
            bufferViews: [
                {
                    buffer: 1,
                    byteOffset: -1,
                    byteLength: 4,
                    extensions: {
                        EXT_meshopt_compression: {
                            buffer: 0,
                            byteOffset: 0,
                            byteLength: 1,
                            byteStride: 4,
                            count: 1,
                            mode: "ATTRIBUTES",
                        },
                    },
                },
            ],
        };
        writeFileSync(join(directory, "scene.gltf"), JSON.stringify(document));
        await assert.rejects(
            packageGltf("scene.gltf", directory),
            /bufferView 0 byteOffset must be a non-negative integer/,
        );

        document.bufferViews[0]!.byteOffset = 0;
        document.bufferViews[0]!.extensions.EXT_meshopt_compression.byteOffset = 1;
        writeFileSync(join(directory, "scene.gltf"), JSON.stringify(document));
        await assert.rejects(
            packageGltf("scene.gltf", directory),
            /source range on bufferView 0 exceeds buffer 0/,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("embeds an external image referenced by a GLB beside that GLB", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-glb-package-"));
    try {
        mkdirSync(join(directory, "models", "Textures"), { recursive: true });
        writeFileSync(
            join(directory, "models", "scene.glb"),
            buildGlb(
                {
                    asset: { version: "2.0" },
                    buffers: [{ byteLength: 4 }],
                    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
                    images: [{ uri: "Textures/color.png", name: "color" }],
                    textures: [{ source: 0 }],
                },
                Buffer.from([1, 2, 3, 4]),
            ),
        );
        writeFileSync(
            join(directory, "models", "Textures", "color.png"),
            Buffer.from([5, 6, 7]),
        );

        const packaged = readGlbFixture(
            await packageGltf("models/scene.glb", directory),
        );
        assert.deepEqual(packaged.document.bufferViews, [
            { buffer: 0, byteOffset: 0, byteLength: 4 },
            { buffer: 0, byteOffset: 4, byteLength: 3 },
        ]);
        assert.deepEqual(packaged.document.images, [
            { name: "color", bufferView: 1, mimeType: "image/png" },
        ]);
        assert.deepEqual([...packaged.binary.subarray(0, 7)], [1, 2, 3, 4, 5, 6, 7]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
