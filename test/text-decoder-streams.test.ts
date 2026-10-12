import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/** Chunked inputs whose streamed decode Node's TextDecoder (Encoding Standard) answers. */
const STREAMS: readonly {
    readonly chunks: readonly (readonly number[])[];
    readonly fatal?: boolean;
    readonly ignoreBOM?: boolean;
    /** The last chunk is decoded without `stream`, which flushes. */
    readonly flushWithLast?: boolean;
}[] = [
    { chunks: [[0xe2], [0x82], [0xac]], fatal: true },
    {
        chunks: [
            [0xef, 0xbb],
            [0xbf, 0x41, 0xef, 0xbb, 0xbf],
        ],
    },
    {
        chunks: [
            [0xef, 0xbb],
            [0xbf, 0x41],
        ],
        ignoreBOM: true,
    },
    { chunks: [[0xf0, 0x9f], [0x98], [0x80, 0x21]] },
    { chunks: [[0xf0, 0x9f]] },
    { chunks: [[0xe0, 0x80], [0x41]] },
    { chunks: [[0xed, 0xa0], [0x80]] },
    { chunks: [[0xe2], [0x41]], flushWithLast: true },
    { chunks: [[0x61, 0xc3], [0xa9, 0xe2, 0x82], [0xac]], fatal: true },
];

function decodeInNode(entry: (typeof STREAMS)[number]): string {
    const decoder = new TextDecoder("utf-8", {
        fatal: entry.fatal ?? false,
        ignoreBOM: entry.ignoreBOM ?? false,
    });
    let text = "";
    entry.chunks.forEach((chunk, index) => {
        const last = index === entry.chunks.length - 1;
        text += decoder.decode(new Uint8Array(chunk), {
            stream: !(last && entry.flushWithLast),
        });
    });
    if (!entry.flushWithLast) text += decoder.decode();
    return text;
}

test("streaming TextDecoder keeps incomplete sequences and the BOM state across calls", () => {
    const cases = STREAMS.map((entry, index) => {
        const chunks = entry.chunks
            .map((chunk, position) => {
                const last = position === entry.chunks.length - 1;
                return `text${index} += decoder${index}.decode(new Uint8Array(${JSON.stringify(chunk)}), { stream: ${!(last && entry.flushWithLast)} });`;
            })
            .join(" ");
        return `
            const decoder${index} = new TextDecoder("utf-8", { fatal: ${entry.fatal ?? false}, ignoreBOM: ${entry.ignoreBOM ?? false} });
            let text${index} = "";
            ${chunks}
            ${entry.flushWithLast ? "" : `text${index} += decoder${index}.decode();`}
            if (text${index} !== ${JSON.stringify(decodeInNode(entry))}) throw new Error("stream ${index}: " + text${index});`;
    });
    const source = `
        ${cases.join("\n")}
        const strict = new TextDecoder("utf-8", { fatal: true });
        strict.decode(new Uint8Array([0xe2, 0x82]), { stream: true });
        let flushed = false;
        try { strict.decode(); } catch (error) { flushed = error instanceof TypeError; }
        if (!flushed) throw new Error("fatal flush of an incomplete sequence");
        if (strict.decode(new Uint8Array([0x41]), { stream: true }) !== "A") throw new Error("a failed stream restarts");
        const chunk = new Uint8Array([0xe2, 0x82, 0xac]);
        const options = { stream: true };
        const reused = new TextDecoder();
        const first = reused.decode(chunk.subarray(0, 2), options);
        if (first !== "" || reused.decode(chunk.subarray(2), options) + reused.decode() !== "\\u20ac") throw new Error("record options");
    `;
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(tools, "text-decoder-streams/decode", result.cpp, {
        expectedOutput: "",
    });
});
