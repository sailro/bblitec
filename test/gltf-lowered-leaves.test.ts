/**
 * The glTF-loader leaves lowered from their pinned ASTs — byte gate.
 *
 * The expected strings below are the exact C++ the loader template used
 * to carry as hand-written text. Rounds 1 and 2 of RD-2 replaced that
 * text with segments emitted from the pinned declarations
 * (`gltf-lowerer.ts`), and these assertions prove the emission
 * reproduces the transcription byte for byte — which is simultaneously
 * the proof that the transcription was faithful and that the lowering is
 * right. The mutation tests then prove the connection the old assertions
 * never had: a changed pinned formula changes the emitted bytes, and a
 * construct the lowering cannot carry refuses generation instead of
 * shipping stale C++.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import {
    GltfLowerer,
    lowerAccessorNormalizationCpp,
    lowerAnimationInterpolationCpp,
    lowerGltfExtensionDefaults,
    lowerImageProcessingDefaultsCpp,
    lowerSamplerMappingCpp,
    lowerShPrescaleCpp,
    lowerVertexColorCpp,
} from "../src/lowering/gltf-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

const store = new UpstreamSourceStore();

function pinnedFile(modulePath: string): ts.SourceFile {
    return store.getSourceFile(modulePath);
}

function doctoredFile(
    modulePath: string,
    needle: string,
    replacement: string,
    all: boolean,
): ts.SourceFile {
    const source = store.getSource(modulePath);
    assert.ok(
        source.includes(needle),
        `the pinned source no longer contains '${needle}'`,
    );
    return ts.createSourceFile(
        modulePath,
        all
            ? source.replaceAll(needle, replacement)
            : source.replace(needle, replacement),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
}

/** A doctored pin: the module's source with one exact edit applied. */
function mutatedFile(
    modulePath: string,
    needle: string,
    replacement: string,
): ts.SourceFile {
    return doctoredFile(modulePath, needle, replacement, false);
}

/** A doctored pin with the edit applied at every occurrence. */
function mutatedFileAll(
    modulePath: string,
    needle: string,
    replacement: string,
): ts.SourceFile {
    return doctoredFile(modulePath, needle, replacement, true);
}

const evaluateModule = "src/animation/evaluate.ts";
const samplerModule = "src/loader-gltf/gltf-sampler-desc.ts";
const quantizationModule = "src/loader-gltf/gltf-ext-quantization.ts";
const colorModule = "src/loader-gltf/gltf-color-normalize.ts";
const assemblyModule = "src/loader-gltf/ibl-env-assembly.ts";
const loadEnvModule = "src/loader-env/load-env.ts";
const imageBasedModule =
    "src/loader-gltf/gltf-ext-lights-image-based.ts";
const dielectricModule = "src/loader-gltf/gltf-ext-dielectric.ts";
const iridescenceModule = "src/loader-gltf/gltf-ext-iridescence.ts";

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

/* ───────────────────────────── round 2 ───────────────────────────── */

const expectedAccessorNormalization = `        case 5120: {
            const std::int8_t value = read_value<std::int8_t>(data);
            return accessor.normalized ? std::max(-1.0f, static_cast<float>(value) / 127.0f) : value;
        }
        case 5121: {
            const std::uint8_t value = read_value<std::uint8_t>(data);
            return accessor.normalized ? static_cast<float>(value) / 255.0f : value;
        }
        case 5122: {
            const std::int16_t value = read_value<std::int16_t>(data);
            return accessor.normalized ? std::max(-1.0f, static_cast<float>(value) / 32767.0f) : value;
        }
        case 5123: {
            const std::uint16_t value = read_value<std::uint16_t>(data);
            return accessor.normalized ? static_cast<float>(value) / 65535.0f : value;
        }`;

const expectedVertexColor = `                if (colors) {
                    vertex.color = Vec4{
                        read_component(buffer, container, views, *colors, index, 0),
                        read_component(buffer, container, views, *colors, index, 1),
                        read_component(buffer, container, views, *colors, index, 2),
                        colors->type == "VEC4"
                            ? read_component(buffer, container, views, *colors, index, 3)
                            : 1.0f,
                    };
                }`;

