import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeCapturedUniforms } from "../src/capture-uniforms.js";
import { buildRenderDiff } from "../src/render-diff.js";

for (const legacy of [false, true]) {
    test(`uniform and render diagnostics share ${legacy ? "wrapped legacy" : "array"} capture buffers`, () => {
        const root = mkdtempSync(join(tmpdir(), "capture-values-"));
        try {
            const capture = join(root, "capture");
            mkdirSync(join(capture, "shaders"), { recursive: true });
            writeFileSync(
                join(capture, "shaders", "values.wgsl"),
                "struct Values { value: vec4<f32>, };",
            );
            const values = [0.25, 0.5, 0.75, 1.5];
            const bytes = Buffer.alloc(16);
            values.forEach((value, index) =>
                bytes.writeFloatLE(value, index * 4),
            );
            const data = bytes.toString("base64");
            const identity = (id: number, size?: number) =>
                legacy ? { index: id, byteLength: size } : { id, size };
            const write = legacy ? { bytes: data } : { data };
            const buffers = [
                {
                    ...identity(1, 16),
                    usage: 0x40,
                    writes: [{ data: "AAAAAA==" }, write],
                },
                { ...identity(2, 16), usage: 0x80, writes: [write] },
                { ...identity(3, 16), usage: 0x40, mappedWrites: [write] },
                { ...identity(4), usage: 0x80, writes: [data] },
                { ...identity(5, 4112), usage: 0x80, writes: [write] },
                { ...identity(6, 16), usage: 0x20, writes: [write] },
                { ...identity(7, 16), usage: 0x40, writes: [] },
                {
                    ...identity(8),
                    usage: 0x80,
                    writes: [Buffer.alloc(4112).toString("base64")],
                },
            ];
            writeFileSync(
                join(capture, "buffers.json"),
                JSON.stringify(legacy ? { buffers } : buffers),
            );
            const nativeCapture = join(capture, "native-gpu.json");
            writeFileSync(
                nativeCapture,
                JSON.stringify({
                    backend: "sdl_gpu",
                    buildStamp: "test",
                    viewport: { width: 1, height: 1 },
                    draws: [],
                    backgroundUniforms: [],
                }),
            );

            const decoded = decodeCapturedUniforms(capture);
            assert.deepEqual(
                decoded.map(({ id, size }) => ({ id, size })),
                [
                    { id: "1", size: 16 },
                    { id: "2", size: 16 },
                    { id: "3", size: 16 },
                    { id: "4", size: 16 },
                ],
            );
            for (const buffer of decoded) {
                assert.deepEqual(buffer.candidates[0]?.fields, [
                    { name: "value", type: "vec4<f32>", values },
                ]);
            }
            const report = buildRenderDiff(
                "values",
                capture,
                nativeCapture,
                root,
            );
            assert.equal(report.summary.browserFields, decoded.length);
            assert.deepEqual(
                report.browserOnly,
                decoded.map(({ id }) => ({
                    name: `buffer#${id} value`,
                    values,
                })),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
}
