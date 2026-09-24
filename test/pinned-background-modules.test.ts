/**
 * The pin's background arms, as generation reads them back from executing
 * its factories: the modules deploy with the pin's own groups, bindings and
 * structs, the table carries the pipeline state and group-1 entries the
 * factory created, and the lowered builders fill the buffers its draw binds.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedBackgroundsHeader } from "../src/lowering/pinned-background-lowerer.js";
import {
    composePinnedBackgroundModules,
    type PinnedBackgroundArm,
} from "../src/pinned-background-modules.js";

const everyArm = {
    ground: true,
    skybox: true,
    ddsEnvironment: true,
    solidSkybox: true,
    imageSkybox: true,
};

function arm(
    arms: readonly PinnedBackgroundArm[],
    name: PinnedBackgroundArm["name"],
): PinnedBackgroundArm {
    const found = arms.find((candidate) => candidate.name === name);
    assert.ok(found, `expected the ${name} arm`);
    return found;
}

test("reads each background arm back from its executed factory", async () => {
    const arms = await composePinnedBackgroundModules(everyArm);
    assert.deepEqual(
        arms.map(({ name }) => name),
        [
            "ground",
            "groundDither",
            "hdrSkybox",
            "ddsSkybox",
            "ddsSkyboxNoDither",
            "solidSkybox",
            "imageSkybox",
        ],
    );

    // The modules keep the pin's own groups and structs: nothing is
    // re-addressed onto a flattened block.
    const ground = arm(arms, "ground");
    assert.match(
        ground.vertex.wgsl,
        /@group\(0\) @binding\(0\) var<uniform> scene:/,
    );
    assert.match(
        ground.vertex.wgsl,
        /@group\(1\) @binding\(0\) var<uniform> mesh:/,
    );
    assert.match(ground.vertex.wgsl, /scene\.viewProjection/);
    assert.match(
        ground.fragment.wgsl,
        /fn dither\(a:vec2<f32>,b:f32\)->f32\{return 0\.0;\}/,
    );
    assert.match(
        arm(arms, "groundDither").fragment.wgsl,
        /fn dither\(seed:vec2<f32>,varianceAmount:f32\)->f32\{/,
    );
    assert.deepEqual(
        ground.vertexBuffers.map(({ arrayStride }) => arrayStride),
        [12, 12, 8],
    );
    assert.deepEqual(ground.pipeline, {
        cullMode: "back",
        clockwiseFrontFace: false,
        depthWrite: false,
        blend: {
            srcColor: "one",
            dstColor: "one_minus_src_alpha",
            srcAlpha: "one",
            dstAlpha: "one_minus_src_alpha",
        },
    });
    assert.deepEqual(
        ground.bindings.map(({ binding, kind, vertex, fragment }) => [
            binding,
            kind,
            vertex,
            fragment,
        ]),
        [
            [0, "uniformBuffer", true, true],
            [1, "texture2d", false, true],
            [2, "sampler", false, true],
        ],
    );
    assert.deepEqual(ground.draw, {
        vertexSlots: ["posBuffer", "normBuffer", "uvBuffer"],
        index: "idxBuffer",
        indexFormat: "uint16",
    });
    assert.equal(ground.meshBlockBytes, 96);

    // The .env arm composes no scene block into its fragment.
    const hdr = arm(arms, "hdrSkybox");
    assert.doesNotMatch(hdr.fragment.wgsl, /var<uniform> scene/);
    assert.equal(hdr.bindings[1]?.kind, "textureCube");
    assert.deepEqual(hdr.draw.vertexSlots, ["0"]);

    // The image skybox: cull none and depth writes on, as the pin's own
    // descriptor states them, and its constant identity world.
    const image = arm(arms, "imageSkybox");
    assert.equal(image.pipeline.cullMode, "none");
    assert.equal(image.pipeline.depthWrite, true);
    assert.deepEqual(image.draw, {
        vertexSlots: ["positions", "normals"],
        index: "indices",
        indexFormat: "uint32",
    });
    assert.deepEqual(
        image.constantMeshBlock,
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    );
});

test("lowers each arm's builders into the backgrounds header", async () => {
    const arms = await composePinnedBackgroundModules(everyArm);
    const header = pinnedBackgroundsHeader(new LoweringContext(), arms);
    // createBgMeshUBO, lowered: the pin's epsilon lanes and alpha survive,
    // stored at the pin's own float32 width from double arithmetic.
    assert.match(
        header,
        /inline std::array<float, 24> pinned_ground_mesh_block\(/,
    );
    assert.match(header, /const double eps = 2\.220446049250313e-16;/);
    assert.match(header, /= static_cast<float>\(0\.9\);/);
    // createGroundBuffers, lowered: the pin's index table at its own width,
    // and the arrays in the draw's slot order.
    assert.match(
        header,
        /const std::array<std::uint16_t, 6> indices\{0u, 2u, 1u, 0u, 3u, 2u\};/,
    );
    assert.match(
        header,
        /PinnedBackgroundGeometry\{\{pinned_background_bytes\(positions\), pinned_background_bytes\(normals\), pinned_background_bytes\(uvs\)\}, pinned_background_bytes\(indices\)\}/,
    );
    // The factories' own arguments: the entry points halve the skybox size,
    // and the .env arm passes the scene's clear colour through whole.
    assert.match(
        header,
        /pinned_hdr_skybox_geometry\(scene\.environment\.skybox_size \/ 2\.0\)/,
    );
    assert.match(
        header,
        /pinned_hdr_skybox_mesh_block\([^;]*scene\.clear_color,/,
    );
    // The image skybox's box is the lowered createBoxData.
    assert.match(
        header,
        /const MeshData box = create_box_data\(size, size, size\);/,
    );
    // The table carries the recorded state rather than a hand-kept one.
    assert.match(
        header,
        /PinnedBackgroundArmKind::image_skybox,\s*"skybox-cubemap\.vert",\s*"skybox-cubemap\.frag",[\s\S]*?RenderCullMode::none,\s*false,\s*true,/,
    );
});
