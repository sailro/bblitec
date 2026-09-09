import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { compileSource } from "../src/compiler.js";
import { AUDIO_CODECS, audioCodecForBytes } from "../src/audio-codecs.js";

const tools = optionalNativeFixtureTools(false);
const labSound = resolve("artifacts/tools/labsound");

test("audio codec signatures distinguish supported containers with bounded reads", () => {
    const cases = [
        ["RIFF0000WAVE", "wav"], ["wvpk", "wv"], ["MPCK", "mpc"], ["fLaC", "flac"],
        ["ID3", "mp3"], ["OggS0000OpusHead", "opus"], ["OggS0000vorbis", "ogg"],
    ] as const;
    for (const [header, codec] of cases) assert.equal(audioCodecForBytes(Buffer.from(header)), codec);
    assert.equal(audioCodecForBytes(new Uint8Array([255, 251])), "mp3");
    for (const header of ["", "R", "RIFF", "RIFF0000AVI ", "OggS", "not audio"]) {
        assert.equal(audioCodecForBytes(Buffer.from(header)), undefined);
    }
});

test("direct packaged audio reads select byte formats and stored buffers keep all decoders", () => {
    const output = resolve("artifacts/audio-codec-selection");
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, "encoded.bin"), "RIFF0000WAVE");
    const compile = (body: string) => compileSource(`
        import { createAudioEngineAsync } from "@babylonjs/lite";
        const audio = await createAudioEngineAsync();
        const response = await fetch("encoded.bin");
        ${body}
    `, { fileName: resolve(output, "input.ts") }).manifest.features.filter(feature => feature.startsWith("audio:decode-"));
    assert.deepEqual(compile(`await audio.audioContext.decodeAudioData(await response.arrayBuffer());`), ["audio:decode-wav"]);
    assert.deepEqual(compile(`
        const bytes = await response.arrayBuffer();
        const alias = new Uint8Array(bytes);
        alias[0] = 0;
        await audio.audioContext.decodeAudioData(bytes);
    `), AUDIO_CODECS.map(codec => `audio:decode-${codec}`));
    assert.deepEqual(compile(`
        async function arrayBuffer() { const bytes = await response.arrayBuffer(); const view = new Uint8Array(bytes); view[0] = 0; return bytes; }
        await audio.audioContext.decodeAudioData(await arrayBuffer());
    `), AUDIO_CODECS.map(codec => `audio:decode-${codec}`));
});

function writeWave(output: string): string {
    const bytes = Buffer.alloc(44 + 1024 * 4);
    bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
    bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(44100 * 4, 28);
    bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
    bytes.writeUInt32LE(bytes.length - 44, 40);
    for (let index = 0; index < 2048; index++) bytes.writeInt16LE((index * 997) % 60000 - 30000, 44 + index * 2);
    const wave = resolve(output, "tone.wav");
    writeFileSync(wave, bytes);
    return wave;
}

