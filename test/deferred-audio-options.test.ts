import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import {
    audioLibraryInclude,
    ENGINE_PARAMETER_STUBS,
} from "./static-sound-fixture.js";

const deferredCapabilities = "runtime-throw" as const;

test("audio option capabilities retain strict refusals and supported defaults", () => {
    const imports = 'import {createAudioEngineAsync} from "@babylonjs/lite";';
    assert.throws(
        () =>
            compileSource(
                `${imports}void createAudioEngineAsync({resumeOnPause:false});`,
            ),
        /Audio engine option 'resumeOnPause' is not lowered/,
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
                `${imports}void createAudioEngineAsync({resumeOnPause:false});`,
                {
                    deferredCapabilities,
                },
            ),
        /Audio engine option 'resumeOnPause' is not lowered/,
    );
    assert.throws(
        () =>
            compileSource(
                `${imports}createAudioEngineAsync({audioContext:new AudioContext()}).then(()=>{new FinalizationRegistry(() => {});});`,
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

test("audio engine options adopt a context and refuse other present members once", () => {
    const result = compileSource(
        `
        import {createAudioEngineAsync,createSoundSourceAsync,type AudioEngineOptions,type SoundSourceOptions} from "@babylonjs/lite";
        async function run():Promise<void>{
            let argumentsRun=0;let accepted=0;let rejected=0;let synchronous=true;
            function options():AudioEngineOptions {++argumentsRun;return {volume:0.5,resumeOnInteraction:false};}
            const pending=createAudioEngineAsync(options()).then(()=>{}).catch(error=>{
                if(synchronous||!error.message.includes("option 'resumeOnInteraction' is not lowered"))throw new Error("timing or identity");
                ++rejected;
            });
            synchronous=false;
            await pending;
            const context=new AudioContext();
            const adopted=await createAudioEngineAsync({audioContext:context});
            if(adopted.audioContext!==context)throw new Error("adopted context");
            const choices:Array<AudioEngineOptions|undefined>=[undefined,{audioContext:context},{audioContext:context,resumeOnPause:false}];
            for(let i=0;i<choices.length;i++) {
                try {
                    const engine=await createAudioEngineAsync(choices[i]);
                    if((i===1)!==(engine.audioContext===context))throw new Error("selected context");
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
                    if(!error.message.includes("option 'resumeOnPause' is not lowered"))throw error;
                    ++rejected;
                }
            }
            if(argumentsRun!==1||accepted!==4||rejected!==4)throw new Error("option branches");
            globalThis.close();
        }
        run();
    `,
        { deferredCapabilities },
    );
    assert.deepEqual(
        result.manifest.deferredCapabilities?.map((site) => site.id),
        ["babylon:createSoundSourceAsync.options"],
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "deferred-audio-options/branches",
        result.cpp +
            ENGINE_PARAMETER_STUBS +
            `
        namespace bbl::pal {
            AudioSession::~AudioSession() = default;
            bool audio_begin_context() { return true; }
            std::shared_ptr<AudioPlaybackDevice> audio_open_device(bool) { return {}; }
            static std::uint32_t contexts = 0, nodes = 0;
            AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>&,std::shared_ptr<AudioPlaybackDevice>) { return {++contexts}; }
            AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>&) { return {++contexts}; }
            AudioNodeHandle audio_create_gain(AudioContextHandle) { return {++nodes,{}}; }
            AudioNodeHandle audio_destination(AudioContextHandle context) { return {1000 + context.value,{}}; }
            void audio_connect(AudioNodeHandle,AudioNodeHandle) {}
            void audio_disconnect(AudioNodeHandle) {}
        }
    `,
        {
            flags: [
                "/DBBLITE_WORKERS=1",
                ...audioLibraryInclude(
                    "deferred-audio-options/branches",
                    result.manifest,
                ),
            ],
            timeoutMs: 10000,
        },
    );
});

test("missing audio graph operations retain declared results and later authored bodies", () => {
    const result = compileSource(
        `
        import {createAudioEngineAsync,createSoundBufferAsync,createStreamingSoundAsync,createMicrophoneSoundSourceAsync,enableStereo,enableAnalyzer,type StaticSound} from "@babylonjs/lite";
        async function run(){
            try {
                const engine=await createAudioEngineAsync();
                const sounds=new Map<number,StaticSound>();
                await createSoundBufferAsync(engine,"sound.wav");
                await createStreamingSoundAsync(engine,"sound.wav");
                await createMicrophoneSoundSourceAsync(engine);
                for(const sound of sounds.values()){
                    enableStereo(sound,{pan:0.5});
                    enableAnalyzer(sound);
                }
            }catch(error){if(!error.message.includes("babylon:createSoundBufferAsync"))throw error;}
            globalThis.close();
        }
        run();
    `,
        { deferredCapabilities },
    );
    assert.equal(result.manifest.deferredCapabilities?.length, 5);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "deferred-audio-options/family",
        result.cpp +
            ENGINE_PARAMETER_STUBS +
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
        {
            flags: [
                "/DBBLITE_WORKERS=1",
                ...audioLibraryInclude(
                    "deferred-audio-options/family",
                    result.manifest,
                ),
            ],
            timeoutMs: 10000,
        },
    );
});
