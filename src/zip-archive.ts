import { inflateRawSync } from "node:zlib";

/** One file of an archive. */
export interface ArchiveMember {
    path: string;
    bytes: Uint8Array;
}

/** Whether bytes begin as a zip's first local file header does. */
export function isZip(bytes: Uint8Array): boolean {
    return (
        bytes.length >= 22 &&
        bytes[0] === 0x50 &&
        bytes[1] === 0x4b &&
        bytes[2] === 0x03 &&
        bytes[3] === 0x04
    );
}

/**
 * The stored files of a zip, read through the central directory.
 *
 * Node ships an inflate but no zip reader. This reads plain 32-bit zips
 * storing entries raw or deflated, and refuses anything else by name.
 */
export function zipMembers(bytes: Uint8Array, url: string): ArchiveMember[] {
    const archive = Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
    );
    const eocdSignature = 0x06054b50;
    let eocd = -1;
    const floor = Math.max(0, archive.length - 22 - 65535);
    for (let index = archive.length - 22; index >= floor; index--) {
        if (archive.readUInt32LE(index) === eocdSignature) {
            eocd = index;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error(`No zip end-of-central-directory in ${url}.`);
    }
    const count = archive.readUInt16LE(eocd + 10);
    const directoryOffset = archive.readUInt32LE(eocd + 16);
    if (count === 0xffff || directoryOffset === 0xffffffff) {
        throw new Error(`ZIP64 archives are not supported: ${url}.`);
    }
    const members: ArchiveMember[] = [];
    let cursor = directoryOffset;
    for (let index = 0; index < count; index++) {
        if (archive.readUInt32LE(cursor) !== 0x02014b50) {
            throw new Error(
                `Malformed zip central directory at ${cursor} in ${url}.`,
            );
        }
        const method = archive.readUInt16LE(cursor + 10);
        const compressedSize = archive.readUInt32LE(cursor + 20);
        const nameLength = archive.readUInt16LE(cursor + 28);
        const extraLength = archive.readUInt16LE(cursor + 30);
        const commentLength = archive.readUInt16LE(cursor + 32);
        const localOffset = archive.readUInt32LE(cursor + 42);
        const path = archive.toString(
            "utf8",
            cursor + 46,
            cursor + 46 + nameLength,
        );
        cursor += 46 + nameLength + extraLength + commentLength;
        if (path.endsWith("/")) continue;
        // The local header repeats name and extra with lengths of its
        // own, and its sizes can be deferred to a data descriptor, so the
        // central directory's sizes are the authoritative ones.
        if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new Error(
                `Malformed zip local header for ${path} in ${url}.`,
            );
        }
        const localNameLength = archive.readUInt16LE(localOffset + 26);
        const localExtraLength = archive.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const raw = archive.subarray(start, start + compressedSize);
        if (method === 0) {
            members.push({ path, bytes: raw });
        } else if (method === 8) {
            members.push({ path, bytes: inflateRawSync(raw) });
        } else {
            throw new Error(
                `Unsupported zip compression method ${method} for ${path} in ${url}.`,
            );
        }
    }
    return members;
}

/** One file of a zip, by its path. */
export function zipMember(
    bytes: Uint8Array,
    url: string,
    path: string,
): Uint8Array {
    const member = zipMembers(bytes, url).find(
        (candidate) => candidate.path === path,
    );
    if (!member) throw new Error(`No member '${path}' in ${url}.`);
    return member.bytes;
}
