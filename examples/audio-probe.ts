// Web Audio prototype probe.
//
// The reached slice, end to end: the Lite audio engine's lifecycle
// (`createAudioEngineAsync` / `createSoundSourceAsync` /
// `unlockAudioEngineAsync`) around a graph the scene builds itself on
// `engine.audioContext` -- which is exactly what every upstream demo that
// uses audio does. No `sceneNNN` corpus scene reaches audio at all, so
// this stands in for them.
//
// It also renders something, because a bblitec scene has to: the box's
// colour tracks the chord so the picture says whether the audio path was
// compiled in at all.

import {
    addToScene,
    createArcRotateCamera,
    createAudioEngineAsync,
    createBox,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    createSoundSourceAsync,
    createStandardMaterial,
    registerScene,
    startEngine,
    unlockAudioEngineAsync,
} from "@babylonjs/lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.clearColor = { r: 0.03, g: 0.04, b: 0.06, a: 1 };

const camera = createArcRotateCamera(
    -Math.PI / 2,
    Math.PI / 2.5,
    6,
    { x: 0, y: 0, z: 0 },
);
scene.camera = camera;
addToScene(scene, createHemisphericLight([0, 1, 0], 1));

const material = createStandardMaterial();
material.diffuseColor = [0.2, 0.7, 0.9];
const box = createBox(engine, { width: 2, height: 2, depth: 2 });
box.material = material;
addToScene(scene, box);

// The audio half. A browser needs a gesture before a context makes sound;
// `unlockAudioEngineAsync` is that call, and a native build resumes
// unconditionally because there is no autoplay policy to satisfy.
const audio = await createAudioEngineAsync();
await unlockAudioEngineAsync(audio);
const ctx = audio.audioContext;

// A major triad, each voice its own oscillator through its own gain, all
// summed into one node routed into the engine's main bus. `createSoundSourceAsync`
// is what puts a caller-built graph under the engine's master volume
// rather than beside it.
const mix = ctx.createGain();
mix.gain.value = 0.12;
await createSoundSourceAsync(audio, mix);

const root = ctx.createOscillator();
root.type = "sine";
root.frequency.value = 220;
root.connect(mix);
root.start(0);

const third = ctx.createOscillator();
third.type = "triangle";
third.frequency.value = 277.18;
third.connect(mix);
third.start(0);

const fifth = ctx.createOscillator();
fifth.type = "sine";
fifth.frequency.value = 329.63;
fifth.connect(mix);
fifth.start(0);

// A slow swell, scheduled on the audio clock rather than stepped by the
// frame loop -- the whole point of the seam: `currentTime` advances on the
// audio thread and everything above is scheduled ahead of it.
const now = ctx.currentTime;
mix.gain.setValueAtTime(0.0001, now);
mix.gain.exponentialRampToValueAtTime(0.12, now + 1.5);

await registerScene(scene);
await startEngine(engine);
