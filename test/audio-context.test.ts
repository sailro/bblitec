import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("direct audio contexts preserve owned aliases and lifecycle promises", t => {
    const output = resolve("artifacts/audio-context-check");
    mkdirSync(output, {recursive:true});
    writeFileSync(join(output, "worker.ts"), "self.close();");
    const result = compileSource(`
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        function create(): {context: AudioContext} { return {context: new AudioContext()}; }
        async function exercise(): Promise<void> {
            const owner = create();
            const context = owner.context;
            const aliases: AudioContext[] = [context];
            if (aliases[0] !== context) throw new Error("context identity");
            const rate = context.sampleRate;
            if (rate <= 0) throw new Error("sample rate");
            const gain = context.createGain();
            gain.connect(context.destination);
            if (typeof context.createGain !== "function") throw new Error("factory capability");
            if (typeof context.setSinkId !== "undefined") throw new Error("sink capability");
            let order = "";
            const resumed = context.resume().then(() => { order += "r"; });
            order += "s";
            if (order !== "s") throw new Error("synchronous promise reaction");
            await resumed;
            if (order !== "sr") throw new Error("resume reaction");
            await context.suspend();
            if (context.state !== "suspended") throw new Error("suspend state");
            const stopped = context.currentTime;
            await Promise.resolve();
            if (context.currentTime !== stopped) throw new Error("suspended clock");
            await context.resume();
            if (context.state !== "running") throw new Error("resume state");
            await context.close();
            if (aliases[0]!.state !== "closed") throw new Error("closed alias");
            if (context.sampleRate !== rate) throw new Error("closed sample rate");
            const closedTime = context.currentTime;
            let rejected = 0;
            await context.close().catch(() => { rejected++; });
            await context.resume().catch(() => { rejected++; });
            await context.suspend().catch(() => { rejected++; });
            if (rejected !== 3 || context.currentTime !== closedTime) throw new Error("closed transitions");
            globalThis.close();
        }
        void exercise();
    `, {fileName:join(output, "entry.ts")});
    writeFileSync(join(output, "program.hpp"), result.cpp);
    const tools = optionalNativeFixtureTools();
    const labsound = resolve("artifacts/tools/labsound");
    if (!tools || !existsSync(join(labsound, "lib/LabSound.lib"))) {
        t.skip("The native compiler and pinned LabSound library are required."); return;
    }
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include",
        `/external:I${join(nativeFixtureVcpkgRoot,"include")}`, `/external:I${join(labsound,"include")}`, "/external:W0",
        "test/fixtures/audio-context-check.cpp", "/link", "/OPT:REF",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot,"lib")}`, `/LIBPATH:${join(labsound,"lib")}`,
        "LabSound.lib", "libnyquist.lib", "SDL3.lib"]);
    assert.equal(execFileSync(executable, {encoding:"utf8", timeout:30000,
        env:{...tools.environment, SDL_AUDIODRIVER:"dummy", BBLITE_AUDIO_CAPTURE:"",
            PATH:`${join(nativeFixtureVcpkgRoot,"bin")};${tools.environment.PATH ?? ""}`}}), "");
});

test("audio capability guards and constructor boundaries", () => {
    const guarded = compileSource(`
        const prototype = typeof AudioContext === "undefined" ? null : AudioContext.prototype;
        if (typeof prototype?.setSinkId === "function") throw new Error("unavailable sink");
    `);
    assert.doesNotMatch(guarded.cpp, /throw std::runtime_error\("unavailable sink"\)/);
    assert.throws(() => compileSource("const context = new AudioContext({sampleRate: 44100});"), /constructor options/);
    assert.throws(() => compileSource("const context = new AudioContext(); context.resume();"), /asynchronous application realm/);
    const shadowed = compileSource("class AudioContext { value = 7; } const context = new AudioContext(); if (context.value !== 7) throw new Error('local');");
    assert.doesNotMatch(shadowed.cpp, /audio_create_context/);
});
