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
    lowerGltfFactorBake,
    lowerGltfMaterialDefaults,
    lowerIblEnvironmentScalarsCpp,
    lowerIblPolynomialCpp,
    lowerImageProcessingDefaultsCpp,
    lowerLocalMatrixCpp,
    lowerMatrixComposeCpp,
    lowerMatrixMultiplyCpp,
    lowerMatrixNativeCpp,
    lowerPunctualLightsCpp,
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

/** A doctored pin with several exact edits applied in sequence. */
function mutatedFileEdits(
    modulePath: string,
    edits: readonly [needle: string, replacement: string][],
): ts.SourceFile {
    let source = store.getSource(modulePath);
    for (const [needle, replacement] of edits) {
        assert.ok(
            source.includes(needle),
            `the pinned source no longer contains '${needle}'`,
        );
        source = source.replace(needle, replacement);
    }
    return ts.createSourceFile(
        modulePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
}

const evaluateModule = "src/animation/evaluate.ts";
const punctualModule =
    "src/loader-gltf/gltf-feature-lights-punctual.ts";
const spotLightModule = "src/light/spot-light.ts";
const parserModule = "src/loader-gltf/gltf-parser.ts";
const multiplyModule = "src/math/mat4-multiply-into.ts";
const composeModule = "src/math/mat4-compose-into.ts";
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

/* ───────────────────────────── round 3 ───────────────────────────── */

const expectedMatrixMultiply = `Matrix multiply_matrix(const Matrix& left, const Matrix& right) {
    // Pinned matrix multiplication runs in JavaScript double
    // precision over float32 entries and rounds once per component
    // at the Float32Array store; mirror that exactly.
    Matrix result{};
    for (int column = 0; column < 4; ++column) {
        for (int row = 0; row < 4; ++row) {
            double sum = 0.0;
            for (int index = 0; index < 4; ++index) {
                sum +=
                    static_cast<double>(left[index * 4 + row]) *
                    static_cast<double>(right[column * 4 + index]);
            }
            result[column * 4 + row] = static_cast<float>(sum);
        }
    }
    return result;
}`;

const expectedMatrixCompose = `Matrix trs_matrix(
    Vec3 translation,
    Vec4 rotation,
    Vec3 scale) {
    // Pinned mat4ComposeInto runs in JavaScript double precision and
    // rounds once at the Float32Array store; mirror its products and
    // association exactly.
    const double x = rotation.x;
    const double y = rotation.y;
    const double z = rotation.z;
    const double w = rotation.w;
    const double xx = x * x;
    const double yy = y * y;
    const double zz = z * z;
    const double xy = x * y;
    const double xz = x * z;
    const double yz = y * z;
    const double wx = w * x;
    const double wy = w * y;
    const double wz = w * z;
    const double sx = scale.x;
    const double sy = scale.y;
    const double sz = scale.z;
    Matrix result = identity_matrix();
    result[0] = static_cast<float>((1.0 - 2.0 * (yy + zz)) * sx);
    result[1] = static_cast<float>(2.0 * (xy + wz) * sx);
    result[2] = static_cast<float>(2.0 * (xz - wy) * sx);
    result[4] = static_cast<float>(2.0 * (xy - wz) * sy);
    result[5] = static_cast<float>((1.0 - 2.0 * (xx + zz)) * sy);
    result[6] = static_cast<float>(2.0 * (yz + wx) * sy);
    result[8] = static_cast<float>(2.0 * (xz + wy) * sz);
    result[9] = static_cast<float>(2.0 * (yz - wx) * sz);
    result[10] = static_cast<float>((1.0 - 2.0 * (xx + yy)) * sz);
    result[12] = translation.x;
    result[13] = translation.y;
    result[14] = translation.z;
    return result;
}`;

const expectedMatrixNative = `Matrix native_matrix(const Matrix& matrix) {
    Matrix result{};
    for (std::size_t column = 0; column < 4; ++column) {
        for (std::size_t row = 0; row < 4; ++row) {
            const float row_sign = row == 0 ? -1.0f : 1.0f;
            const float column_sign =
                column == 0 ? -1.0f : 1.0f;
            result[column * 4 + row] =
                matrix[column * 4 + row] *
                row_sign *
                column_sign;
        }
    }
    return result;
}`;

const expectedIblPolynomial = `    const float intensity =
        float_or(light, "intensity", 1.0f);
    const float scale = intensity / pi;
    const float inverse_pi = 1.0f / pi;
    std::array<Color3, 9> source{};
    for (
        std::size_t coefficient = 0;
        coefficient < source.size();
        ++coefficient) {
        const std::vector<float> values =
            float_array(&coefficients[coefficient]);
        if (values.size() != 3) {
            throw std::runtime_error(
                "Image-based light irradiance coefficient must be vec3.");
        }
        source[coefficient] = Color3{
            values[0] * scale,
            values[1] * scale,
            values[2] * scale,
        };
    }
    std::array<Color3, 9> polynomial{};
    for (int channel = 0; channel < 3; ++channel) {
        const float l00 =
            color_channel(source[0], channel);
        const float l1_1 =
            color_channel(source[1], channel);
        const float l10 =
            color_channel(source[2], channel);
        const float l11 =
            color_channel(source[3], channel);
        const float l2_2 =
            color_channel(source[4], channel);
        const float l2_1 =
            color_channel(source[5], channel);
        const float l20 =
            color_channel(source[6], channel);
        const float l21 =
            color_channel(source[7], channel);
        const float l22 =
            color_channel(source[8], channel);
        set_color_channel(
            polynomial[0],
            channel,
            -1.02333f * l11 * inverse_pi);
        set_color_channel(
            polynomial[1],
            channel,
            -1.02333f * l1_1 * inverse_pi);
        set_color_channel(
            polynomial[2],
            channel,
            1.02333f * l10 * inverse_pi);
        set_color_channel(
            polynomial[3],
            channel,
            (
                0.886277f * l00 -
                0.247708f * l20 +
                0.429043f * l22) *
                inverse_pi);
        set_color_channel(
            polynomial[4],
            channel,
            (
                0.886277f * l00 -
                0.247708f * l20 -
                0.429043f * l22) *
                inverse_pi);
        set_color_channel(
            polynomial[5],
            channel,
            (
                0.886277f * l00 +
                0.495417f * l20) *
                inverse_pi);
        set_color_channel(
            polynomial[6],
            channel,
            -0.858086f * l2_1 * inverse_pi);
        set_color_channel(
            polynomial[7],
            channel,
            -0.858086f * l21 * inverse_pi);
        set_color_channel(
            polynomial[8],
            channel,
            0.858086f * l2_2 * inverse_pi);
    }`;

const expectedIblEnvironmentScalars = `    environment.lod_generation_scale =
        specular_images.size() > 1
            ? static_cast<float>(
                  specular_images.size() - 1) /
                  std::log2(
                      static_cast<float>(
                          environment.specular_width))
            : 0.0f;
    const std::vector<float> rotation =
        float_array(optional(light, "rotation"));
    if (rotation.size() == 4) {
        environment.rotation_y =
            -2.0f *
            std::atan2(rotation[1], rotation[3]);
    }
    environment.brdf_lut.bytes =
        pal::read_binary_file(
            asset_path(
                "gltf-ibl-brdf-lut.rgba16f"));
    environment.brdf_lut_width = 256;
    environment.brdf_lut_rgba16f = true;`;

const expectedPunctualLightLoading = `                const std::string type =
                    string_or(definition, "type");
                if (
                    type != "point" &&
                    type != "directional" &&
                    type != "spot") {
                    continue;
                }
                const Matrix& light_world =
                    compute_world(node_index);
                LightRecord light;
                light.kind = type == "point"
                    ? LightKind::point
                    : type == "spot"
                        ? LightKind::spot
                        : LightKind::directional;
                if (type == "spot") {
                    // createSpotLight(position, direction, outer * 2, 1,
                    // intensity): the pinned loader passes twice the outer
                    // cone angle as the full cone, and the light stores
                    // cos(angle / 2). innerConeAngle is read by neither the
                    // pinned light nor its pointer handlers.
                    const ts::JsonValue* spot_value =
                        optional(definition, "spot");
                    const float outer_cone_angle = spot_value
                        ? float_or(
                              spot_value->as_object(),
                              "outerConeAngle",
                              0.7853981633974483f)
                        : 0.7853981633974483f;
                    light.cos_half_angle =
                        std::cos(outer_cone_angle);
                }
                light.position = Vec3{
                    -light_world[12],
                    light_world[13],
                    light_world[14],
                };
                const Vec3 forward{
                    light_world[8],
                    -light_world[9],
                    -light_world[10],
                };
                light.direction =
                    normalize(forward);
                const std::vector<float> color =
                    float_array(
                        optional(
                            definition,
                            "color"));
                light.diffuse_color = color.size() == 3
                    ? Color3{
                          color[0],
                          color[1],
                          color[2],
                      }
                    : Color3{1.0f, 1.0f, 1.0f};
                light.specular_color =
                    light.diffuse_color;
                light.intensity =
                    float_or(
                        definition,
                        "intensity",
                        1.0f);
                light.range =
                    float_or(
                        definition,
                        "range",
                        std::numeric_limits<float>::max());`;

test("lowers the pinned matrix multiply byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerMatrixMultiplyCpp(pinnedFile(multiplyModule)),
        expectedMatrixMultiply,
    );
});

