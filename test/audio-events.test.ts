import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("scheduled audio events retain callbacks through playback and release their realm", (t) => {
    const output = resolve("artifacts/audio-events-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "worker.ts"), "self.close();");
    const prefix =
        'const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();';
    const result = compileSource(
        prefix +
            `
        const context=new AudioContext();
        const buffer=context.createBuffer(1,480,48000);
        let natural=0,stopped=0,order=0,closed=0,unconnected=0,asynchronous=0,propertyOrder=0;
        const voices = new Set<AudioBufferSourceNode>();
        function playPropertyVoice() {
            const source = context.createBufferSource(); source.buffer = buffer;
            voices.add(source);
            source.onended = () => {throw new Error("cleared property handler");};
            source.onended = null;
            source.addEventListener("ended", () => {propertyOrder = 1;});
            source.onended = () => {throw new Error("replaced property handler");};
            source.addEventListener("ended", () => {if(propertyOrder !== 2)throw new Error("property position");propertyOrder = 3;});
            const handler = () => {
                if(propertyOrder !== 1)throw new Error("property ordering");
                propertyOrder = 2; voices.delete(source); source.disconnect();
                source.onended = null;
            };
            source.onended = handler;
            source.removeEventListener("ended", handler);
            source.start();
        }
        playPropertyVoice();
        function play(){
            const voice=context.createBufferSource();voice.buffer=buffer;voice.connect(context.destination);
            const alias=voice;
            const removed=()=>{throw new Error("removed listener");};
            const later=()=>{throw new Error("removed during dispatch");};
            const handler=()=>{if(order!==1)throw new Error("capture order");order=2;natural++;alias.disconnect();alias.removeEventListener("ended",later);};
            alias.addEventListener("ended",removed);voice.removeEventListener("ended",removed);
            voice.addEventListener("ended",handler,{once:true});voice.addEventListener("ended",handler);
            voice.addEventListener("ended",()=>{order=1;},true);voice.addEventListener("ended",later);
            voice.start();
        }
        play();
        const oscillator=context.createOscillator();oscillator.connect(context.destination);
        oscillator.start();oscillator.addEventListener("ended",()=>{stopped++;oscillator.disconnect();});
        oscillator.stop(context.currentTime+0.04);
        const silent=context.createBufferSource();silent.buffer=buffer;
        silent.addEventListener("ended",()=>{unconnected++;});
        silent.addEventListener("ended",async()=>{await Promise.resolve();asynchronous++;});silent.start();
        const doomed=new AudioContext();const pending=doomed.createBufferSource();
        pending.buffer=buffer;pending.connect(doomed.destination);
        pending.addEventListener("ended",()=>{throw new Error("closed context listener");});pending.start(doomed.currentTime+1);
        void doomed.close();
        const cleanup=new AudioContext();const finalVoice=cleanup.createBufferSource();
        finalVoice.buffer=buffer;finalVoice.connect(cleanup.destination);
        finalVoice.addEventListener("ended",()=>{closed++;void cleanup.close();});finalVoice.start();
        setTimeout(()=>{
            if(natural!==1||stopped!==1||closed!==1||order!==2||unconnected!==1||asynchronous!==1||propertyOrder!==3||voices.size!==0)throw new Error("completion counts");
            globalThis.close();
        },400);
    `,
        { fileName: join(output, "entry.ts") },
    );
    assert.throws(
        () =>
            compileSource(
                prefix +
                    'const source=new AudioContext().createBufferSource();source.addEventListener("ended",event=>console.log(event.type));',
                { fileName: join(output, "unsupported.ts") },
            ),
        /Audio ended event payloads are not represented/,
    );
    assert.throws(
        () =>
            compileSource(
                prefix +
                    'const source=new AudioContext().createBufferSource();source.addEventListener("other",()=>{});',
                { fileName: join(output, "unsupported.ts") },
            ),
        /Only scheduled audio source ended/,
    );
    writeFileSync(join(output, "program.hpp"), result.cpp);
    const tools = optionalNativeFixtureTools(),
        labsound = resolve("artifacts/tools/labsound");
    if (!tools || !existsSync(join(labsound, "lib/LabSound.lib"))) {
        t.skip("Native compiler and pinned LabSound required.");
        return;
    }
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        "/DBBLITE_HAS_AUDIO_BUFFER_SOURCE=1",
        "/DBBLITE_HAS_AUDIO_OSCILLATOR=1",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/O2",
        "/Gy",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/src",
        "/I",
        "native/include",
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`,
        `/external:I${join(labsound, "include")}`,
        "/external:W0",
        "test/fixtures/audio-events-check.cpp",
        "/link",
        "/OPT:REF",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        `/LIBPATH:${join(labsound, "lib")}`,
        "LabSound.lib",
        "libnyquist.lib",
        "SDL3.lib",
    ]);
    const execution = spawnSync(executable, {
        encoding: "utf8",
        timeout: 10000,
        env: {
            ...tools.environment,
            SDL_AUDIODRIVER: "dummy",
            BBLITE_AUDIO_CAPTURE: "",
            PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools.environment.PATH ?? ""}`,
        },
    });
    assert.ifError(execution.error);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "");
    assert.equal(execution.stderr, "");
});
