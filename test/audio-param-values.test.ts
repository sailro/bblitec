import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    FIXTURE_APPLICATION,
    native,
    runAudioProgram,
} from "./static-sound-fixture.js";

/**
 * Parameter values written, read and used later: a read is one float the
 * timeline holds, widened once to the double JavaScript sees, and a later
 * write never changes a value read before it. The program reports its
 * values, and fails unless they are `expected` (when given).
 */
const program = (expected: string): string => `
const EXPECTED: string = ${JSON.stringify(expected)};
const wait = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function main(): Promise<void> {
    await wait();
    const context = new AudioContext();
    const gain = context.createGain();
    gain.gain.value = 0.1;
    const read = gain.gain.value + 1;
    gain.gain.value = 5;
    const param = gain.gain;
    param.value = 0.3;
    const twice = param.value * 2;
    const larger = Math.max(param.value, 0.25);
    param.value = 7;
    const panner = context.createStereoPanner();
    panner.pan.value = -0.7;
    const pan = panner.pan.value;
    panner.pan.value = 0;
    const line = String(read) + " " + String(twice) + " " + String(larger) + " " + String(pan) + " " +
        String(gain.gain.value) + " " + String(panner.pan.value);
    if (EXPECTED !== "" && line !== EXPECTED) throw new Error("values " + line);
    console.log(line);
    globalThis.close();
}
void main();
`;

/** The same program in Node over a parameter that stores single precision, as Web Audio's does. */
async function nodeOutput(): Promise<string> {
    const lines: string[] = [];
    class AudioParam {
        #value = 0;
        get value(): number {
            return this.#value;
        }
        set value(next: number) {
            this.#value = Math.fround(next);
        }
    }
    class AudioContext {
        createGain(): { gain: AudioParam } {
            return { gain: new AudioParam() };
        }
        createStereoPanner(): { pan: AudioParam } {
            return { pan: new AudioParam() };
        }
    }
    const done = new Promise<void>((resolve) => {
        runInNewContext(
            ts.transpileModule(program(""), {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
            {
                AudioContext,
                setTimeout,
                Promise,
                Math,
                console: { log: (line: string) => lines.push(line) },
                close: resolve,
            },
        );
    });
    await done;
    return lines.join("\n");
}

test("AudioParam values read once, as the float-rounded double JavaScript sees", async (t) => {
    const output = resolve("artifacts/audio-param-values");
    mkdirSync(output, { recursive: true });
    const expected = await nodeOutput();
    assert.equal(
        expected,
        "1.1000000014901161 0.6000000238418579 0.30000001192092896 -0.699999988079071 7 0",
    );
    const result = compileSource(program(expected), {
        fileName: join(output, "entry.ts"),
    });
    // Each read is the record's widening, and a const keeps what it read.
    assert.match(
        result.cpp,
        /double v_fn0_read = \(static_cast<double>\(bbl::pal::audio_param_value\(/,
    );
    if (!native) {
        t.skip("The native compiler and pinned LabSound library are required.");
        return;
    }
    writeFileSync(join(output, "program.hpp"), result.cpp);
    writeFileSync(
        join(output, "check.cpp"),
        `#include "pal_audio_labsound.cpp"
#include <bblite/pal_audio_async.hpp>
#define main generated_main
#include "program.hpp"
#undef main
const char* bbl::pal::bblite_build_stamp() { return "audio-param-values"; }
${FIXTURE_APPLICATION}`,
    );
    // The native run fails unless it reports Node's values.
    assert.equal(
        runAudioProgram(
            output,
            join(output, "check.cpp"),
            ["/DBBLITE_HAS_AUDIO_STEREO_PANNER=1"],
            [],
        ),
        "",
    );
});