test("lowers the pinned TRS compose byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerMatrixComposeCpp(pinnedFile(composeModule)),
        expectedMatrixCompose,
    );
});

test("lowers the native change of basis byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerMatrixNativeCpp(pinnedFile(parserModule)),
        expectedMatrixNative,
    );
});

test("lowers the pinned IBL polynomial byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerIblPolynomialCpp(pinnedFile(imageBasedModule)),
        expectedIblPolynomial,
    );
});

test("lowers the pinned IBL environment scalars byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerIblEnvironmentScalarsCpp(
            pinnedFile(imageBasedModule),
            pinnedFile(assemblyModule),
        ),
        expectedIblEnvironmentScalars,
    );
});

test("lowers the pinned punctual light build byte-identically to the shipped loader text", () => {
    assert.equal(
        lowerPunctualLightsCpp(
            pinnedFile(punctualModule),
            pinnedFile(spotLightModule),
            pinnedFile(parserModule),
        ),
        expectedPunctualLightLoading,
    );
});

test("the emitted loader carries every round-3 lowered segment", () => {
    const adapter = new GltfLowerer(new LoweringContext(store))
        .lowerLoaderAdapter();
    for (const segment of [
        expectedMatrixMultiply,
        expectedMatrixCompose,
        expectedMatrixNative,
        expectedIblPolynomial,
        expectedIblEnvironmentScalars,
        expectedPunctualLightLoading,
    ]) {
        assert.ok(
            adapter.source.includes(segment),
            "the emitted loader no longer carries a round-3 segment",
        );
    }
});

test("a re-associated pinned matrix product refuses generation", () => {
    assert.throws(
        () =>
            lowerMatrixMultiplyCpp(
                mutatedFile(
                    multiplyModule,
                    "dst[d] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;",
                    "dst[d] = a4 * b1 + a0 * b0 + a8 * b2 + a12 * b3;",
                ),
            ),
        /canonical column-major product/,
    );
});

