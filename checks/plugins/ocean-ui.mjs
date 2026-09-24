import assert from "node:assert/strict";
import {
    assertObservationProvenance,
    observedStep,
    requireObservations,
} from "./support.mjs";

/**
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 */

/**
 * @typedef {{
 *     search: string,
 *     dataset: Record<string, string | undefined>,
 *     sections: Record<string, boolean | undefined>,
 *     colors: string[],
 *     scrollTop: number,
 *     scrollHeight: number,
 *     clientHeight: number,
 * }} ControlsState the check's `observe.state` record
 */

/** @param {PluginContext} context */
export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    /** @param {string} id */
    const state = (id) => {
        const step = observedStep(observations, id);
        assert.deepEqual(step.errors ?? [], [], `${id}: browser errors`);
        assert(step.state, `${id}: browser state is missing`);
        const observed = /** @type {ControlsState} */ (step.state);
        assert.equal(observed.search, "?seekTime=0.1");
        assert.equal(observed.dataset.ready, "true");
        assert.equal(observed.dataset.oceanStage, "complete");
        assert.equal(observed.dataset.animationFrozen, "true");
        return observed;
    };
    assert.equal(state("baseline").sections.General, true);
    assert.equal(state("general-collapsed").sections.General, false);
    assert.equal(state("general-restored").sections.General, true);
    for (const title of ["General", "Sky", "Waves Generator"]) {
        assert.equal(state("sections-collapsed").sections[title], false);
        assert.equal(state("shader-open").sections[title], false);
    }
    assert.equal(state("shader-open").sections["Ocean Shader"], true);
    assert.equal(state("color-red").colors[0], "#d02020");
    for (const id of ["color-cancelled", "color-restored"]) {
        assert.equal(state(id).colors[0], "#214559");
    }
    const initial = state("baseline");
    assert.equal(initial.scrollTop, 0);
    assert(initial.scrollHeight > initial.clientHeight);
    const scrolled = state("scrolled");
    assert(scrolled.scrollTop > 500, "Scrollbar drag must scroll the controls");
    for (const backend of context.backends) {
        for (const phase of context.spec.phases) {
            assert(
                context.results[backend]?.[phase.id],
                `${backend}: missing ${phase.id}`,
            );
        }
    }
    return { details: { scrollTop: scrolled.scrollTop } };
}
