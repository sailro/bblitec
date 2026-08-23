// The pinned Standard UV-transform writer, as this port lowers it.
//
// The channel body is translated by `PinnedNumericLowerer` from the pinned
// AST, so what this file gates is the part that is this module's own: the
// record correspondences, the `CHANNELS` unroll, and the two precision rules
// the emitted text has to keep — every intermediate a double, and exactly one
// float store per lane.
import assert from "node:assert/strict";
import test from "node:test";
import {
    TEXTURE_UV_PROPERTIES,
    lowerStandardUvTransformWriter,
} from "../src/lowering/standard-uv-transform-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

/** The correspondences `pinnedStandardSupportBlock` passes in. */
const sources = {
    presence: {
        diffuseTexture:
            "!material.base_color_texture.bytes.empty() || " +
            "material.has_diffuse_render_texture",
        _bumpTexture: "!material.bump_texture.bytes.empty()",
        _specularTexture: "!material.specular_texture.bytes.empty()",
        _ambientTexture: "!material.ambient_texture.bytes.empty()",
        _opacityTexture: "!material.opacity_texture.bytes.empty()",
    },
    coordIndex: {
        diffuseCoordIndex: "material.diffuse_coord_index",
        specularCoordIndex: "material.specular_coord_index",
        ambientCoordIndex: "material.ambient_coord_index",
        lightmapCoordIndex: null,
    },
};

function lower(): string {
    const context = new LoweringContext(new UpstreamSourceStore());
    return lowerStandardUvTransformWriter(context, sources).source;
}

test("unrolls the pin's own CHANNELS table, one call per row", () => {
    const source = lower();
    // The pin's seven slots, in its own order — the WGSL field prefixes the
    // composed `stdUvTxUniforms` struct declares.
    for (const [index, [prefix, slot]] of [
        ["d", "diffuseTexture"],
        ["e", "_emissiveTexture"],
        ["b", "_bumpTexture"],
        ["s", "_specularTexture"],
        ["a", "_ambientTexture"],
        ["l", "_lightmapTexture"],
        ["o", "_opacityTexture"],
    ].entries()) {
        assert.ok(
            source.includes(`// channel ${index}: ${prefix} (${slot})`),
            `channel ${index} is not ${prefix} (${slot})`,
        );
    }
    // Call sites only: the definition above them opens the same way.
    assert.equal(
        source.split("    write_std_uv_transform_channel(\n").length - 1,
        7,
        "the unroll emits one call per CHANNELS row",
    );
});

test("takes a channel's texture from the same expression its feature bit does", () => {
    const source = lower();
    // The presence test and the feature derivation must be the one
    // expression: a channel that composes while its texture reads as absent
    // would write the untextured identity into a slot the fragment samples.
    assert.ok(
        source.includes(
            "(!material.base_color_texture.bytes.empty() || " +
                "material.has_diffuse_render_texture) ? " +
                "&material.base_color_texture : nullptr",
        ),
        "the diffuse channel does not use its feature bit's own predicate",
    );
    // A slot the generated loader never fills passes no texture at all,
    // which is what makes the pin's `texture?.x ?? default` reads fold.
    assert.match(
        source,
        /channel 1: e \(_emissiveTexture\)[\s\S]*?\n        nullptr,/,
    );
    assert.match(
        source,
        /channel 5: l \(_lightmapTexture\)[\s\S]*?\n        nullptr,/,
    );
});

test("folds each row's UV set from the pin's own coordIndexKey", () => {
    const source = lower();
    assert.ok(source.includes("material.diffuse_coord_index == 1"));
    assert.ok(source.includes("material.specular_coord_index == 1"));
    assert.ok(source.includes("material.ambient_coord_index == 1"));
    // Emissive, bump and opacity carry no coordIndexKey upstream, and the
    // lightmap's UV set is a slot this port does not record — both fold to
    // the constant the pin's `&&` produces.
    assert.equal(source.split(" == 1,").length - 1, 3);
});

test("computes in double and rounds once, at the store", () => {
    const source = lower();
    const body = source.slice(
        source.indexOf("write_std_uv_transform_channel(\n    std::array"),
    );
    // Every local the pin binds is an f64, because a JS number is.
    assert.ok(!/\n    const float /.test(body), "an intermediate rounds early");
    for (const local of ["sx", "sy", "angle", "c", "s", "m00", "m11"]) {
        assert.ok(
            body.includes(`const double ${local} =`),
            `${local} is not a double`,
        );
    }
    // And exactly one rounding per store. The pin writes eight lanes and
    // then re-stores three of them under `invertY`, so eleven is the count
    // its own body has; what matters is that no store escapes the cast.
    const stores = body.match(/^ *data\[[^\]]*\] = /gm) ?? [];
    const rounded =
        body.match(/^ *data\[[^\]]*\] = static_cast<float>\(/gm) ?? [];
    assert.equal(stores.length, 11, "the pin's own store count");
    assert.equal(
        rounded.length,
        stores.length,
        "a store reaches the block without rounding",
    );
});

test("declares the block the composed stage binds", () => {
    const source = lower();
    assert.ok(source.includes("std::array<float, 56> data{};"));
    assert.ok(source.includes("sizeof(StandardUvTxUniforms) == 224"));
});

test("spells every pinned Texture2D transform property once", () => {
    // The table the compiler's own property-assignment path shares, so a
    // member the writer reads and the setter writes cannot drift apart.
    assert.deepEqual(Object.keys(TEXTURE_UV_PROPERTIES), [
        "uScale",
        "vScale",
        "uOffset",
        "vOffset",
        "uAng",
        "invertY",
    ]);
    const source = lower();
    for (const { record } of Object.values(TEXTURE_UV_PROPERTIES)) {
        assert.ok(
            source.includes(`texture->${record}`),
            `${record} is never read by the lowered writer`,
        );
    }
});