test("a changed compose product flows into the emitted bytes", () => {
    const lowered = lowerMatrixComposeCpp(
        mutatedFile(
            composeModule,
            "dst[off + 1] = 2 * (xy + wz) * sx;",
            "dst[off + 1] = 2 * (xy - wz) * sx;",
        ),
    );
    assert.notEqual(lowered, expectedMatrixCompose);
    assert.match(
        lowered,
        /result\[1\] = static_cast<float>\(2\.0 \* \(xy - wz\) \* sx\);/,
    );
});

test("a compose lane that stops being identity refuses", () => {
    assert.throws(
        () =>
            lowerMatrixComposeCpp(
                mutatedFile(
                    composeModule,
                    "dst[off + 3] = 0;",
                    "dst[off + 3] = 5;",
                ),
            ),
        /no longer keeps the identity value in lane 3/,
    );
});

test("a moved RH-to-LH flip axis flows into the ladder and the light signs", () => {
    const doctored = mutatedFile(
        parserModule,
        "new F32([-1, 0, 0, 0,  0, 1, 0, 0,",
        "new F32([1, 0, 0, 0,  0, -1, 0, 0,",
    );
    const native = lowerMatrixNativeCpp(doctored);
    assert.match(native, /row == 1 \? -1\.0f : 1\.0f;/);
    const lights = lowerPunctualLightsCpp(
        pinnedFile(punctualModule),
        pinnedFile(spotLightModule),
        doctored,
    );
    // The pin's +column-3 / -column-2 reads, folded through the moved
    // diagonal: the x lanes stop flipping and the y lanes start.
    assert.ok(lights.includes("                    light_world[12],"));
    assert.ok(lights.includes("                    -light_world[13],"));
    assert.ok(lights.includes("                    -light_world[8],"));
    assert.ok(lights.includes("                    light_world[9],"));
});

test("a root that stops flipping exactly one axis refuses", () => {
    assert.throws(
        () =>
            lowerMatrixNativeCpp(
                mutatedFile(
                    parserModule,
                    "F32([-1, 0, 0, 0,  0, 1,",
                    "F32([1, 0, 0, 0,  0, 1,",
                ),
            ),
        /no longer flips exactly one axis/,
    );
});

test("a changed IBL band constant flows into the emitted bytes", () => {
    const lowered = lowerIblPolynomialCpp(
        mutatedFile(
            imageBasedModule,
            "-1.02333 * l11 * k",
            "-1.04333 * l11 * k",
        ),
    );
    assert.notEqual(lowered, expectedIblPolynomial);
    assert.match(lowered, /-1\.04333f \* l11 \* inverse_pi\);/);
});

test("a changed IBL intensity default flows into the emitted bytes", () => {
    const lowered = lowerIblPolynomialCpp(
        mutatedFile(
            imageBasedModule,
            "light.intensity ?? 1",
            "light.intensity ?? 2",
        ),
    );
    assert.match(lowered, /float_or\(light, "intensity", 2\.0f\);/);
});

test("an IBL coefficient read without the prescale refuses", () => {
    assert.throws(
        () =>
            lowerIblPolynomialCpp(
                mutatedFile(
                    imageBasedModule,
                    "const l2_2 = coeffs[4]![c]! * s;",
                    "const l2_2 = coeffs[4]![c]!;",
                ),
            ),
        /no longer scales coefficient 4 by the prescale/,
    );
});

test("a permuted IBL polynomial slot refuses", () => {
    assert.throws(
        () =>
            lowerIblPolynomialCpp(
                mutatedFile(
                    imageBasedModule,
                    "poly[18 + c]",
                    "poly[19 + c]",
                ),
            ),
        /no longer stores polynomial slot 6/,
    );
});

test("a changed yaw factor and lane flow into the emitted bytes", () => {
    const lowered = lowerIblEnvironmentScalarsCpp(
        mutatedFile(
            imageBasedModule,
            "return -2 * Math.atan2(q[1], q[3]);",
            "return -3 * Math.atan2(q[0], q[3]);",
        ),
        pinnedFile(assemblyModule),
    );
    assert.notEqual(lowered, expectedIblEnvironmentScalars);
    assert.match(
        lowered,
        /-3\.0f \*\n {12}std::atan2\(rotation\[0\], rotation\[3\]\);/,
    );
});

test("a changed BRDF LUT size flows into the emitted bytes", () => {
    const lowered = lowerIblEnvironmentScalarsCpp(
        pinnedFile(imageBasedModule),
        mutatedFile(assemblyModule, "const size = 256;", "const size = 512;"),
    );
    assert.match(lowered, /environment\.brdf_lut_width = 512;/);
});

test("a changed LOD mip drop flows into the guard and the numerator", () => {
    const lowered = lowerIblEnvironmentScalarsCpp(
        mutatedFile(
            imageBasedModule,
            "(mipCount - 1) / Math.log2(specularImageSize)",
            "(mipCount - 2) / Math.log2(specularImageSize)",
        ),
        pinnedFile(assemblyModule),
    );
    assert.match(lowered, /specular_images\.size\(\) > 2/);
    assert.match(lowered, /specular_images\.size\(\) - 2\)/);
});

test("a yaw gate whose absent case stops being zero refuses", () => {
    assert.throws(
        () =>
            lowerIblEnvironmentScalarsCpp(
                mutatedFile(
                    imageBasedModule,
                    "light.rotation ? envYawFromQuaternion(light.rotation) : 0",
                    "light.rotation ? envYawFromQuaternion(light.rotation) : 1",
                ),
                pinnedFile(assemblyModule),
            ),
        /zero fallback/,
    );
});