const expectedShPrescale = `std::array<Color3, 9> pre_scale_harmonics(
    const std::array<Color3, 9>& polynomial) {
    constexpr float c00xy = 0.3333338747897695f;
    constexpr float c00z = 0.33333298856284405f;
    constexpr float c1 = 1.4999984284682104f;
    constexpr float c2 = 3.999982863580422f;
    constexpr float c20zz = 1.3333326611423701f;
    constexpr float c20xy = 0.6666653397393608f;
    constexpr float c22 = 1.999991431790211f;
    std::array<Color3, 9> result{};
    for (int channel = 0; channel < 3; ++channel) {
        const float x =
            color_channel(polynomial[0], channel);
        const float y =
            color_channel(polynomial[1], channel);
        const float z =
            color_channel(polynomial[2], channel);
        const float xx =
            color_channel(polynomial[3], channel);
        const float yy =
            color_channel(polynomial[4], channel);
        const float zz =
            color_channel(polynomial[5], channel);
        const float yz =
            color_channel(polynomial[6], channel);
        const float zx =
            color_channel(polynomial[7], channel);
        const float xy =
            color_channel(polynomial[8], channel);
        set_color_channel(
            result[0],
            channel,
            (xx + yy) * c00xy + zz * c00z);
        set_color_channel(
            result[1], channel, y * c1);
        set_color_channel(
            result[2], channel, z * c1);
        set_color_channel(
            result[3], channel, x * c1);
        set_color_channel(
            result[4], channel, xy * c2);
        set_color_channel(
            result[5], channel, yz * c2);
        set_color_channel(
            result[6],
            channel,
            zz * c20zz - (xx + yy) * c20xy);
        set_color_channel(
            result[7], channel, zx * c2);
        set_color_channel(
            result[8],
            channel,
            (xx - yy) * c22);
    }
    return result;
}`;

const expectedImageProcessingDefaults = `    environment.exposure = 0.8f;
    environment.contrast = 1.2f;
    environment.tone_mapping_enabled = true;`;

test("lowers the pinned accessor normalization byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerAccessorNormalizationCpp(pinnedFile(quantizationModule)),
        expectedAccessorNormalization,
    );
});

test("lowers the pinned COLOR_0 build byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerVertexColorCpp(
            pinnedFile(colorModule),
            pinnedFile(quantizationModule),
        ),
        expectedVertexColor,
    );
});

test("lowers the pinned SH prescale byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerShPrescaleCpp(
            pinnedFile(assemblyModule),
            pinnedFile(loadEnvModule),
        ),
        expectedShPrescale,
    );
});

test("lowers the pinned image-processing defaults byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerImageProcessingDefaultsCpp(pinnedFile(imageBasedModule)),
        expectedImageProcessingDefaults,
    );
});

test("lowers the pinned extension defaults to the shipped keys and constants", () => {
    assert.deepEqual(
        lowerGltfExtensionDefaults(
            pinnedFile(dielectricModule),
            pinnedFile(iridescenceModule),
        ),
        {
            ior: { key: "ior", literal: "1.5f" },
            transmissionFactor: {
                key: "transmissionFactor",
                literal: "0.0f",
            },
            thicknessFactor: { key: "thicknessFactor", literal: "0.0f" },
            attenuationDistance: {
                key: "attenuationDistance",
                literal: "1.0f",
            },
            dispersion: { key: "dispersion", literal: "0.0f" },
            dispersionScale: "20.0f",
            iridescenceFactor: {
                key: "iridescenceFactor",
                literal: "0.0f",
            },
            iridescenceIor: { key: "iridescenceIor", literal: "1.3f" },
            iridescenceThicknessMinimum: {
                key: "iridescenceThicknessMinimum",
                literal: "100.0f",
            },
            iridescenceThicknessMaximum: {
                key: "iridescenceThicknessMaximum",
                literal: "400.0f",
            },
        },
    );
});

