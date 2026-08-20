/**
 * The node-material composition path: a Babylon NME graph compiled by the
 * pin's own emitter and pipeline builder, never re-derived here.
 *
 * The assertions look for the pin's own output — its entry-point names, the
 * mesh block `buildMeshStruct` writes, the uniform block its named inputs
 * produce — so a pin that changes any of them is a change to see rather than
 * a plausible neighbour composed in its place. The refusals are the other
 * half: an arm this port does not serve has to fail at generation, because a
 * composed module carrying one no PAL binds renders as a plausible-but-wrong
 * image rather than as an error.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    composeNodeMaterial,
    type ComposedNodeMaterial,
} from "../src/pinned-node-material.js";
import {
    nodeVariantStageStems,
    pinnedNodeVariantsHeader,
} from "../src/pinned-node-material-cpp.js";
import { executeModuleGraph } from "../src/executed-module-graph.js";

/**
 * One corpus graph. Read by running its module, which is what generation does
 * for a module that builds its graph — and works equally for one that exports
 * it, since which route a call takes is the compiler's decision rather than
 * composition's.
 */
const corpusGraph = (scene: number): Promise<Record<string, unknown>> =>
    executeModuleGraph({
        modulePath:
            `corpus/babylon-lite/lab/lite/src/shared/scene${scene}-nme.ts`,
        exportName: `SCENE${scene}_NME_JSON`,
    });

test("compiles the minimal graph through the pin's own emitter", async () => {
    const composed = await composeNodeMaterial(
        await corpusGraph(60),
        "scene60",
    );
    // Both entry points, from the one module the pin builds.
    assert.match(composed.wgsl, /@vertex\nfn vs_main/);
    assert.match(composed.wgsl, /@fragment\nfn fs_main/);
    // The pin's own per-pass scene block and its node mesh block.
    assert.match(composed.wgsl, /@group\(0\) @binding\(0\) var<uniform> scene/);
    assert.match(composed.wgsl, /struct MeshU \{/);
    // Scene 60's graph is one vec4 colour input feeding the fragment output.
    assert.equal(composed.uboBytes, 16);
    assert.equal(composed.uboBinding, 1);
    assert.deepEqual(
        composed.uboFloats.map((value) => Math.round(value * 100) / 100),
        [0.85, 0.2, 0.2, 1],
    );
    assert.deepEqual(composed.attributes, [{ location: 0, name: "position" }]);
    assert.equal(composed.backFaceCulling, true);
});

test("carries the vertex inputs the graph declares, in the pin's order", async () => {
    // The pin numbers locations by emission order rather than by a fixed
    // convention, which is why a PAL resolves them by name.
    const composed = await composeNodeMaterial(
        await corpusGraph(61),
        "scene61",
    );
    assert.deepEqual(
        composed.attributes.map((attribute) => attribute.name).sort(),
        ["normal", "position"],
    );
    for (const [index, attribute] of composed.attributes.entries()) {
        assert.equal(attribute.location, index);
    }
});

test("runs a module that builds its graph rather than exporting one", async () => {
    // Scene 78's module assembles its blocks at load through an id counter
    // and `push`, which is the route the compiler cannot fold.
    const graph = await corpusGraph(78);
    assert.ok(Array.isArray(graph["blocks"]));
    const composed = await composeNodeMaterial(graph, "scene78");
    assert.match(composed.wgsl, /@fragment\nfn fs_main/);
    assert.ok(composed.uboBytes > 0);
});

test("refuses an arm outside the reached slice", async () => {
    // `forceAlphaBlending` is the graph's own JSON-level override, and the
    // pin's parser turns it into `needsAlphaBlending` — an arm that would
    // need the transparent bucket and the sort.
    const graph = { ...(await corpusGraph(60)), forceAlphaBlending: true };
    await assert.rejects(
        () => composeNodeMaterial(graph, "blended"),
        /alpha blending/,
    );
});

test("emits the variant table and the pin's own mesh block", async () => {
    const composed = await composeNodeMaterial(
        await corpusGraph(60),
        "scene60",
    );
    const header = pinnedNodeVariantsHeader("test", [
        { index: 0, ...nodeVariantStageStems(0), composed },
    ]);
    assert.match(header, /node_variants\{\{/);
    assert.match(header, /"node-0\.vert", "node-0\.frag"/);
    // The mesh block is mirrored field for field, with the light-index array
    // where the pin's own layout puts it.
    assert.match(header, /struct NodeMeshUniforms \{/);
    assert.match(header, /offsetof\(NodeMeshUniforms, li\) == 96/);
    assert.match(header, /sizeof\(NodeMeshUniforms\) == 160/);
    // The block's bytes, folded from the graph's own defaults.
    assert.match(header, /0\.8500000238418579f/);
});

test("refuses two graphs whose mesh blocks disagree", async () => {
    const composed = await composeNodeMaterial(
        await corpusGraph(60),
        "scene60",
    );
    const widened: ComposedNodeMaterial = {
        ...composed,
        wgsl: composed.wgsl.replace(
            "struct MeshU {",
            "struct MeshU {\n    extra: vec4<f32>,",
        ),
    };
    assert.throws(
        () =>
            pinnedNodeVariantsHeader("test", [
                { index: 0, ...nodeVariantStageStems(0), composed },
                { index: 1, ...nodeVariantStageStems(1), composed: widened },
            ]),
        /mesh block/,
    );
});