test("WAVE and Vorbis byte decoding match file PCM and read current ArrayBuffer contents", {
    skip: !tools || !existsSync(resolve(labSound, "lib/LabSound.lib")),
}, () => {
    const output = resolve("artifacts/audio-decode-check");
    mkdirSync(output, { recursive: true });
    const source = resolve(output, "check.cpp"), executable = resolve(output, "check.exe");
    const wave = writeWave(output);
    const decode = cppFunction(readFileSync("native/src/pal_audio_labsound.cpp", "utf8"), "AudioBufferHandle audio_decode_buffer(");
    writeFileSync(source, `
        #define BBLITE_HAS_AUDIO_BUFFER_SOURCE 1
        #define BBLITE_HAS_AUDIO_DECODE_FILE 1
        #define BBLITE_AUDIO_DECODE_WAV 1
        #define BBLITE_AUDIO_DECODE_OGG 1
        #include <bblite/pal_audio.hpp>
        #include "pal_audio_decode.hpp"
        #include <LabSound/extended/AudioFileReader.h>
        #include <cassert>
        #include <fstream>
        #include <iterator>
        #include <memory>
        namespace bbl::pal {
        struct ContextRecord { double sample_rate = 44100; } fixture_context;
        struct BufferRecord { std::vector<std::vector<float>> channels; } fixture_buffer;
        ContextRecord& require_context(std::uint32_t) { return fixture_context; }
        AudioBufferHandle allocate_audio_buffer(AudioContextHandle, std::uint32_t channels, std::uint32_t frames, double) {
            fixture_buffer.channels.assign(channels, std::vector<float>(frames)); return {1};
        }
        BufferRecord* require_buffer(AudioBufferHandle) { return &fixture_buffer; }
        ${decode}
        }
        int main(int argc, char** argv) {
            assert(argc == 3);
            for (int file = 1; file < argc; ++file) {
            std::ifstream input(argv[file], std::ios::binary);
            bbl::js::ArrayBuffer encoded(std::vector<std::uint8_t>{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()});
            for (double rate : {44100.0, 48000.0}) {
                bbl::pal::fixture_context.sample_rate = rate;
                const auto reference = lab::MakeBusFromFile(argv[file], false, static_cast<float>(rate));
                assert(reference);
                assert(bbl::pal::audio_decode_buffer({1}, encoded).value == 1);
                assert(bbl::pal::fixture_buffer.channels.size() == static_cast<std::size_t>(reference->numberOfChannels()));
                for (std::size_t channel = 0; channel < bbl::pal::fixture_buffer.channels.size(); ++channel) {
                    const auto& samples = bbl::pal::fixture_buffer.channels[channel];
                    assert(samples.size() == reference->length());
                    assert(std::equal(samples.begin(), samples.end(), reference->channel(static_cast<int>(channel))->data()));
                }
            }
            auto alias = encoded;
            alias.data()[0] = 0;
            assert(bbl::pal::audio_decode_buffer({1}, encoded).value == 0);
            }
            for (std::size_t size = 0; size < 12; ++size) {
                bbl::js::ArrayBuffer short_input(std::vector<std::uint8_t>(size, 0));
                assert(bbl::pal::audio_decode_buffer({1}, short_input).value == 0);
            }
        }
    `);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/MD", "/EHsc", "/W4", "/WX", "/permissive-",
        "/external:W0", `/external:I${resolve(labSound, "include")}`,
        `/I${resolve("native/include")}`, `/I${resolve("native/src")}`, `/Fo:${output}\\`, `/Fe:${executable}`, source,
        "/link", resolve(labSound, "lib/LabSound.lib"), resolve(labSound, "lib/libnyquist.lib")]);
    assert.doesNotThrow(() => execFileSync(executable, [wave, resolve("corpus/babylon-lite/lab/lite/src/demos/racer/audio/skid.ogg")], { stdio: "pipe" }));
});

test("a WAVE-only native decoder omits other decoder entry points and registries", {
    skip: !tools || !existsSync(resolve(labSound, "lib/LabSound.lib")),
}, () => {
    const output = resolve("artifacts/audio-decode-check");
    mkdirSync(output, { recursive: true });
    const source = resolve(output, "wave-only.cpp"), executable = resolve(output, "wave-only.exe");
    const map = resolve(output, "wave-only.map");
    const wave = writeWave(output);
    writeFileSync(source, `
        #define BBLITE_AUDIO_DECODE_WAV 1
        #include "pal_audio_decode.hpp"
        #include <cassert>
        #include <fstream>
        #include <iterator>
        int main(int argc, char** argv) {
            assert(argc == 2);
            std::ifstream input(argv[1], std::ios::binary);
            const std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
            const auto decoded = bbl::pal::decode_audio_bus(bytes, bbl::pal::audio_container_extension(bytes));
            assert(decoded && decoded->length() == 1024 && decoded->numberOfChannels() == 2);
        }
    `);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/MD", "/EHsc", "/O2", "/Gy", "/W4", "/WX", "/permissive-",
        "/external:W0", `/external:I${resolve(labSound, "include")}`, `/I${resolve("native/src")}`,
        `/Fo:${output}\\`, `/Fe:${executable}`, source, "/link", "/INCREMENTAL:NO", "/OPT:REF", "/OPT:ICF", `/MAP:${map}`,
        resolve(labSound, "lib/LabSound.lib"), resolve(labSound, "lib/libnyquist.lib")]);
    assert.doesNotThrow(() => execFileSync(executable, [wave], { stdio: "pipe" }));
    const symbols = readFileSync(map, "utf8");
    assert.match(symbols, /LoadFromBuffer@WavDecoder/);
    assert.doesNotMatch(symbols, /(?:LoadFrom(?:Buffer|Path)@|\?\?_7)(?:Flac|Mp3|Vorbis|Opus|Musepack|WavPack)Decoder|BuildDecoderTable|MakeBusFromFile/);
});