test("a changed spot cone default flows into both emitted arms", () => {
    const lowered = lowerPunctualLightsCpp(
        mutatedFile(
            punctualModule,
            "def.spot?.outerConeAngle ?? Math.PI / 4",
            "def.spot?.outerConeAngle ?? Math.PI / 6",
        ),
        pinnedFile(spotLightModule),
        pinnedFile(parserModule),
    );
    const occurrences = lowered.split("0.5235987755982988f").length - 1;
    assert.equal(occurrences, 2);
});

test("a changed punctual intensity default flows into the emitted bytes", () => {
    const lowered = lowerPunctualLightsCpp(
        mutatedFile(punctualModule, "def.intensity ?? 1", "def.intensity ?? 3"),
        pinnedFile(spotLightModule),
        pinnedFile(parserModule),
    );
    assert.match(lowered, /"intensity",\n {24}3\.0f\);/);
});

test("a changed punctual color fallback flows into the emitted bytes", () => {
    const lowered = lowerPunctualLightsCpp(
        mutatedFile(punctualModule, ": [1, 1, 1];", ": [1, 0.5, 1];"),
        pinnedFile(spotLightModule),
        pinnedFile(parserModule),
    );
    assert.match(lowered, /Color3\{1\.0f, 0\.5f, 1\.0f\};/);
});

test("a punctual range default that stops being MAX_VALUE refuses", () => {
    assert.throws(
        () =>
            lowerPunctualLightsCpp(
                mutatedFile(
                    punctualModule,
                    "def.range !== undefined ? def.range : Number.MAX_VALUE",
                    "def.range !== undefined ? def.range : 1000",
                ),
                pinnedFile(spotLightModule),
                pinnedFile(parserModule),
            ),
        /MAX_VALUE default/,
    );
});

test("a spot doubling the light cosine no longer cancels refuses", () => {
    assert.throws(
        () =>
            lowerPunctualLightsCpp(
                mutatedFile(
                    punctualModule,
                    "createSpotLight([px, py, pz], dir, outer * 2, 1, intensity)",
                    "createSpotLight([px, py, pz], dir, outer * 3, 1, intensity)",
                ),
                pinnedFile(spotLightModule),
                pinnedFile(parserModule),
            ),
        /no longer cancels the full-cone doubling/,
    );
});

test("a light type with no record kind refuses", () => {
    assert.throws(
        () =>
            lowerPunctualLightsCpp(
                mutatedFileAll(punctualModule, '"directional"', '"ambient"'),
                pinnedFile(spotLightModule),
                pinnedFile(parserModule),
            ),
        /'ambient', which has no record kind/,
    );
});

/* ───────────────────────────── round 4 ───────────────────────────── */

const materialModule = "src/loader-gltf/gltf-material.ts";
const uvTransformModule = "src/loader-gltf/gltf-ext-uv-transform.ts";
const uvWriterModule =
    "src/material/pbr/fragments/uv-transform-fragment.ts";
const clearcoatModule = "src/loader-gltf/gltf-ext-clearcoat.ts";
const sheenModule = "src/loader-gltf/gltf-ext-sheen.ts";
const strengthModule =
    "src/loader-gltf/gltf-ext-emissive-strength.ts";

/**
 * The resolved local_matrix decision: the same pinned compose the
 * `trs_matrix` leaf lowers, but over the RAW JSON doubles with one
 * float rounding per lane at the store — the pin's own precision
 * chain (`computeNodeWorldMatrix` composes `node.translation ?? …`
 * straight into an F32 scratch). This replaces the old float-over-
 * `float_array` transcription, whose last-ulp divergence round 3
 * measured and reported.
 */
const expectedMatrixLocal = `Matrix local_matrix(const JsonObject& node) {
    if (const ts::JsonValue* matrix_value = optional(node, "matrix")) {
        const std::vector<float> values = float_array(matrix_value);
        if (values.size() != 16) throw std::runtime_error("glTF node matrix must have 16 values.");
        Matrix result{};
        std::copy(values.begin(), values.end(), result.begin());
        return result;
    }
    // Pinned computeNodeWorldMatrix hands mat4ComposeInto the raw
    // JSON doubles and the F32-backed scratch store rounds each lane
    // exactly once. Camera-precision rule: round where the pin's
    // Float32Array stores are, never earlier — floats rounded at the
    // JSON read and composed in float diverge in the last ulps (an
    // exact 90-degree yaw lands m[0] at 5.96e-8f where the pin
    // stores -2.22e-16f).
    const std::vector<double> translation = double_array(optional(node, "translation"));
    const std::vector<double> rotation = double_array(optional(node, "rotation"));
    const std::vector<double> scale = double_array(optional(node, "scale"));
    const double tx = translation.size() == 3 ? translation[0] : 0.0;
    const double ty = translation.size() == 3 ? translation[1] : 0.0;
    const double tz = translation.size() == 3 ? translation[2] : 0.0;
    const double x = rotation.size() == 4 ? rotation[0] : 0.0;
    const double y = rotation.size() == 4 ? rotation[1] : 0.0;
    const double z = rotation.size() == 4 ? rotation[2] : 0.0;
    const double w = rotation.size() == 4 ? rotation[3] : 1.0;
    const double sx = scale.size() == 3 ? scale[0] : 1.0;
    const double sy = scale.size() == 3 ? scale[1] : 1.0;
    const double sz = scale.size() == 3 ? scale[2] : 1.0;
    const double xx = x * x;
    const double yy = y * y;
    const double zz = z * z;
    const double xy = x * y;
    const double xz = x * z;
    const double yz = y * z;
    const double wx = w * x;
    const double wy = w * y;
    const double wz = w * z;
    Matrix result = identity_matrix();
    result[0] = static_cast<float>((1.0 - 2.0 * (yy + zz)) * sx);
    result[1] = static_cast<float>(2.0 * (xy + wz) * sx);
    result[2] = static_cast<float>(2.0 * (xz - wy) * sx);
    result[4] = static_cast<float>(2.0 * (xy - wz) * sy);
    result[5] = static_cast<float>((1.0 - 2.0 * (xx + zz)) * sy);
    result[6] = static_cast<float>(2.0 * (yz + wx) * sy);
    result[8] = static_cast<float>(2.0 * (xz + wy) * sz);
    result[9] = static_cast<float>(2.0 * (yz - wx) * sz);
    result[10] = static_cast<float>((1.0 - 2.0 * (xx + yy)) * sz);
    result[12] = static_cast<float>(tx);
    result[13] = static_cast<float>(ty);
    result[14] = static_cast<float>(tz);
    return result;
}`;

