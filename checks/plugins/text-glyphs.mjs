// Scenes 180 and 181: the live text renderer's glyph placements. Each
// native phase is paired with the browser observation step of the same
// id: the glyph instances the native draw binds (decoded from the
// instance buffer through the manifest's glyph slots) must equal the
// browser's live instances, the style palette must match float for
// float, the viewport and (181) camera must agree, the images must
// agree within the declared gates, and (180) the text-layer uniform
// bytes and sample/depth state must match.
//
// options: { background: [r,g,b], gates: { <phase>: {full, foreground}, default: {...} },
//            textareaColumn?, textareaRows?  (181: the resized textarea's native height)
//            uniform?: true  (180: compare the text-layer uniform bytes and sample state) }
import assert from "node:assert/strict";
import { compareImages, compareRegion } from "../../dist/src/parity.js";
import { assertObservationProvenance, loadPng, observedImage, observedStep, readManifest, requireObservations } from "./support.mjs";

export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    const manifest = readManifest(context);
    const ids = new Map(manifest.textData[0].live.glyphSlots.map((slot, id) => [slot, id]));
    const { background, gates } = context.options;
    const details = {};
    for (const backend of context.backends) {
        for (const phase of Object.values(context.results[backend])) {
            const where = `${backend}/${phase.id}`;
            const step = observedStep(observations, phase.id);
            const state = step.state;
            const gpu = phase.capture.textGpu;
            assert.deepEqual(phase.capture.viewport, state.viewport, `${where}: viewport`);
            if (state.camera !== undefined) {
                for (const key of ["alpha", "beta", "radius"]) {
                    assert(Math.abs(phase.capture.camera[key] - state.camera[key]) < 1e-8, `${where}: camera ${key}: ${phase.capture.camera[key]} vs ${state.camera[key]}`);
                }
            }
            if (state.position !== undefined && state.width !== undefined && phase.id !== "initial" && phase.id !== "textarea-resize" && phase.id !== "window-resize" && phase.id !== "orbit" && phase.id !== "zoom") {
                assert.equal(state.position.x, -state.width * 0.01 * 0.5, `${where}: the browser text is centred`);
                assert.equal(state.position.y, state.height * 0.01 * 0.5, `${where}: the browser text is centred`);
            }
            const draw = gpu.draws[0];
            const expectedLive = state.instances.filter(Boolean);
            const actual = [];
            if (draw) {
                if (context.options.uniform) {
                    assert.equal(draw.samples, 1, `${where}: samples`);
                    assert.equal(draw.depthFormat, "", `${where}: depth format`);
                }
                const resource = gpu.resources.find((row) => row.id === draw.instances);
                assert(resource && !resource.destroyed, `${where}: instance buffer`);
                const bytes = Buffer.from(resource.uploadedBytes);
                for (let i = 0; i < draw.instanceCount; i++) {
                    const slot = draw.firstInstance + i;
                    const word = bytes.readUInt32LE(slot * 12 + 8);
                    if (word !== 0xffffffff) actual.push([ids.get(word & 0xffff), bytes.readFloatLE(slot * 12), bytes.readFloatLE(slot * 12 + 4), word >>> 16]);
                }
                const palette = Buffer.from(gpu.resources.find((row) => row.role === "styles" && !row.destroyed).uploadedBytes);
                assert.deepEqual(Array.from({ length: state.styles.length }, (_, i) => palette.readFloatLE(i * 4)), state.styles, `${where}: style palette`);
                if (context.options.uniform) {
                    const uniformId = draw.bindings.find((binding) => binding.role === "uniform").resource;
                    assert.deepEqual(gpu.resources.find((row) => row.id === uniformId).uploadedBytes, state.uniform, `${where}: source uniform writes`);
                }
            }
            assert.deepEqual(actual, expectedLive, `${where}: glyph placements`);
            const reference = observedImage(context, step.image);
            const full = compareImages(phase.image, reference);
            const foreground = compareRegion(phase.image, reference, background, 30);
            const gate = gates[phase.id] ?? gates.default;
            assert(full.mad < gate.full && foreground.mad < gate.foreground, `${where}: canvas full ${full.mad} / foreground ${foreground.mad} (gates ${gate.full} / ${gate.foreground})`);
            const native = loadPng(phase.image);
            assert.equal(native.width, state.viewport.width, `${where}: image width`);
            if (context.options.textareaColumn !== undefined && phase.id === "textarea-resize") {
                const column = context.options.textareaColumn;
                const rows = Array.from({ length: context.options.textareaRows }, (_, y) => y).filter((y) =>
                    background.some((color, c) => native.data[(y * native.width + column) * 4 + c] !== color));
                assert.equal(rows.at(-1) - rows[0] + 1, state.form.height, `${where}: native textarea resize height`);
            }
            details[where] = { glyphs: actual.length, fullMad: full.mad, foregroundMad: foreground.mad };
        }
    }
    return { details };
}