test("the emitted loader carries every round-2 lowered segment", () => {
    const adapter = new GltfLowerer(new LoweringContext(store))
        .lowerLoaderAdapter();
    assert.ok(adapter.source.includes(expectedAccessorNormalization));
    assert.ok(adapter.source.includes(expectedVertexColor));
    assert.ok(adapter.source.includes(expectedShPrescale));
    assert.ok(adapter.source.includes(expectedImageProcessingDefaults));
    for (const line of [
        'float_or(ior_value->as_object(), "ior", 1.5f);',
        'float_or(volume, "thicknessFactor", 0.0f);',
        'float_or(volume, "attenuationDistance", 1.0f);',
        'float_or(transmission, "transmissionFactor", 0.0f);',
        "material.dispersion = 20.0f / dispersion;",
        'float_or(iridescence, "iridescenceIor", 1.3f);',
        '"iridescenceThicknessMinimum",\n                100.0f);',
        '"iridescenceThicknessMaximum",\n                400.0f);',
    ]) {
        assert.ok(
            adapter.source.includes(line),
            `the emitted loader no longer carries '${line}'`,
        );
    }
});

test("a changed accessor scale flows into the emitted bytes", () => {
    const lowered = lowerAccessorNormalizationCpp(
        mutatedFile(quantizationModule, "c / 65535 : c", "c / 65534 : c"),
    );
    assert.notEqual(lowered, expectedAccessorNormalization);
    assert.match(lowered, /static_cast<float>\(value\) \/ 65534\.0f/);
});

test("a changed signed clamp bound flows into the emitted bytes", () => {
    const lowered = lowerAccessorNormalizationCpp(
        mutatedFile(
            quantizationModule,
            "Math.max(c / 127, -1)",
            "Math.max(c / 127, 0)",
        ),
    );
    assert.match(
        lowered,
        /std::max\(0\.0f, static_cast<float>\(value\) \/ 127\.0f\)/,
    );
});

test("a clamp that is no longer Math.max refuses generation", () => {
    assert.throws(
        () =>
            lowerAccessorNormalizationCpp(
                mutatedFile(
                    quantizationModule,
                    "Math.max(c / 127, -1)",
                    "Math.min(c / 127, -1)",
                ),
            ),
        /clamps through a call this lowering cannot carry/,
    );
});

test("a color divisor the accessor path does not apply refuses", () => {
    // The record path normalizes COLOR_0 inside read_component, so the
    // color module's own divisor must be exactly the accessor divisor
    // for that width — a pin that moves one without the other refuses.
    assert.throws(
        () =>
            lowerVertexColorCpp(
                pinnedFile(colorModule),
                mutatedFile(
                    quantizationModule,
                    "c / 65535 : c",
                    "c / 65534 : c",
                ),
            ),
        /a rule the pinned readComponent does not apply/,
    );
});

test("a changed absent-alpha default flows into the emitted bytes", () => {
    // All three branches carry the fallback, so the doctored pin edits
    // every occurrence; a single-branch edit refuses instead (below).
    const lowered = lowerVertexColorCpp(
        mutatedFileAll(colorModule, ": 1;", ": 0.5;"),
        pinnedFile(quantizationModule),
    );
    assert.notEqual(lowered, expectedVertexColor);
    assert.match(lowered, /: 0\.5f,/);
});

test("color branches that disagree on the alpha default refuse", () => {
    assert.throws(
        () =>
            lowerVertexColorCpp(
                mutatedFile(
                    colorModule,
                    "out[v * 4 + 3] = hasAlpha ? data[v * comps + 3]! : 1;",
                    "out[v * 4 + 3] = hasAlpha ? data[v * comps + 3]! : 0;",
                ),
                pinnedFile(quantizationModule),
            ),
        /no longer stores the same lanes/,
    );
});

test("a changed SH band constant flows through both pinned copies", () => {
    const needle = "const C1 = 1.4999984284682104;";
    const replacement = "const C1 = 1.25;";
    const lowered = lowerShPrescaleCpp(
        mutatedFile(assemblyModule, needle, replacement),
        mutatedFile(loadEnvModule, needle, replacement),
    );
    assert.notEqual(lowered, expectedShPrescale);
    assert.match(lowered, /constexpr float c1 = 1\.25f;/);
});

