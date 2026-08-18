/**
 * The two glTF-loader leaves lowered from their pinned ASTs — byte gate.
 *
 * The expected strings below are the exact C++ the loader template used
 * to carry as hand-written text. Round 1 of RD-2 replaced that text with
 * segments emitted from the pinned declarations (`gltf-lowerer.ts`), and
 * these assertions prove the emission reproduces the transcription byte
 * for byte — which is simultaneously the proof that the transcription
 * was faithful and that the lowering is right. The mutation tests then
 * prove the connection the old assertions never had: a changed pinned
 * formula changes the emitted bytes, and a construct the lowering cannot
 * carry refuses generation instead of shipping stale C++.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import {
    GltfLowerer,
    lowerAnimationInterpolationCpp,
    lowerSamplerMappingCpp,
} from "../src/lowering/gltf-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

const store = new UpstreamSourceStore();

function pinnedFile(modulePath: string): ts.SourceFile {
    return store.getSourceFile(modulePath);
}

/** A doctored pin: the module's source with one exact edit applied. */
function mutatedFile(
    modulePath: string,
    needle: string,
    replacement: string,
): ts.SourceFile {
    const source = store.getSource(modulePath);
    assert.ok(
        source.includes(needle),
        `the pinned source no longer contains '${needle}'`,
    );
    return ts.createSourceFile(
        modulePath,
        source.replace(needle, replacement),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
}

const evaluateModule = "src/animation/evaluate.ts";
const samplerModule = "src/loader-gltf/gltf-sampler-desc.ts";

/** What the loader template carried by hand before the lowering. */
const expectedAnimationInterpolation = `Vec4 normalize_quaternion(Vec4 value) {
    // Pinned normalizeQuat4: double length over float32 components,
    // a multiply by the inverse square root, one rounding at the
    // Float32Array store, no epsilon, and the input kept verbatim on
    // zero length.
    const double x = value.x;
    const double y = value.y;
    const double z = value.z;
    const double w = value.w;
    const double length_squared =
        x * x + y * y + z * z + w * w;
    if (length_squared > 0.0) {
        const double inverse =
            1.0 / std::sqrt(length_squared);
        return Vec4{
            static_cast<float>(x * inverse),
            static_cast<float>(y * inverse),
            static_cast<float>(z * inverse),
            static_cast<float>(w * inverse),
        };
    }
    return value;
}

Vec4 interpolate_quaternion(Vec4 left, Vec4 right, double amount) {
    // Pinned sampler evaluation lifts float32 keyframes to JavaScript
    // doubles and rounds once at the Float32Array store.
    const double lx = left.x;
    const double ly = left.y;
    const double lz = left.z;
    const double lw = left.w;
    double rx = right.x;
    double ry = right.y;
    double rz = right.z;
    double rw = right.w;
    double dot = lx * rx + ly * ry + lz * rz + lw * rw;
    if (dot < 0.0) {
        rx = -rx;
        ry = -ry;
        rz = -rz;
        rw = -rw;
        dot = -dot;
    }
    if (dot > 0.9995) {
        // The pinned near-parallel path stores the double lerp into a
        // Float32Array scratch before normalizing it in place, so the
        // components round to float32 between the two steps.
        const Vec4 lerped{
            static_cast<float>(lx + amount * (rx - lx)),
            static_cast<float>(ly + amount * (ry - ly)),
            static_cast<float>(lz + amount * (rz - lz)),
            static_cast<float>(lw + amount * (rw - lw)),
        };
        return normalize_quaternion(lerped);
    }
    const double theta = std::acos(dot);
    const double sin_theta = std::sin(theta);
    const double left_weight =
        std::sin((1.0 - amount) * theta) / sin_theta;
    const double right_weight =
        std::sin(amount * theta) / sin_theta;
    return Vec4{
        static_cast<float>(left_weight * lx + right_weight * rx),
        static_cast<float>(left_weight * ly + right_weight * ry),
        static_cast<float>(left_weight * lz + right_weight * rz),
        static_cast<float>(left_weight * lw + right_weight * rw),
    };
}

Vec4 cubic_quaternion(
    Vec4 left,
    Vec4 left_tangent,
    Vec4 right,
    Vec4 right_tangent,
    double amount,
    double span) {
    // Pinned sampler evaluation lifts float32 keyframes to JavaScript
    // doubles and rounds once at the Float32Array store.
    const double amount2 = amount * amount;
    const double amount3 = amount2 * amount;
    const double h00 = 2.0 * amount3 - 3.0 * amount2 + 1.0;
    const double h10 = amount3 - 2.0 * amount2 + amount;
    const double h01 = -2.0 * amount3 + 3.0 * amount2;
    const double h11 = amount3 - amount2;
    // The pinned evaluator scales tangents by the key delta before
    // weighting, stores the Hermite sum into a Float32Array, and then
    // normalizes the rounded components in place.
    const Vec4 combined{
        static_cast<float>(
            h00 * left.x + h10 * (left_tangent.x * span) +
            h01 * right.x + h11 * (right_tangent.x * span)),
        static_cast<float>(
            h00 * left.y + h10 * (left_tangent.y * span) +
            h01 * right.y + h11 * (right_tangent.y * span)),
        static_cast<float>(
            h00 * left.z + h10 * (left_tangent.z * span) +
            h01 * right.z + h11 * (right_tangent.z * span)),
        static_cast<float>(
            h00 * left.w + h10 * (left_tangent.w * span) +
            h01 * right.w + h11 * (right_tangent.w * span)),
    };
    return normalize_quaternion(combined);
}

Vec3 cubic_vec3(
    Vec3 left,
    Vec3 left_tangent,
    Vec3 right,
    Vec3 right_tangent,
    double amount,
    double span) {
    // Pinned sampler evaluation lifts float32 keyframes to JavaScript
    // doubles and rounds once at the Float32Array store.
    const double amount2 = amount * amount;
    const double amount3 = amount2 * amount;
    const double h00 = 2.0 * amount3 - 3.0 * amount2 + 1.0;
    const double h10 = amount3 - 2.0 * amount2 + amount;
    const double h01 = -2.0 * amount3 + 3.0 * amount2;
    const double h11 = amount3 - amount2;
    // The pinned evaluator scales tangents by the key delta before
    // weighting and rounds once at the Float32Array store.
    return Vec3{
        static_cast<float>(
            h00 * left.x + h10 * (left_tangent.x * span) +
            h01 * right.x + h11 * (right_tangent.x * span)),
        static_cast<float>(
            h00 * left.y + h10 * (left_tangent.y * span) +
            h01 * right.y + h11 * (right_tangent.y * span)),
        static_cast<float>(
            h00 * left.z + h10 * (left_tangent.z * span) +
            h01 * right.z + h11 * (right_tangent.z * span)),
    };
}`;

const expectedSamplerMapping = `    const std::size_t min_filter =
        sampler ? unsigned_or(*sampler, "minFilter", 9987) : 9987;
    const std::size_t mag_filter =
        sampler ? unsigned_or(*sampler, "magFilter", 9729) : 9729;
    const bool min_nearest = min_filter % 2 == 0;
    const bool mip_nearest = min_filter == 9984 || min_filter == 9985;
    const bool no_mip = min_filter == 9728 || min_filter == 9729;
    const bool mag_linear = mag_filter != 9728;
    result.sampler.min_filter =
        min_nearest ? TextureFilter::nearest : TextureFilter::linear;
    result.sampler.mipmap_mode =
        mip_nearest ? TextureMipmapMode::nearest : TextureMipmapMode::linear;
    result.sampler.mag_filter =
        mag_linear ? TextureFilter::linear : TextureFilter::nearest;
    result.sampler.max_lod = no_mip ? 0.0f : 1000.0f;
    result.sampler.max_anisotropy =
        mag_linear && !min_nearest && !mip_nearest && !no_mip
            ? 4.0f
            : 1.0f;
    const auto address_mode = [](std::size_t mode) {
        return mode == 33071
            ? TextureAddressMode::clamp
            : mode == 33648
                ? TextureAddressMode::mirror
                : TextureAddressMode::repeat;
    };
    result.sampler.address_u = address_mode(
        sampler ? unsigned_or(*sampler, "wrapS", 10497) : 10497);
    result.sampler.address_v = address_mode(
        sampler ? unsigned_or(*sampler, "wrapT", 10497) : 10497);`;

test("lowers the pinned interpolation functions byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerAnimationInterpolationCpp(pinnedFile(evaluateModule)),
        expectedAnimationInterpolation,
    );
});

