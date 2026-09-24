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
import {
    assertObservationProvenance,
    loadPng,
    observedImage,
    observedStep,
    readManifest,
    requireObservations,
} from "./support.mjs";

/**
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 */

/**
 * @typedef {{ full: number, foreground: number }} Gate
 * @typedef {{
 *     background: [number, number, number],
 *     gates: Record<string, Gate>,
 *     textareaColumn?: number,
 *     textareaRows?: number,
 *     uniform?: boolean,
 * }} Options the check's plugin options
 * @typedef {{ width: number, height: number }} Extent
 * @typedef {{ alpha: number, beta: number, radius: number }} OrbitCamera
 * @typedef {[number | null, number, number, number]} GlyphInstance glyph id, x, y, style
 * @typedef {{
 *     viewport: Extent,
 *     instances: Array<GlyphInstance | null>,
 *     styles: number[],
 *     form: Extent,
 *     uniform?: number[],
 *     camera?: OrbitCamera,
 *     position?: { x: number, y: number, z: number },
 *     width?: number,
 *     height?: number,
 * }} ObservedState the hook's `window.__observe()` record (180 adds `uniform`; 181 adds the camera and the text's position and size)
 * @typedef {{ id: number, role: string, destroyed: boolean, uploadedBytes: number[] }} GpuResource
 * @typedef {{
 *     samples: number,
 *     depthFormat: string,
 *     instances: number,
 *     instanceCount: number,
 *     firstInstance: number,
 *     bindings: Array<{ role: string, resource: number }>,
 * }} TextDraw
 * @typedef {{
 *     viewport: Extent,
 *     camera?: OrbitCamera,
 *     textGpu?: { draws: TextDraw[], resources: GpuResource[] },
 * }} NativeCapture the fields read from a phase's render capture (a standalone text frame has no camera)
 */

const CAMERA_KEYS = /** @type {const} */ (["alpha", "beta", "radius"]);