test("SH prescale copies that diverge refuse generation", () => {
    // The glTF loader executes ibl-env-assembly's private copy and the
    // .env path lowers load-env's canonical; a value moved in only one
    // is a pin defect to surface, never a value to pick.
    assert.throws(
        () =>
            lowerShPrescaleCpp(
                mutatedFile(
                    assemblyModule,
                    "const C1 = 1.4999984284682104;",
                    "const C1 = 1.25;",
                ),
                pinnedFile(loadEnvModule),
            ),
        /diverged between/,
    );
});

test("a changed IBL exposure flows into the emitted bytes", () => {
    const lowered = lowerImageProcessingDefaultsCpp(
        mutatedFile(
            imageBasedModule,
            "scene.imageProcessing.exposure = 0.8;",
            "scene.imageProcessing.exposure = 0.75;",
        ),
    );
    assert.notEqual(lowered, expectedImageProcessingDefaults);
    assert.match(lowered, /environment\.exposure = 0\.75f;/);
});

test("IBL tone mapping that is no longer enabled refuses", () => {
    assert.throws(
        () =>
            lowerImageProcessingDefaultsCpp(
                mutatedFile(
                    imageBasedModule,
                    "scene.imageProcessing.toneMappingEnabled = true;",
                    "scene.imageProcessing.toneMappingEnabled = false;",
                ),
            ),
        /no longer enables tone mapping/,
    );
});

test("a changed dielectric default flows into the emitted keys", () => {
    const defaults = lowerGltfExtensionDefaults(
        mutatedFile(dielectricModule, "eIor.ior : 1.5", "eIor.ior : 1.4"),
        pinnedFile(iridescenceModule),
    );
    assert.deepEqual(defaults.ior, { key: "ior", literal: "1.4f" });
});

test("a changed dispersion numerator flows into the emitted scale", () => {
    const defaults = lowerGltfExtensionDefaults(
        mutatedFile(
            dielectricModule,
            "setPbrDispersion(out, 20.0 / dispersion)",
            "setPbrDispersion(out, 21.5 / dispersion)",
        ),
        pinnedFile(iridescenceModule),
    );
    assert.equal(defaults.dispersionScale, "21.5f");
});

test("a new dielectric default no entry consumes refuses", () => {
    assert.throws(
        () =>
            lowerGltfExtensionDefaults(
                mutatedFile(
                    dielectricModule,
                    'const dispersion: number = typeof eDisp?.dispersion === "number" ? eDisp.dispersion : 0;',
                    'const dispersion: number = typeof eDisp?.dispersion === "number" ? eDisp.dispersion : 0;\n        const halo: number = typeof eDisp?.halo === "number" ? eDisp.halo : 7;',
                ),
                pinnedFile(iridescenceModule),
            ),
        /defaults 'halo', which no lowering entry consumes/,
    );
});

test("a volume fallback tint that stops being white refuses", () => {
    // The record's attenuation_color default is white, so the template
    // carries no color write for the absent-attenuation arm; a pin that
    // tints the fallback would make that arm wrong silently.
    assert.throws(
        () =>
            lowerGltfExtensionDefaults(
                mutatedFile(
                    dielectricModule,
                    "{ color: [1, 1, 1], atDistance: 1 }",
                    "{ color: [1, 0.5, 1], atDistance: 1 }",
                ),
                pinnedFile(iridescenceModule),
            ),
        /no longer falls back to a white tint/,
    );
});

test("a changed iridescence default flows into the emitted keys", () => {
    const defaults = lowerGltfExtensionDefaults(
        pinnedFile(dielectricModule),
        mutatedFile(
            iridescenceModule,
            "iri.iridescenceIor ?? 1.3",
            "iri.iridescenceIor ?? 1.7",
        ),
    );
    assert.deepEqual(defaults.iridescenceIor, {
        key: "iridescenceIor",
        literal: "1.7f",
    });
});