test("lowers the pinned sampler mapping byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerSamplerMappingCpp(pinnedFile(samplerModule)),
        expectedSamplerMapping,
    );
});

test("the emitted loader carries both lowered segments", () => {
    const adapter = new GltfLowerer(new LoweringContext(store))
        .lowerLoaderAdapter();
    assert.ok(adapter.source.includes(expectedAnimationInterpolation));
    assert.ok(adapter.source.includes(expectedSamplerMapping));
});

test("a changed slerp threshold flows into the emitted bytes", () => {
    const lowered = lowerAnimationInterpolationCpp(
        mutatedFile(evaluateModule, "dot > 0.9995", "dot > 0.4995"),
    );
    assert.notEqual(lowered, expectedAnimationInterpolation);
    assert.match(lowered, /if \(dot > 0\.4995\)/);
});

test("a changed Hermite coefficient flows into both cubic variants", () => {
    const lowered = lowerAnimationInterpolationCpp(
        mutatedFile(
            evaluateModule,
            "const h00 = 2 * f3 - 3 * f2 + 1;",
            "const h00 = 2 * f3 - 3 * f2 + 7;",
        ),
    );
    const occurrences = lowered.split(
        "const double h00 = 2.0 * amount3 - 3.0 * amount2 + 7.0;",
    ).length - 1;
    assert.equal(occurrences, 2);
});

