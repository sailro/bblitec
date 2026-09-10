import { asIndex, asRecords, type JsonObject } from "./gltf-document.js";
import { BinaryBuilder } from "./glb-binary-builder.js";
import { RecordedBuffer } from "./recording-device.js";

interface VertexLayout {
    _offset: number;
    _stride: number;
    _count: number;
    _componentType: number;
    _componentCount: number;
}

/** Resource fields produced by the pinned tight and interleaved mesh builders. */
export interface GltfRecordedGeometry {
    positionBuffer: RecordedBuffer;
    normalBuffer: RecordedBuffer;
    tangentBuffer: RecordedBuffer | null;
    uvBuffer: RecordedBuffer;
    uv2Buffer: RecordedBuffer | null;
    colorBuffer: RecordedBuffer | null;
    indexBuffer: RecordedBuffer;
    indexCount: number;
    indexFormat: string;
    _vbLayout?: Partial<Record<"_p" | "_n" | "_t" | "_u" | "_u2" | "_c", VertexLayout>>;
}

export interface GltfMeshGeometry {
    attributes: Record<string, number>;
    indices: number;
}

/** Rehouse recorded GPU bytes in GLB accessors without repeating extraction. */
export class GltfGeometryPacker {
    public readonly accessors: JsonObject[];
    public readonly bufferViews: JsonObject[];
    private readonly binary: BinaryBuilder;
    private readonly buffers = new Map<object, {offset: number; views: Map<number, number>}>();

    public constructor(document: JsonObject, bin: DataView) {
        this.accessors = asRecords(document.accessors);
        this.bufferViews = asRecords(document.bufferViews);
        this.binary = new BinaryBuilder(Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength));
    }

    public accessor(buffer: RecordedBuffer, count: number, components: number, componentType: number, layout?: VertexLayout): number {
        const bytes = componentType === 5123 ? 2 : 4;
        const stride = layout?._stride ?? components * bytes;
        const offset = layout?._offset ?? 0;
        if (!(buffer instanceof RecordedBuffer) || buffer.destroyed || asIndex(count) === undefined ||
            asIndex(stride) === undefined || asIndex(offset) === undefined || stride < components * bytes ||
            offset % bytes !== 0 || stride % bytes !== 0 ||
            (layout && (layout._count !== count || layout._componentType !== componentType || layout._componentCount !== components)) ||
            offset + (count ? (count - 1) * stride + components * bytes : 0) > buffer.size)
            throw new Error("Unsupported recorded glTF vertex/index buffer layout.");
        const view = this.bufferView(buffer, new Uint8Array(buffer.bytes), layout ? stride : 0);
        const index = this.accessors.length;
        this.accessors.push({bufferView: view, byteOffset: offset, count, componentType, type: components === 1 ? "SCALAR" : `VEC${components}`});
        return index;
    }

    private bufferView(identity: object, bytes: Uint8Array, stride = 0): number {
        let packed = this.buffers.get(identity);
        if (!packed) {
            packed = {offset: this.binary.append(bytes), views: new Map()};
            this.buffers.set(identity, packed);
        }
        let view = packed.views.get(stride);
        if (view === undefined) {
            view = this.bufferViews.length;
            this.bufferViews.push({buffer: 0, byteOffset: packed.offset, byteLength: bytes.byteLength, ...(stride ? {byteStride: stride} : {})});
            packed.views.set(stride, view);
        }
        return view;
    }

    /** CPU construction results use the same binary transport as recorded uploads. */
    public float32(data: Float32Array, components: 1 | 2 | 3 | 4): number {
        if (data.length % components !== 0) throw new Error("Incomplete glTF construction elements.");
        const view = this.bufferView(data, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        const index = this.accessors.length;
        this.accessors.push({bufferView: view, count: data.length / components, componentType: 5126, type: components === 1 ? "SCALAR" : `VEC${components}`});
        return index;
    }

    public geometry(gpu: GltfRecordedGeometry, vertexCount: number): GltfMeshGeometry {
        const attributes: Record<string, number> = {};
        const attribute = (name: string, buffer: RecordedBuffer | null, components: number, layout: VertexLayout | undefined, required = false): void => {
            if (buffer === null && !required) return;
            if (!(buffer instanceof RecordedBuffer)) throw new Error(`Missing recorded glTF ${name} buffer.`);
            attributes[name] = this.accessor(buffer, vertexCount, components, 5126, layout);
        };
        const layout = gpu._vbLayout;
        attribute("POSITION", gpu.positionBuffer, 3, layout?._p, true);
        attribute("NORMAL", gpu.normalBuffer, 3, layout?._n, true);
        attribute("TANGENT", gpu.tangentBuffer, 4, layout?._t);
        attribute("TEXCOORD_0", gpu.uvBuffer, 2, layout?._u, true);
        attribute("TEXCOORD_1", gpu.uv2Buffer, 2, layout?._u2);
        attribute("COLOR_0", gpu.colorBuffer, 4, layout?._c);
        if (gpu.indexFormat !== "uint16" && gpu.indexFormat !== "uint32") throw new Error("Unsupported recorded glTF index format.");
        return {attributes, indices: this.accessor(gpu.indexBuffer, gpu.indexCount, 1, gpu.indexFormat === "uint16" ? 5123 : 5125)};
    }

    public build(): Buffer { return this.binary.build(); }
}
