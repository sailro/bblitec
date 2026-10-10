import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const deferredCapabilities = "runtime-throw" as const;

test("audio option capabilities retain strict refusals and supported defaults", () => {
    const imports = 'import {createAudioEngineAsync} from "@babylonjs/lite";';
    assert.throws(
        () =>
            compileSource(
                `${imports}void createAudioEngineAsync({volume:0.5});`,
            ),
        /options are not lowered/,
    );
    for (const options of ["", "undefined"]) {
        const source = `${imports}void createAudioEngineAsync(${options});`;
        const ordinary = compileSource(source);
        const deferred = compileSource(source, { deferredCapabilities });
        assert.equal(deferred.manifest.deferredCapabilities, undefined);
        if (options === "") assert.equal(deferred.cpp, ordinary.cpp);
        else assert.match(deferred.cpp, /audio_create_context/);
    }
    assert.throws(
        () =>
            compileSource(
                `${imports}createAudioEngineAsync({volume:1}).then(()=>{new FinalizationRegistry(() => {});});`,
                { deferredCapabilities },
            ),
        /Unsupported constructor/,
    );
    const authored = compileSource(
        `${imports}const own:typeof createAudioEngineAsync=async()=>{throw new Error("authored");}; own({volume:1}).then(()=>{}).catch(()=>globalThis.close());`,
        { deferredCapabilities },
    );
    assert.equal(authored.manifest.deferredCapabilities, undefined);
});

test("audio options evaluate once and only present options reject asynchronously", () => {
    const result = compileSource(
        `
        import {createAudioEngineAsync,createSoundSourceAsync,type AudioEngineOptions,type SoundSourceOptions} from "@babylonjs/lite";
        async function run():Promise<void>{
            let argumentsRun=0;let getterRuns=0;let accepted=0;let rejected=0;let synchronous=true;
            function options():AudioEngineOptions {++argumentsRun;return {volume:0.5};}
            const pending=createAudioEngineAsync(options()).then(()=>{}).catch(error=>{
                if(synchronous||!error.message.includes("babylon:createAudioEngineAsync.options"))throw new Error("timing or identity");
                ++rejected;
            });
            synchronous=false;
            await pending;
            const accessorOptions={get volume():number {++getterRuns;return 0.5;}};
            try{await createAudioEngineAsync(accessorOptions);}catch(error){
                if(!error.message.includes("babylon:createAudioEngineAsync.options"))throw error;
                ++rejected;
            }
            const choices:Array<AudioEngineOptions|undefined>=[undefined,{volume:0.5}];
            for(let i=0;i<choices.length;i++) {
                try {
                    const engine=await createAudioEngineAsync(choices[i]);
                    ++accepted;
                    const sourceOptions:Array<SoundSourceOptions|undefined>=[undefined,{volume:0.5}];
                    for(let j=0;j<sourceOptions.length;j++) {
                        try {
                            await createSoundSourceAsync(engine,engine.audioContext.createGain(),sourceOptions[j]);
                            ++accepted;
                        }catch(error){
                            if(!error.message.includes("babylon:createSoundSourceAsync.options"))throw error;
                            ++rejected;
                        }
                    }
                } catch(error) {
                    if(!error.message.includes("babylon:createAudioEngineAsync.options"))throw error;
                    ++rejected;
                }
            }
            if(argumentsRun!==1||getterRuns!==0||accepted!==2||rejected!==4)throw new Error("option branches");
            globalThis.close();
        }
        run();
    `,
        { deferredCapabilities },
    );
    assert.deepEqual(
        result.manifest.deferredCapabilities?.map((site) => site.id),
        [
            "babylon:createAudioEngineAsync.options",
            "babylon:createAudioEngineAsync.options",
            "babylon:createAudioEngineAsync.options",
            "babylon:createSoundSourceAsync.options",
        ],
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "deferred-audio-options/branches",
        result.cpp +
            `
        namespace bbl::pal {
            AudioSession::~AudioSession() = default;
            bool audio_begin_context() { return true; }
            std::shared_ptr<AudioPlaybackDevice> audio_open_device(bool) { return {}; }
            AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>&,std::shared_ptr<AudioPlaybackDevice>) { return {1}; }
            AudioNodeHandle audio_create_gain(AudioContextHandle) { return {2,{}}; }
            AudioNodeHandle audio_destination(AudioContextHandle) { return {3,{}}; }
            void audio_connect(AudioNodeHandle,AudioNodeHandle) {}
        }
    `,
        { flags: ["/DBBLITE_WORKERS=1"], timeoutMs: 10000 },
    );
});

test("missing audio graph operations retain declared results and later authored bodies", () => {
    const result = compileSource(
        `
        import {createAudioEngineAsync,createSoundAsync,createSoundBufferAsync,createStreamingSoundAsync,createAudioBusAsync,createMicrophoneSoundSourceAsync,createAudioEngineMediaStream,enableSpatial,enableStereo,enableAnalyzer,setMasterVolume,getMasterVolume} from "@babylonjs/lite";
        async function run(){
            try {
                const engine=await createAudioEngineAsync({volume:0.5});
                const sound=await createSoundAsync(engine,"sound.wav",{volume:0.5});
                await createSoundBufferAsync(engine,"sound.wav");
                await createStreamingSoundAsync(engine,"sound.wav");
                await createAudioBusAsync(engine,"bus");
                await createMicrophoneSoundSourceAsync(engine);
                createAudioEngineMediaStream(engine);
                enableSpatial(sound,{minDistance:2});
                enableStereo(sound,{pan:0.5});
                enableAnalyzer(sound);
                setMasterVolume(engine,0.5);
                getMasterVolume(engine);
            }catch(error){if(!error.message.includes("babylon:createAudioEngineAsync.options"))throw error;}
            globalThis.close();
        }
        run();
    `,
        { deferredCapabilities },
    );
    assert.equal(result.manifest.deferredCapabilities?.length, 12);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "deferred-audio-options/family", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 10000,
    });
});