test("a math intrinsic without a lowering refuses generation", () => {
    assert.throws(
        () =>
            lowerAnimationInterpolationCpp(
                mutatedFile(
                    evaluateModule,
                    "Math.acos(dot)",
                    "Math.atan(dot)",
                ),
            ),
        /Math\.atan, which has no lowering/,
    );
});

test("a moved tangent-triplet layout refuses generation", () => {
    assert.throws(
        () =>
            lowerAnimationInterpolationCpp(
                mutatedFile(
                    evaluateModule,
                    "output[k1 + c]!",
                    "output[k1 + 2 * stride + c]!",
                ),
            ),
        /triplet slot outside the pinned/,
    );
});

test("a changed wrap-mode constant flows into the emitted bytes", () => {
    const lowered = lowerSamplerMappingCpp(
        mutatedFile(samplerModule, "m === 33071", "m === 33099"),
    );
    assert.notEqual(lowered, expectedSamplerMapping);
    assert.match(lowered, /return mode == 33099/);
});

test("a predicate the absent-default substitution cannot cover refuses", () => {
    // 9987 is the substituted default for an absent min filter; a pin
    // that starts treating it as mip-nearest would make the substitution
    // observable, so generation must refuse rather than bake it.
    assert.throws(
        () =>
            lowerSamplerMappingCpp(
                mutatedFile(
                    samplerModule,
                    "minF === 9984 || minF === 9985",
                    "minF === 9987 || minF === 9985",
                ),
            ),
        /no longer evaluates the same for an absent sampler/,
    );
});

test("a new descriptor property no entry consumes refuses", () => {
    assert.throws(
        () =>
            lowerSamplerMappingCpp(
                mutatedFile(
                    samplerModule,
                    "maxAnisotropy: magLinear",
                    "lodMinClamp: 0, maxAnisotropy: magLinear",
                ),
            ),
        /'lodMinClamp', which no lowering entry consumes/,
    );
});

test("a descriptor property the table expects but the pin dropped refuses", () => {
    assert.throws(
        () =>
            lowerSamplerMappingCpp(
                mutatedFile(
                    samplerModule,
                    'mipmapFilter: mipNearest ? "nearest" : "linear",',
                    "",
                ),
            ),
        /no longer returns 'mipmapFilter'/,
    );
});
