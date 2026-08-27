/**
 * The pin's own polyhedron table, executed rather than read.
 *
 * `polyhedron-data.ts` is 431 lines of literal vertex and face rows for
 * fifteen presets, and `createPolyhedronData` selects one by index. The
 * index a scene names is a compile-time value, so generation makes that
 * selection and the emitted record carries the chosen row alone — one
 * polyhedron costs one table rather than fifteen.
 *
 * Executed because the table IS its value: there is no shape to assert and
 * nothing to lower, and running the module is the only reading of it that
 * cannot transcribe a row wrong.
 */
import { importPinnedModule } from "./pinned-shader-composer.js";

/** One preset, as the pinned table states it. */
export interface PinnedPolyhedron {
    vertex: readonly (readonly number[])[];
    face: readonly (readonly number[])[];
}

const pinnedPolyhedronData = await importPinnedModule<{
    POLYHEDRA: readonly PinnedPolyhedron[];
}>("mesh/polyhedron-data.js");

/** How many presets the pin declares — the range `type` is clamped into. */
export function pinnedPolyhedronCount(): number {
    return pinnedPolyhedronData.POLYHEDRA.length;
}

/** One preset by its `type` index. */
export function pinnedPolyhedron(type: number): PinnedPolyhedron {
    const preset = pinnedPolyhedronData.POLYHEDRA[type];
    if (!preset) {
        throw new Error(
            `The pinned polyhedron table declares no type ${type}.`,
        );
    }
    return preset;
}