function materialDefaultFiles(
    overrides: Partial<Record<
        | "material"
        | "dielectric"
        | "uvTransform"
        | "uvTransformWriter"
        | "clearcoat"
        | "sheen"
        | "emissiveStrength",
        ts.SourceFile
    >> = {},
): Parameters<typeof lowerGltfMaterialDefaults>[0] {
    return {
        material: overrides.material ?? pinnedFile(materialModule),
        dielectric: overrides.dielectric ?? pinnedFile(dielectricModule),
        uvTransform: overrides.uvTransform ??
            pinnedFile(uvTransformModule),
        uvTransformWriter: overrides.uvTransformWriter ??
            pinnedFile(uvWriterModule),
        clearcoat: overrides.clearcoat ?? pinnedFile(clearcoatModule),
        sheen: overrides.sheen ?? pinnedFile(sheenModule),
        emissiveStrength: overrides.emissiveStrength ??
            pinnedFile(strengthModule),
    };
}

test("lowers local_matrix through the pin's own precision chain byte-for-byte", () => {
    assert.equal(
        lowerLocalMatrixCpp(
            pinnedFile(parserModule),
            pinnedFile(composeModule),
        ),
        expectedMatrixLocal,
    );
});

test("the emitted loader carries the lowered local matrix and no inverse_affine", () => {
    const adapter = new GltfLowerer(new LoweringContext(store))
        .lowerLoaderAdapter();
    assert.ok(adapter.source.includes(expectedMatrixLocal));
    assert.ok(adapter.source.includes("std::vector<double> double_array"));
    // Dead in all 44 generated loaders and matching no pinned formula;
    // deleted by the round-4 decision.
    assert.ok(!adapter.source.includes("inverse_affine"));
});

test("a changed compose product flows into trs_matrix and local_matrix alike", () => {
    const doctored = mutatedFile(
        composeModule,
        "dst[off + 1] = 2 * (xy + wz) * sx;",
        "dst[off + 1] = 2 * (xy - wz) * sx;",
    );
    const local = lowerLocalMatrixCpp(pinnedFile(parserModule), doctored);
    assert.notEqual(local, expectedMatrixLocal);
    assert.match(
        local,
        /result\[1\] = static_cast<float>\(2\.0 \* \(xy - wz\) \* sx\);/,
    );
    assert.match(
        lowerMatrixComposeCpp(doctored),
        /result\[1\] = static_cast<float>\(2\.0 \* \(xy - wz\) \* sx\);/,
    );
});

test("a changed pinned TRS default flows into the emitted lanes", () => {
    const local = lowerLocalMatrixCpp(
        mutatedFile(
            parserModule,
            "node.rotation ?? [0, 0, 0, 1]",
            "node.rotation ?? [0, 0, 0, 2]",
        ),
        pinnedFile(composeModule),
    );
    assert.match(local, /rotation\[3\] : 2\.0;/);
});

test("a compose call that reorders the raw JSON lanes refuses", () => {
    assert.throws(
        () =>
            lowerLocalMatrixCpp(
                mutatedFile(
                    parserModule,
                    "t[0], t[1], t[2], r[0], r[1], r[2], r[3], s[0], s[1], s[2]",
                    "t[0], t[1], t[2], r[1], r[0], r[2], r[3], s[0], s[1], s[2]",
                ),
                pinnedFile(composeModule),
            ),
        /no longer reads the raw JSON lanes in parameter order/,
    );
});

test("an authored-matrix arm that stops copying into a Float32Array refuses", () => {
    assert.throws(
        () =>
            lowerLocalMatrixCpp(
                mutatedFile(
                    parserModule,
                    "new F32(node.matrix)",
                    "new F64(node.matrix)",
                ),
                pinnedFile(composeModule),
            ),
        /no longer copies the authored matrix into a fresh Float32Array/,
    );
});

test("lowers the pinned material defaults to the shipped keys and constants", () => {
    assert.deepEqual(lowerGltfMaterialDefaults(materialDefaultFiles()), {
        baseColorFactorKey: "baseColorFactor",
        metallicFactor: { key: "metallicFactor", literal: "1.0f" },
        roughnessFactor: { key: "roughnessFactor", literal: "1.0f" },
        emissiveFactor: {
            key: "emissiveFactor",
            identity: "Color3{0.0f, 0.0f, 0.0f}",
        },
        normalScale: { key: "scale", literal: "1.0f" },
        occlusionTexCoord: { key: "texCoord", literal: "0" },
        alphaMode: { key: "alphaMode", literal: "OPAQUE" },
        doubleSidedKey: "doubleSided",
        alphaCutoff: { key: "alphaCutoff", literal: "0.5f" },
        specularFactor: {
            key: "specularFactor",
            clear: "1.0f",
            epsilon: "0.000001f",
        },
        iorToF0: { one: "1.0f", baseReflectance: "0.04f" },
        specularColor: {
            key: "specularColorFactor",
            length: "3",
            unit: "1.0f",
        },
        textureTransform: {
            rotation: { key: "rotation", literal: "0.0f" },
            scaleKey: "scale",
            offsetKey: "offset",
        },
        clearcoatIntensity: {
            key: "clearcoatFactor",
            present: "1.0f",
            absent: "0.0f",
        },
        clearcoatRoughness: {
            key: "clearcoatRoughnessFactor",
            present: "1.0f",
            absent: "0.0f",
        },
        clearcoatNormalScale: { key: "scale", literal: "1.0f" },
        sheenColor: {
            key: "sheenColorFactor",
            identity: "Color3{0.0f, 0.0f, 0.0f}",
        },
        sheenRoughness: { key: "sheenRoughnessFactor", literal: "0.0f" },
        sheenIntensity: "1.0f",
        emissiveStrength: { key: "emissiveStrength", literal: "1.0f" },
    });
});

