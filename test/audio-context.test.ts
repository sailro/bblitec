import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("direct audio contexts preserve owned aliases and lifecycle promises", (t) => {
    const output = resolve("artifacts/audio-context-check");
    mkdirSync(output, { recursive: true });
    const wave = Buffer.alloc(44 + 1024 * 2);
    wave.write("RIFF");
    wave.writeUInt32LE(wave.length - 8, 4);
    wave.write("WAVEfmt ", 8);
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20);
    wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(48000, 24);
    wave.writeUInt32LE(96000, 28);
    wave.writeUInt16LE(2, 32);
    wave.writeUInt16LE(16, 34);
    wave.write("data", 36);
    wave.writeUInt32LE(wave.length - 44, 40);
    for (let frame = 0; frame < 1024; frame++)
        wave.writeInt16LE(8192, 44 + frame * 2);
    writeFileSync(join(output, "tone.wav"), wave);
    const result = compileSource(
        `
        function create(): {context: AudioContext} { return {context: new AudioContext()}; }
        function equal(actual:Float32Array,expected:number[]):boolean {
            if(actual.length!==expected.length)return false;
            for(let index=0;index<expected.length;index++)if(actual[index]!==expected[index])return false;
            return true;
        }
        async function exercise(): Promise<void> {
            const owner = create();
            const context = owner.context;
            const aliases: AudioContext[] = [context];
            if (aliases[0] !== context) throw new Error("context identity");
            const rate = context.sampleRate;
            if (rate <= 0) throw new Error("sample rate");
            const pcm=context.createBuffer(2,8,16000);
            if(pcm.length!==8||pcm.numberOfChannels!==2||pcm.sampleRate!==16000||pcm.duration!==0.0005)
                throw new Error("buffer metadata");
            const source=context.createBufferSource();
            if(source.buffer!==null) throw new Error("initial source buffer");
            source.buffer=pcm;
            const sourceAlias=source;
            if(sourceAlias.buffer!==pcm) throw new Error("source buffer identity");
            let sourceReads=0;
            function receiver():AudioBufferSourceNode{sourceReads++;return source;}
            receiver().buffer=pcm;
            if(sourceReads!==1)throw new Error("buffer setter receiver evaluation");
            pcm.copyToChannel(new Float32Array([1,2,3]),1,6);
            const tail=new Float32Array([9,9,9,9]);
            pcm.copyFromChannel(tail,1,6);
            if(!equal(tail,[1,2,9,9])) throw new Error("bounded channel copy");
            pcm.copyFromChannel(tail,1,8);
            pcm.copyFromChannel(tail,1,-1);
            if(!equal(tail,[1,2,9,9])) throw new Error("out of range offset");
            let invalidChannel=false;
            try{pcm.copyToChannel(tail,2);}catch{invalidChannel=true;}
            if(!invalidChannel) throw new Error("channel validation");
            const channel=pcm.getChannelData(0);
            channel.set([0,1,2,3,4,5,6,7]);
            pcm.copyToChannel(channel.subarray(0,4),0,2);
            if(!equal(channel,[0,1,0,1,2,3,6,7])) throw new Error("overlapping channel write");
            pcm.copyFromChannel(channel.subarray(1,5),0);
            if(!equal(channel,[0,0,1,0,1,3,6,7])) throw new Error("overlapping channel read");
            const storage=new ArrayBuffer(24);
            const view=new Float32Array(storage,4,4);
            pcm.copyFromChannel(view,0,4);
            if(!equal(view,[1,3,6,7])) throw new Error("ArrayBuffer destination view");
            pcm.copyToChannel(view,1,2);
            if(!equal(pcm.getChannelData(1),[0,0,1,3,6,7,1,2])) throw new Error("ArrayBuffer source view");
            const gain = context.createGain();
            gain.connect(context.destination);
            if (typeof context.createGain !== "function") throw new Error("factory capability");
            if (typeof context.setSinkId !== "undefined") throw new Error("sink capability");
            let inspected = 0;
            function inspect(): AudioContext { inspected++; return context; }
            if (typeof inspect().createMediaStreamDestination === "function") throw new Error("recording capability");
            if (inspected !== 1) throw new Error("capability receiver evaluation");
            async function load(frames:number):Promise<AudioBuffer> {
                await Promise.resolve();
                return context.createBuffer(1,frames,rate);
            }
            let first:AudioBuffer|null=null;
            const destination:{buffer:AudioBuffer|null}={buffer:null};
            [first,destination.buffer]=await Promise.all([load(4),load(8)]);
            if(!first||!destination.buffer||first.getChannelData(0).length!==4||destination.buffer.getChannelData(0).length!==8)
                throw new Error("owned buffer aggregation");
            async function decode():Promise<AudioBuffer|null>{
                const encoded=await fetch("tone.wav").then(response=>response.arrayBuffer());
                return context.decodeAudioData(encoded);
            }
            [first,destination.buffer]=await Promise.all([decode(),decode()]);
            if(!first||!destination.buffer) throw new Error("fetched audio decode");
            const samples=first.getChannelData(0);
            if(first.sampleRate!==rate||first.numberOfChannels!==1||first.length!==samples.length||first.duration!==first.length/rate)
                throw new Error("decoded buffer metadata");
            if(samples.length<900||samples.length>1100||Math.abs(samples[100]-0.25)>0.001)
                throw new Error("fetched audio PCM");
            const decoded = new Map<string, AudioBuffer>();
            let requests = 0;
            async function cachedBuffer(): Promise<AudioBuffer> {
                let buffer = decoded.get("tone");
                if (!buffer) {
                    requests++;
                    buffer = await context.decodeAudioData(await fetch("tone.wav").then(response=>response.arrayBuffer()));
                    decoded.set("tone", buffer);
                }
                return buffer;
            }
            first = await cachedBuffer();
            const cached = await cachedBuffer();
            if (requests !== 1 || first !== cached || decoded.get("tone") !== cached || Math.abs(first.getChannelData(0)[100]-0.25)>0.001)
                throw new Error("awaited nullable buffer cache");
            async function maybeCached(key:string): Promise<AudioBuffer|undefined> {
                await Promise.resolve();
                return decoded.get(key);
            }
            if(await maybeCached("missing")!==undefined || await maybeCached("tone")!==cached)
                throw new Error("optional buffer promise result");
            const missingReaction = await Promise.resolve().then(()=>decoded.get("missing"));
            const presentReaction = await Promise.resolve().then(()=>decoded.get("tone"));
            const adopted = await Promise.resolve(decoded.get("tone"));
            if(missingReaction!==undefined || presentReaction!==cached || adopted!==cached)
                throw new Error("optional buffer adoption and reaction");
            const mapSnapshot = Promise.resolve(decoded.get("tone"));
            decoded.clear();
            if(await mapSnapshot!==cached) throw new Error("borrowed map result snapshot");
            decoded.set("tone",cached);
            async function delayed(buffer:AudioBuffer|null):Promise<AudioBuffer|null> {
                await Promise.resolve();
                return buffer;
            }
            const heldArgument=delayed(first);
            first=null;
            const emptyArgument=delayed(first);
            first=cached;
            if(await heldArgument!==cached || await emptyArgument!==null)
                throw new Error("nullable argument snapshots");
            async function localBuffer(present:boolean):Promise<AudioBuffer|null> {
                let buffer:AudioBuffer|null=null;
                if(present) buffer=cached;
                await Promise.resolve();
                return buffer;
            }
            if(await localBuffer(true)!==cached || await localBuffer(false)!==null)
                throw new Error("nullable local result");
            async function pair(present:boolean):Promise<readonly [AudioBuffer|null,number]> {
                let buffer:AudioBuffer|null=null;
                if(present) buffer=cached;
                await Promise.resolve();
                return [buffer,7] as const;
            }
            const [presentPair,presentTag]=await pair(true);
            const [emptyPair,emptyTag]=await pair(false);
            if(presentPair!==cached || emptyPair!==null || presentTag!==7 || emptyTag!==7)
                throw new Error("nullable tuple payloads");
            async function aggregate(present:boolean):Promise<[AudioBuffer|null,number]> {
                let buffer:AudioBuffer|null=null;
                if(present) buffer=cached;
                const pending=Promise.all([buffer,11]);
                buffer=null;
                return pending;
            }
            const [presentAggregate,presentNumber]=await aggregate(true);
            const [emptyAggregate,emptyNumber]=await aggregate(false);
            if(presentAggregate!==cached || emptyAggregate!==null || presentNumber!==11 || emptyNumber!==11)
                throw new Error("nullable aggregate snapshots");
            async function projected(present:boolean):Promise<AudioBuffer|null> {
                return Promise.resolve().then(()=>{
                    let buffer:AudioBuffer|null=null;
                    if(present) buffer=cached;
                    return buffer;
                });
            }
            if(await projected(true)!==cached || await projected(false)!==null)
                throw new Error("nullable reaction payloads");
            let invalid=false;
            try{first=await context.decodeAudioData(new ArrayBuffer(0));}catch{invalid=true;}
            if(!invalid || first!==cached) throw new Error("rejected assignment must retain its previous buffer");
            first = null;
            if(first!==null) throw new Error("nullable buffer reset");
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
            if(pcm.duration!==0.0005) throw new Error("closed context buffer metadata");
            const retained=new Float32Array(2);
            pcm.copyFromChannel(retained,1,6);
            if(!equal(retained,[1,2])||pcm.getChannelData(0)!==channel)throw new Error("closed context buffer data");
            const closedTime = context.currentTime;
            let rejected = 0;
            await context.close().catch(() => { rejected++; });
            await context.resume().catch(() => { rejected++; });
            await context.suspend().catch(() => { rejected++; });
            if (rejected !== 3 || context.currentTime !== closedTime) throw new Error("closed transitions");
            globalThis.close();
        }
        void exercise();
    `,
        { fileName: join(output, "entry.ts") },
    );
    for (const asset of result.manifest.assets) {
        const destination = join(output, asset.output);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(resolve(output, asset.source), destination);
    }
    writeFileSync(join(output, "program.hpp"), result.cpp);
    const tools = optionalNativeFixtureTools();
    const labsound = resolve("artifacts/tools/labsound");
    if (!tools || !existsSync(join(labsound, "lib/LabSound.lib"))) {
        t.skip("The native compiler and pinned LabSound library are required.");
        return;
    }
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        "/DBBLITE_HAS_AUDIO_BUFFER_SOURCE=1",
        "/DBBLITE_HAS_AUDIO_DECODE_FILE=1",
        "/DBBLITE_AUDIO_DECODE_WAV=1",
        "/O2",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/src",
        `/external:I${join(labsound, "include")}`,
        "test/fixtures/audio-context-check.cpp",
        "test/fixtures/packaged-fetch-check.cpp",
        "/link",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        `/LIBPATH:${join(labsound, "lib")}`,
        "LabSound.lib",
        "libnyquist.lib",
        "SDL3.lib",
    ]);
    assert.equal(
        execFileSync(executable, {
            cwd: output,
            encoding: "utf8",
            timeout: 30000,
            env: {
                ...tools.environment,
                SDL_AUDIODRIVER: "dummy",
                BBLITE_AUDIO_CAPTURE: "",
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools.environment.PATH ?? ""}`,
            },
        }),
        "",
    );
});

test("audio capability guards and constructor boundaries", () => {
    const guarded = compileSource(`
        const prototype = typeof AudioContext === "undefined" ? null : AudioContext.prototype;
        if (typeof AudioContext !== "function") throw new Error("constructor capability");
        if (typeof prototype?.setSinkId === "function") throw new Error("unavailable sink");
        if (typeof prototype?.createMediaStreamDestination === "function") throw new Error("unavailable recording");
    `);
    assert.doesNotMatch(
        guarded.cpp,
        /throw std::runtime_error\("unavailable sink"\)/,
    );
    assert.doesNotMatch(
        guarded.cpp,
        /throw std::runtime_error\("(?:constructor capability|unavailable recording)"\)/,
    );
    assert.throws(
        () =>
            compileSource(
                "const context = new AudioContext(); context.createMediaStreamDestination();",
            ),
        /native recording streams are unavailable/,
    );
    assert.throws(
        () =>
            compileSource(
                "const context = new AudioContext({sampleRate: 44100});",
            ),
        /constructor options/,
    );
    const lifecycle = compileSource(
        "const context = new AudioContext(); context.resume();",
    );
    assert.match(lifecycle.cpp, /bbl::pal::EventLoop loop/);
    assert.match(lifecycle.cpp, /audio_context_transition/);
    const listener = compileSource(
        'const source=new AudioContext().createBufferSource();source.addEventListener("ended",()=>{});',
    );
    assert.match(listener.cpp, /bbl::pal::EventLoop loop/);
    const shadowed = compileSource(
        "class AudioContext { value = 7; } const context = new AudioContext(); if (context.value !== 7) throw new Error('local');",
    );
    assert.doesNotMatch(shadowed.cpp, /audio_create_context/);
});
