/**
 * A copy of `bytes` in an ArrayBuffer of exactly its length. A GLB binary
 * chunk is one: the pinned loader views it as the browser's fetched
 * ArrayBuffer, and the packaged CPU streams carry the whole `buffer` behind
 * its typed arrays. Node instead places a small `Buffer.from`/`concat`
 * result in a shared allocation slab, whose other bytes belong to whatever
 * the process allocated before.
 */
export function ownedBytes(bytes: Uint8Array): Buffer<ArrayBuffer> {
    const owned = Buffer.alloc(bytes.byteLength);
    owned.set(bytes);
    return owned;
}

/** Appends bytes to the binary chunk at the 4-byte alignment glTF wants. */
export class BinaryBuilder {
    private readonly parts: Buffer[] = [];
    private length = 0;

    public constructor(initial: Buffer) {
        this.parts.push(initial);
        this.length = initial.length;
    }

    /**
     * The bytes are held as a view rather than copied: every caller appends
     * a buffer it has just produced and does not touch again, and one of
     * them is an 11 MB splat row buffer.
     */
    public append(bytes: ArrayBufferView): number {
        const padding = (4 - (this.length % 4)) % 4;
        if (padding) {
            this.parts.push(Buffer.alloc(padding));
            this.length += padding;
        }
        const offset = this.length;
        this.parts.push(
            Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        );
        this.length += bytes.byteLength;
        return offset;
    }

    /** The chunk, owning its ArrayBuffer (`ownedBytes`). */
    public build(): Buffer {
        const built = Buffer.alloc(this.length);
        let offset = 0;
        for (const part of this.parts) {
            built.set(part, offset);
            offset += part.length;
        }
        return built;
    }

    public get byteLength(): number {
        return this.length;
    }
}
