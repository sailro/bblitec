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

    public build(): Buffer {
        return Buffer.concat(this.parts);
    }

    public get byteLength(): number {
        return this.length;
    }
}