/** @param {PluginContext} context */
export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    const manifest = readManifest(context);
    // The packaged repertoire is the pin's GlyphStorage graph: its atlas's
    // `_glyphSlots` map names each glyph id's atlas slot.
    const storage = manifest.textData?.[0]?.repertoire?.storage;
    assert(storage, "the manifest carries no packaged text repertoire");
    const atlas = storage.records.find(
        (record) => record.name === "SharedAtlas",
    );
    assert(atlas, "the packaged repertoire has an atlas");
    const slots = atlas.fields._glyphSlots;
    assert(
        slots !== null && typeof slots === "object" && "container" in slots,
        "the atlas's _glyphSlots is a container",
    );
    const container = storage.containers[slots.container];
    assert(container?.kind === "map", "the atlas's _glyphSlots is a map");
    /** @type {Map<number, number>} */
    const ids = new Map(
        container.entries.map(([id, slot]) => {
            assert(
                slot !== null && typeof slot === "object" && "value" in slot,
                "a glyph slot is a record value",
            );
            const index = slot.value._index;
            assert(
                typeof index === "number" && typeof id === "number",
                "a glyph slot pairs a numeric id with a numeric index",
            );
            return [index, id];
        }),
    );
    const options = /** @type {Options} */ (context.options);
    const { background, gates } = options;
    /** @type {Record<string, { glyphs: number, fullMad: number, foregroundMad: number }>} */
    const details = {};
    for (const backend of context.backends) {
        const results = context.results[backend];
        assert(results, `${backend}: no phase results`);
        for (const phase of Object.values(results)) {
            const where = `${backend}/${phase.id}`;
            const step = observedStep(observations, phase.id);
            assert(step.state, `${where}: the observed step recorded no state`);
            const state = /** @type {ObservedState} */ (step.state);
            const capture = /** @type {NativeCapture} */ (phase.capture);
            const gpu = capture.textGpu;
            assert.deepEqual(
                capture.viewport,
                state.viewport,
                `${where}: viewport`,
            );
            if (state.camera !== undefined) {
                const camera = capture.camera;
                assert(camera, `${where}: the capture carries no camera`);
                for (const key of CAMERA_KEYS) {
                    assert(
                        Math.abs(camera[key] - state.camera[key]) < 1e-8,
                        `${where}: camera ${key}: ${camera[key]} vs ${state.camera[key]}`,
                    );
                }
            }
            if (
                state.position !== undefined &&
                state.width !== undefined &&
                (phase.id === "edit" ||
                    phase.id === "empty" ||
                    phase.id === "regrow")
            ) {
                // `===`, not Object.is: an empty text centres at -0, which the
                // observation's JSON carries as 0.
                assert.ok(
                    state.position.x === -state.width * 0.01 * 0.5,
                    `${where}: the browser text is centred (x ${state.position.x}, width ${state.width})`,
                );
                assert.ok(
                    state.position.y === (state.height ?? NaN) * 0.01 * 0.5,
                    `${where}: the browser text is centred (y ${state.position.y}, height ${state.height})`,
                );
            }
            assert(gpu, `${where}: missing text GPU operation receipts`);
            const draw = gpu.draws[0];
            const expectedLive = state.instances.filter(Boolean);
            /** @type {Array<[number | undefined, number, number, number]>} */
            const actual = [];
            if (draw) {
                if (options.uniform) {
                    assert.equal(draw.samples, 1, `${where}: samples`);
                    assert.equal(
                        draw.depthFormat,
                        "",
                        `${where}: depth format`,
                    );
                }
                const resource = gpu.resources.find(
                    (row) => row.id === draw.instances,
                );
                assert(
                    resource && !resource.destroyed,
                    `${where}: instance buffer`,
                );
                const bytes = Buffer.from(resource.uploadedBytes);
                for (let i = 0; i < draw.instanceCount; i++) {
                    const slot = draw.firstInstance + i;
                    const word = bytes.readUInt32LE(slot * 12 + 8);
                    if (word !== 0xffffffff)
                        actual.push([
                            ids.get(word & 0xffff),
                            bytes.readFloatLE(slot * 12),
                            bytes.readFloatLE(slot * 12 + 4),
                            word >>> 16,
                        ]);
                }
                const styles = gpu.resources.find(
                    (row) => row.role === "styles" && !row.destroyed,
                );
                assert(styles, `${where}: no live style buffer`);
                const palette = Buffer.from(styles.uploadedBytes);
                assert.deepEqual(
                    Array.from({ length: state.styles.length }, (_, i) =>
                        palette.readFloatLE(i * 4),
                    ),
                    state.styles,
                    `${where}: style palette`,
                );
                if (options.uniform) {
                    const uniformBinding = draw.bindings.find(
                        (binding) => binding.role === "uniform",
                    );
                    assert(
                        uniformBinding,
                        `${where}: the draw binds no uniform`,
                    );
                    const uniformId = uniformBinding.resource;
                    const uniform = gpu.resources.find(
                        (row) => row.id === uniformId,
                    );
                    assert(
                        uniform,
                        `${where}: no uniform resource ${uniformId}`,
                    );
                    assert.deepEqual(
                        uniform.uploadedBytes,
                        state.uniform,
                        `${where}: source uniform writes`,
                    );
                }
            }
            assert.deepEqual(
                actual,
                expectedLive,
                `${where}: glyph placements`,
            );
            const reference = observedImage(context, step.image);
            const full = compareImages(phase.image, reference);
            const foreground = compareRegion(
                phase.image,
                reference,
                background,
                30,
            );
            const gate = gates[phase.id] ?? gates.default;
            assert(gate, `${where}: no gate for the phase and no default gate`);
            assert(
                full.mad < gate.full && foreground.mad < gate.foreground,
                `${where}: canvas full ${full.mad} / foreground ${foreground.mad} (gates ${gate.full} / ${gate.foreground})`,
            );
            const native = loadPng(phase.image);
            assert.equal(
                native.width,
                state.viewport.width,
                `${where}: image width`,
            );
            if (
                options.textareaColumn !== undefined &&
                phase.id === "textarea-resize"
            ) {
                const column = options.textareaColumn;
                const rows = Array.from(
                    { length: options.textareaRows ?? 0 },
                    (_, y) => y,
                ).filter((y) =>
                    background.some(
                        (color, c) =>
                            native.data[(y * native.width + column) * 4 + c] !==
                            color,
                    ),
                );
                assert.equal(
                    (rows.at(-1) ?? NaN) - (rows[0] ?? NaN) + 1,
                    state.form.height,
                    `${where}: native textarea resize height`,
                );
            }
            details[where] = {
                glyphs: actual.length,
                fullMad: full.mad,
                foregroundMad: foreground.mad,
            };
        }
    }
    return { details };
}