test("the emitted loader carries every round-4 lowered default", () => {
    const adapter = new GltfLowerer(new LoweringContext(store))
        .lowerLoaderAdapter();
    for (const line of [
        'material.metallic_factor = float_or(pbr, "metallicFactor", 1.0f);',
        'material.roughness_factor = float_or(pbr, "roughnessFactor", 1.0f);',
        'material.alpha_cutoff = float_or(material_json, "alphaCutoff", 0.5f);',
        'slot.rotation = float_or(transform, "rotation", 0.0f);',
        'float_or(normal_texture->as_object(), "scale", 1.0f);',
        "material.emissive_factor = Color3{0.0f, 0.0f, 0.0f};",
        'float_array(optional(pbr, "baseColorFactor"));',
        'float_array(optional(material_json, "emissiveFactor"));',
        '"clearcoatFactor",\n                clearcoat_texture ? 1.0f : 0.0f);',
        '"sheenRoughnessFactor",\n                0.0f);',
        "material.sheen_intensity = 1.0f;",
        '"emissiveStrength",\n                1.0f);',
        '"texCoord",\n            0);',
        'string_or(material_json, "alphaMode", "OPAQUE");',
        'bool_or(material_json, "doubleSided", false);',
    ]) {
        assert.ok(
            adapter.source.includes(line),
            `the emitted loader no longer carries '${line}'`,
        );
    }
    const specular = new GltfLowerer(new LoweringContext(store))
        .lowerLoaderAdapter(
            false,
            false,
            false,
            false,
            false,
            false,
            true,
        );
    for (const line of [
        'float_or(specular, "specularFactor", 1.0f);',
        "std::abs(factor - 1.0f) > 0.000001f ? factor : 1.0f;",
    ]) {
        assert.ok(
            specular.source.includes(line),
            `the specular loader no longer carries '${line}'`,
        );
    }
});

test("a changed metallic default flows into the emitted keys", () => {
    const defaults = lowerGltfMaterialDefaults(materialDefaultFiles({
        material: mutatedFile(
            materialModule,
            "pbr.metallicFactor ?? 1",
            "pbr.metallicFactor ?? 0.5",
        ),
    }));
    assert.deepEqual(defaults.metallicFactor, {
        key: "metallicFactor",
        literal: "0.5f",
    });
});

test("a changed emissive default flows into the emitted identity seed", () => {
    const defaults = lowerGltfMaterialDefaults(materialDefaultFiles({
        material: mutatedFile(
            materialModule,
            "mat.emissiveFactor ?? [0, 0, 0]",
            "mat.emissiveFactor ?? [1, 0, 0]",
        ),
    }));
    assert.equal(
        defaults.emissiveFactor.identity,
        "Color3{1.0f, 0.0f, 0.0f}",
    );
});

test("a moved base color default refuses instead of flowing", () => {
    // The absent arm is the record's native Color4{1,1,1,1}
    // (runtime.hpp), which this emitter cannot regenerate.
    assert.throws(
        () =>
            lowerGltfMaterialDefaults(materialDefaultFiles({
                material: mutatedFile(
                    materialModule,
                    "pbr.baseColorFactor ?? [1, 1, 1, 1]",
                    "pbr.baseColorFactor ?? [1, 1, 1, 0.5]",
                ),
            })),
        /native \{1,1,1,1\}/,
    );
});

test("a new material default no entry consumes refuses", () => {
    assert.throws(
        () =>
            lowerGltfMaterialDefaults(materialDefaultFiles({
                material: mutatedFile(
                    materialModule,
                    "_alphaCutoff: mat.alphaCutoff ?? 0.5,",
                    "_alphaCutoff: mat.alphaCutoff ?? 0.5,\n        _halo: mat.halo ?? 7,",
                ),
            })),
        /defaults '_halo', which no lowering entry consumes/,
    );
});

test("a changed specular epsilon flows through both pinned sites", () => {
    const defaults = lowerGltfMaterialDefaults(materialDefaultFiles({
        dielectric: mutatedFileAll(
            dielectricModule,
            "Math.abs(eSp.specularFactor - 1) > 1e-6",
            "Math.abs(eSp.specularFactor - 1) > 1e-5",
        ),
    }));
    assert.equal(defaults.specularFactor.epsilon, "0.00001f");
});

test("specular sites that disagree on the clearing test refuse", () => {
    assert.throws(
        () =>
            lowerGltfMaterialDefaults(materialDefaultFiles({
                dielectric: mutatedFile(
                    dielectricModule,
                    "Math.abs(eSp.specularFactor - 1) > 1e-6",
                    "Math.abs(eSp.specularFactor - 1) > 1e-5",
                ),
            })),
        /no longer agrees with itself on the specular clearing test/,
    );
});

