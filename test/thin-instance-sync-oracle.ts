import { importPinnedModule } from "../src/pinned-shader-composer.js";

interface BufferRecord {
    readonly id: number;
    readonly size: number;
    destroy(): void;
}
interface ThinPool {
    count: number;
    _capacity: number;
    _version: number;
    _gpuVersion: number;
    _dirtyMin: number;
    _dirtyMax: number;
    _colorVersion: number;
    _colorGpuVersion: number;
    _colorDirtyMin: number;
    _colorDirtyMax: number;
    _drawArgsInstanceCount?: number;
    _uploadF32?: Float32Array;
}
interface Mesh {
    thinInstances?: ThinPool;
}

/** Replay public operations against the pin; the native fixture replays the same calls. */
export async function thinInstanceSyncOracle(): Promise<{
    expected: string;
    statements: string;
}> {
    const api = await importPinnedModule<{
        setThinInstances(
            this: void,
            mesh: Mesh,
            matrices: Float32Array | Float64Array,
            count: number,
        ): void;
        setThinInstanceMatrix(
            this: void,
            mesh: Mesh,
            index: number,
            matrix: Float64Array,
        ): void;
        setThinInstanceColors(
            this: void,
            mesh: Mesh,
            colors: Float32Array,
        ): void;
        setThinInstanceColor(
            this: void,
            mesh: Mesh,
            index: number,
            r: number,
            g: number,
            b: number,
            a: number,
        ): void;
        setThinInstanceCount(this: void, mesh: Mesh, count: number): void;
        setThinInstanceDrawCount(this: void, mesh: Mesh, count: number): void;
        enableThinInstanceGpuCulling(
            this: void,
            mesh: Mesh,
            enabled: boolean,
        ): void;
    }>("mesh/thin-instance.js");
    const gpu = await importPinnedModule<{
        syncThinInstanceForDraw(
            this: void,
            engine: unknown,
            pool: ThinPool,
            colors: boolean,
            geometry: unknown,
        ): BufferRecord | null;
    }>("mesh/thin-instance-gpu.js");
    const { flushGpuResourceRetirements, disposeGpuResourceRetirements } =
        await importPinnedModule<{
            flushGpuResourceRetirements(this: void, engine: unknown): void;
            disposeGpuResourceRetirements(this: void, engine: unknown): void;
        }>("engine/gpu-resource-retirement.js");
    const events: string[] = [],
        statements: string[] = [];
    for (const wide of [false, true]) {
        const mesh: Mesh = {};
        let nextBuffer = 0,
            failWrite = false;
        const engine = {
            _device: {
                createBuffer(descriptor: {
                    size: number;
                    usage: number;
                }): BufferRecord {
                    const id = nextBuffer++;
                    events.push(
                        `C,${id},${descriptor.size},${descriptor.usage}`,
                    );
                    return {
                        id,
                        size: descriptor.size,
                        destroy() {
                            events.push(`D,${id}`);
                        },
                    };
                },
                queue: {
                    onSubmittedWorkDone: () => new Promise<void>(() => {}),
                    writeBuffer(
                        buffer: BufferRecord,
                        offset: number,
                        data: ArrayBuffer,
                        start: number,
                        length: number,
                    ) {
                        if (failWrite) {
                            failWrite = false;
                            events.push(`F,${buffer.id},${offset},${length}`);
                            throw new Error("fixture write failure");
                        }
                        events.push(
                            `W,${buffer.id},${offset},${Array.from(new Uint8Array(data, start, length)).join(",")}`,
                        );
                    },
                },
            },
        };
        const Values = wide ? Float64Array : Float32Array;
        const matrices = new Values(
            new ArrayBuffer(52 * Values.BYTES_PER_ELEMENT),
            2 * Values.BYTES_PER_ELEMENT,
            48,
        );
        for (let lane = 0; lane < matrices.length; ++lane)
            matrices[lane] = lane + 0.123456789;
        const colors = new Float32Array(new ArrayBuffer(64), 8, 12);
        for (let lane = 0; lane < colors.length; ++lane)
            colors[lane] = lane / 17;
        const geometry = { indexCount: 6, _baseVertex: -3 };
        const snapshot = () => {
            const pool = mesh.thinInstances!;
            events.push(
                `S,${[
                    pool.count,
                    pool._capacity,
                    pool._version,
                    pool._gpuVersion,
                    pool._dirtyMin,
                    pool._dirtyMax,
                    pool._colorVersion,
                    pool._colorGpuVersion,
                    pool._colorDirtyMin,
                    pool._colorDirtyMax,
                    pool._drawArgsInstanceCount ?? -99,
                    pool._uploadF32?.length ?? 0,
                ].join(",")}`,
            );
        };
        const step = (run: () => void, cpp: string) => {
            run();
            snapshot();
            statements.push(`${cpp}\nsnapshot(pool);`);
        };
        statements.push(
            `{\nEngine engine; engine.meshes.emplace_back(); RecordingDevice device;\nusing Values = js::${wide ? "F64" : "F32"}Array;\njs::ArrayBuffer matrix_bytes(std::make_shared<std::vector<std::uint8_t>>(52 * sizeof(Values::value_type)));\nValues matrices(matrix_bytes, 2 * sizeof(Values::value_type), 48);\nfor (std::size_t lane = 0; lane < matrices.size(); ++lane) matrices.store(lane, static_cast<Values::value_type>(lane + .123456789));\njs::ArrayBuffer color_bytes(std::make_shared<std::vector<std::uint8_t>>(64));\njs::F32Array colors(color_bytes, 8, 12);\nfor (std::size_t lane = 0; lane < colors.size(); ++lane) colors.store(lane, static_cast<float>(static_cast<double>(lane) / 17));\nThinInstanceGeometry geometry{6, -3};\nset_thin_instances(engine, {0}, matrices, 3);\nauto& pool = *engine.meshes[0].thin_instances;`,
        );
        api.setThinInstances(mesh, matrices, 3);
        step(
            () => api.setThinInstanceColors(mesh, colors),
            "set_thin_instance_colors(engine, {0}, colors);",
        );
        const sync = () => {
            gpu.syncThinInstanceForDraw(
                engine,
                mesh.thinInstances!,
                true,
                geometry,
            );
        };
        const syncCpp =
            "sync_thin_instance_for_draw(engine, pool, true, geometry, device);";
        step(sync, syncCpp);
        step(sync, syncCpp);
        const matrix = Float64Array.from(
            { length: 16 },
            (_, lane) => 100 + lane + 0.123456789,
        );
        step(
            () => api.setThinInstanceMatrix(mesh, 1, matrix),
            "js::F64Array changed(16); for (std::size_t lane = 0; lane < 16; ++lane) changed[lane] = 100 + lane + .123456789; set_thin_instance_matrix(engine, {0}, 1, js::NumericArrayView(changed));",
        );
        step(
            () => api.setThinInstanceColor(mesh, 2, 0.1, 0.2, 0.3, 0.4),
            "set_thin_instance_color(engine, {0}, 2, .1, .2, .3, .4);",
        );
        step(sync, syncCpp);
        step(
            () => api.setThinInstanceCount(mesh, 2),
            "set_thin_instance_count(engine, {0}, 2);",
        );
        step(sync, syncCpp);
        step(
            () => api.setThinInstanceDrawCount(mesh, 1),
            "set_thin_instance_draw_count(engine, {0}, 1);",
        );
        failWrite = true;
        step(() => {
            try {
                sync();
            } catch {
                /* The next sync must retry its acknowledgement. */
            }
        }, `device.fail_write = true; try { ${syncCpp} } catch (const std::runtime_error&) {}`);
        step(sync, syncCpp);
        step(() => {
            geometry.indexCount = 9;
            geometry._baseVertex = -7;
            sync();
        }, `geometry.index_count = 9; geometry.base_vertex = -7; ${syncCpp}`);
        step(
            () => api.enableThinInstanceGpuCulling(mesh, true),
            "enable_thin_instance_gpu_culling(engine, {0}, true);",
        );
        step(sync, syncCpp);
        const larger = new Values(80),
            moreColors = new Float32Array(20);
        step(
            () => api.setThinInstances(mesh, larger, 5),
            "Values larger(80); set_thin_instances(engine, {0}, larger, 5);",
        );
        step(
            () => api.setThinInstanceColors(mesh, moreColors),
            "js::F32Array more_colors(20); set_thin_instance_colors(engine, {0}, more_colors);",
        );
        step(sync, syncCpp);
        flushGpuResourceRetirements(engine);
        disposeGpuResourceRetirements(engine);
        statements.push("flush_retired();\n}");
    }
    return {
        expected: events.join("\n") + "\n",
        statements: statements.join("\n"),
    };
}
