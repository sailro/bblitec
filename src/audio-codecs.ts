export const AUDIO_CODECS = ["wav", "wv", "mpc", "flac", "mp3", "opus", "ogg"] as const;
export type AudioCodec = typeof AUDIO_CODECS[number];

/** Container signatures consumed by the pinned libnyquist decoders. */
export function audioCodecForBytes(bytes: Uint8Array): AudioCodec | undefined {
    const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 64)).toString("latin1");
    if (header.startsWith("RIFF") && header.length >= 12 && header.slice(8, 12) === "WAVE") return "wav";
    if (header.startsWith("wvpk")) return "wv";
    if (header.startsWith("MPCK")) return "mpc";
    if (header.startsWith("fLaC")) return "flac";
    if (header.startsWith("ID3") || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "mp3";
    if (header.startsWith("OggS")) {
        if (header.includes("OpusHead")) return "opus";
        if (header.includes("vorbis")) return "ogg";
    }
    return undefined;
}
