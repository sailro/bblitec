/**
 * `Blob` in a generation realm (`executed-application-function.ts`).
 *
 * Construction is the File API's own: the parts are copied when the Blob is
 * made (an ArrayBuffer or a view's bytes, a Blob's bytes, any other value as
 * its USVString in UTF-8) and the type is lowercased, or emptied when it holds
 * a character outside U+0020-U+007E. Nothing about it reads host state, so a
 * run that builds one builds the browser's bytes. Reading a Blob back is
 * asynchronous in the browser and is not carried: its readers throw, and the
 * bytes leave the realm only through `generationBlobBytes`.
 */
import { types } from "node:util";

const contents = new WeakMap<GenerationBlob, { bytes: Buffer; type: string }>();

function unsupported(member: string): never {
    throw new Error(`Blob.${member} is not carried at generation.`);
}

function partBytes(part: unknown): Buffer {
    if (part instanceof GenerationBlob) return contents.get(part)!.bytes;
    if (types.isArrayBuffer(part)) return Buffer.from(new Uint8Array(part));
    if (ArrayBuffer.isView(part)) {
        if (types.isSharedArrayBuffer(part.buffer)) {
            throw new TypeError("A Blob part cannot view a SharedArrayBuffer.");
        }
        return Buffer.from(
            new Uint8Array(part.buffer, part.byteOffset, part.byteLength),
        );
    }
    if (types.isSharedArrayBuffer(part)) {
        throw new TypeError("A Blob part cannot be a SharedArrayBuffer.");
    }
    // A USVString: UTF-8 replaces a lone surrogate as the conversion does.
    return Buffer.from(`${part as string}`, "utf8");
}

export class GenerationBlob {
    public constructor(parts?: Iterable<unknown>, options?: unknown) {
        if (
            parts !== undefined &&
            (parts === null || typeof parts !== "object")
        )
            throw new TypeError("Blob parts must be a sequence.");
        if (
            options !== undefined &&
            options !== null &&
            typeof options !== "object"
        )
            throw new TypeError("Blob options must be a record.");
        const record = (options ?? {}) as { type?: unknown; endings?: unknown };
        if (
            record.endings !== undefined &&
            `${record.endings as string}` !== "transparent"
        ) {
            throw new Error(
                "Blob 'native' line endings depend on the host, which generation does not read.",
            );
        }
        const type =
            record.type === undefined ? "" : `${record.type as string}`;
        const bytes = Buffer.concat(
            [...(parts ?? [])].map((part) => partBytes(part)),
        );
        contents.set(this, {
            bytes,
            type: /^[ -~]*$/.test(type) ? type.toLowerCase() : "",
        });
    }

    public get size(): number {
        return contents.get(this)!.bytes.length;
    }

    public get type(): string {
        return contents.get(this)!.type;
    }

    public arrayBuffer(): never {
        return unsupported("arrayBuffer");
    }

    public bytes(): never {
        return unsupported("bytes");
    }

    public text(): never {
        return unsupported("text");
    }

    public slice(): never {
        return unsupported("slice");
    }

    public stream(): never {
        return unsupported("stream");
    }
}

/** The bytes and type of a Blob a generation run built, or undefined for any other value. */
export function generationBlobBytes(
    value: unknown,
): { bytes: Buffer; type: string } | undefined {
    return value instanceof GenerationBlob ? contents.get(value) : undefined;
}