test("a moved texture-transform identity refuses against the record", () => {
    // The wholly-absent transform keeps the native
    // TextureTransform{1, 1, 0, 0, 0} (runtime.hpp); a moved writer
    // default would leave that arm silently wrong.
    assert.throws(
        () =>
            lowerGltfMaterialDefaults(materialDefaultFiles({
                uvTransformWriter: mutatedFile(
                    uvWriterModule,
                    "const ang = tex?.uAng ?? 0;",
                    "const ang = tex?.uAng ?? 0.5;",
                ),
            })),
        /TextureTransform identity 0 \(runtime\.hpp\)/,
    );
});

test("a clearcoat fallback conditioned on the wrong texture refuses", () => {
    assert.throws(
        () =>
            lowerGltfMaterialDefaults(materialDefaultFiles({
                clearcoat: mutatedFile(
                    clearcoatModule,
                    "c.clearcoatFactor ?? (c.clearcoatTexture ? 1 : 0)",
                    "c.clearcoatFactor ?? (c.clearcoatRoughnessTexture ? 1 : 0)",
                ),
            })),
        /no longer conditions the 'intensity' fallback on 'clearcoatTexture'/,
    );
});

test("a changed clearcoat absent arm flows into the emitted keys", () => {
    const defaults = lowerGltfMaterialDefaults(materialDefaultFiles({
        clearcoat: mutatedFile(
            clearcoatModule,
            "c.clearcoatRoughnessFactor ?? (c.clearcoatRoughnessTexture ? 1 : 0)",
            "c.clearcoatRoughnessFactor ?? (c.clearcoatRoughnessTexture ? 1 : 0.25)",
        ),
    }));
    assert.equal(defaults.clearcoatRoughness.absent, "0.25f");
});

test("a changed sheen roughness default flows into the emitted keys", () => {
    const defaults = lowerGltfMaterialDefaults(materialDefaultFiles({
        sheen: mutatedFile(
            sheenModule,
            "s.sheenRoughnessFactor ?? 0",
            "s.sheenRoughnessFactor ?? 0.3",
        ),
    }));
    assert.deepEqual(defaults.sheenRoughness, {
        key: "sheenRoughnessFactor",
        literal: "0.3f",
    });
});

test("a changed emissive strength default flows into the emitted keys", () => {
    const defaults = lowerGltfMaterialDefaults(materialDefaultFiles({
        emissiveStrength: mutatedFile(
            strengthModule,
            "e.emissiveStrength ?? 1.0",
            "e.emissiveStrength ?? 3",
        ),
    }));
    assert.deepEqual(defaults.emissiveStrength, {
        key: "emissiveStrength",
        literal: "3.0f",
    });
});

/* ─────────────── round 4 — factor bakes and the specular surround ─────────────── */

const colorModulePath = "src/math/color.ts";
const builderModule = "src/loader-gltf/gltf-pbr-builder.ts";

/**
 * What the loader template carried by hand before the lowering, minus
 * the never-called `quantized_unorm_factor` float variant the deletion
 * batch trimmed.
 */
const expectedFactorBakeHelpers = `// Babylon Lite bakes texture-less PBR factors into 1x1 factor
// textures (gltf-pbr-builder uploadBaseColorFactorTexture /
// uploadOrmFactorTexture) and leaves the shader uniforms at their
// defaults, so the browser shades with the 8-bit quantized values.
// Bake the record factors to the same rounded byte, which is what
// the pinned factor texture holds.
std::uint8_t unorm_byte(float value) {
    return static_cast<std::uint8_t>(
        std::round(std::clamp(value, 0.0f, 1.0f) * 255.0f));
}

std::uint8_t linear_to_srgb_byte(float value) {
    // Pinned linearToSrgbByte: the byte lands in an rgba8unorm-srgb
    // texel whose hardware decode is the browser's effective value.
    const double clamped = std::clamp(
        static_cast<double>(value),
        0.0,
        1.0);
    const double encoded = clamped <= 0.0031308
        ? clamped * 12.92
        : 1.055 * std::pow(clamped, 1.0 / 2.4) - 0.055;
    return static_cast<std::uint8_t>(
        std::round(encoded * 255.0));
}`;

test("lowers the pinned factor bakes byte-identically to the shipped loader text", () => {
    assert.deepEqual(
        lowerGltfFactorBake(
            pinnedFile(colorModulePath),
            pinnedFile(builderModule),
        ),
        {
            helpers: expectedFactorBakeHelpers,
            unormClampLo: "0.0f",
            unormClampHi: "1.0f",
            unormScale: "255.0f",
            opaqueByte: "255",
        },
    );
});

test("the emitted loader carries the factor bakes and the specular surround", () => {
    const adapter = new GltfLowerer(new LoweringContext(store))
        .lowerLoaderAdapter();
    assert.ok(adapter.source.includes(expectedFactorBakeHelpers));
    for (const line of [
        "                255,\n                unorm_byte(material.roughness_factor),",
        "unorm_byte(material.metallic_factor),\n                255,",
        "                                0.0f,\n                                1.0f) *\n                            255.0f)),",
        "(material.index_of_refraction - 1.0f) /",
        "(material.index_of_refraction + 1.0f);",
    ]) {
        assert.ok(
            adapter.source.includes(line),
            `the emitted loader no longer carries '${line}'`,
        );
    }
    const specular = new GltfLowerer(new LoweringContext(store))
        .lowerLoaderAdapter(
            false,
            false,
            false,
            false,
            false,
            false,
            true,
        );
    for (const line of [
        "const float base_reflectance = 0.04f;",
        'optional(specular, "specularColorFactor"));',
        "specular_color.size() == 3 &&",
        "(specular_color[0] != 1.0f ||",
        " specular_color[1] != 1.0f ||",
        " specular_color[2] != 1.0f))",
    ]) {
        assert.ok(
            specular.source.includes(line),
            `the specular loader no longer carries '${line}'`,
        );
    }
});

test("a changed sRGB threshold flows into the emitted bytes", () => {
    const bake = lowerGltfFactorBake(
        mutatedFile(
            colorModulePath,
            "c <= 0.0031308 ? c * 12.92",
            "c <= 0.0041308 ? c * 12.92",
        ),
        pinnedFile(builderModule),
    );
    assert.notEqual(bake.helpers, expectedFactorBakeHelpers);
    assert.match(bake.helpers, /clamped <= 0\.0041308/);
});

test("a changed sRGB exponent flows into the emitted bytes", () => {
    const bake = lowerGltfFactorBake(
        mutatedFile(colorModulePath, "Math.pow(c, 1 / 2.4)", "Math.pow(c, 1 / 2.2)"),
        pinnedFile(builderModule),
    );
    assert.match(bake.helpers, /std::pow\(clamped, 1\.0 \/ 2\.2\)/);
});

test("a changed unorm scale flows through the helpers and the alpha lane", () => {
    const bake = lowerGltfFactorBake(
        pinnedFile(colorModulePath),
        mutatedFileEdits(builderModule, [
            [
                "Math.round(Math.max(0, Math.min(1, value)) * 255)",
                "Math.round(Math.max(0, Math.min(1, value)) * 127)",
            ],
            [
                "Math.round(Math.max(0, Math.min(1, factor[3]!)) * 255)",
                "Math.round(Math.max(0, Math.min(1, factor[3]!)) * 127)",
            ],
        ]),
    );
    assert.equal(bake.unormScale, "127.0f");
    assert.match(
        bake.helpers,
        /std::clamp\(value, 0\.0f, 1\.0f\) \* 127\.0f/,
    );
});

test("factor bakes that split the unorm rounding refuse", () => {
    // The ORM closure and the base-color alpha lane are one pinned
    // rounding; a value moved in only one is a pin defect to surface.
    assert.throws(
        () =>
            lowerGltfFactorBake(
                pinnedFile(colorModulePath),
                mutatedFile(
                    builderModule,
                    "Math.round(Math.max(0, Math.min(1, value)) * 255)",
                    "Math.round(Math.max(0, Math.min(1, value)) * 127)",
                ),
            ),
        /no longer shares one unorm rounding/,
    );
});

test("a swapped ORM bake lane refuses", () => {
    assert.throws(
        () =>
            lowerGltfFactorBake(
                pinnedFile(colorModulePath),
                mutatedFile(
                    builderModule,
                    "new U8([255, clamp(roughness), clamp(metallic), 255])",
                    "new U8([255, clamp(metallic), clamp(roughness), 255])",
                ),
            ),
        /no longer bakes 'roughness' through the clamp in its pinned lane/,
    );
});

test("a changed base reflectance flows into the emitted keys", () => {
    const defaults = lowerGltfMaterialDefaults(materialDefaultFiles({
        dielectric: mutatedFile(
            dielectricModule,
            "((ior - 1) / (ior + 1)) ** 2 / 0.04",
            "((ior - 1) / (ior + 1)) ** 2 / 0.05",
        ),
    }));
    assert.deepEqual(defaults.iorToF0, {
        one: "1.0f",
        baseReflectance: "0.05f",
    });
});

test("an IOR fold that stops squaring refuses", () => {
    assert.throws(
        () =>
            lowerGltfMaterialDefaults(materialDefaultFiles({
                dielectric: mutatedFile(
                    dielectricModule,
                    "((ior - 1) / (ior + 1)) ** 2 / 0.04",
                    "((ior - 1) / (ior + 1)) ** 3 / 0.04",
                ),
            })),
        /no longer squares the IOR ratio/,
    );
});

test("a changed tint unit flows through both pinned sites", () => {
    const defaults = lowerGltfMaterialDefaults(materialDefaultFiles({
        dielectric: mutatedFileEdits(dielectricModule, [
            [
                "specColFactor[0] !== 1 || specColFactor[1] !== 1 || specColFactor[2] !== 1",
                "specColFactor[0] !== 0.5 || specColFactor[1] !== 0.5 || specColFactor[2] !== 0.5",
            ],
            [
                "eSp.specularColorFactor[0] !== 1 || eSp.specularColorFactor[1] !== 1 || eSp.specularColorFactor[2] !== 1",
                "eSp.specularColorFactor[0] !== 0.5 || eSp.specularColorFactor[1] !== 0.5 || eSp.specularColorFactor[2] !== 0.5",
            ],
        ]),
    }));
    assert.deepEqual(defaults.specularColor, {
        key: "specularColorFactor",
        length: "3",
        unit: "0.5f",
    });
});

test("tint sites that disagree on the unit refuse", () => {
    assert.throws(
        () =>
            lowerGltfMaterialDefaults(materialDefaultFiles({
                dielectric: mutatedFile(
                    dielectricModule,
                    "specColFactor[0] !== 1 || specColFactor[1] !== 1 || specColFactor[2] !== 1",
                    "specColFactor[0] !== 0.5 || specColFactor[1] !== 0.5 || specColFactor[2] !== 0.5",
                ),
            })),
        /no longer agrees with itself on the tint unit/,
    );
});

test("a tint the record's Color3 cannot store refuses", () => {
    assert.throws(
        () =>
            lowerGltfMaterialDefaults(materialDefaultFiles({
                dielectric: mutatedFileEdits(dielectricModule, [
                    ["specColFactor.length === 3", "specColFactor.length === 4"],
                    [
                        "eSp.specularColorFactor.length === 3",
                        "eSp.specularColorFactor.length === 4",
                    ],
                ]),
            })),
        /no longer stores a three-lane tint/,
    );
});
