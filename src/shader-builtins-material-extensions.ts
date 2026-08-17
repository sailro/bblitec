export interface MaterialExtensionOptions {
    transmission: boolean;
    environmentRotation: boolean;
    clearcoat: boolean;
    sheen: boolean;
    /**
     * Which of the two pinned sheen models the fragment composes.
     * `createSheenFragment`'s `hasAlbedoScaling` arm — the one a glTF
     * `KHR_materials_sheen` material takes — scales the base layer, treats
     * the tint texture as linear, and multiplies the environment term by
     * specular and horizon occlusion. The legacy arm, which is what
     * `setPbrSheen` defaults to, does none of those and attenuates the lobe
     * by `1 - dielectricF0` instead.
     */
    sheenAlbedoScaling: boolean;
    /**
     * Whether the coat rewrites the base F0 before the base layer shades.
     * `createClearcoatFragment` composes `makeF0Remap` unless its
     * `PBR2_CC_F0_REMAP_OFF` bit is set, and the only thing that sets it is
     * `gltf-ext-clearcoat.ts` passing `useF0Remap: false` — so a glTF coat
     * reflects off the base's own F0 and a `setPbrClearCoat` coat reflects
     * off the remapped one. Scene 28 gates the first, Scene 19 the second.
     */
    clearcoatF0Remap: boolean;
    /**
     * The pin's own helper declarations, keyed by the pin's own name, from
     * `pinnedShaderHelpers()`. Required whenever any of the layers above is
     * set: there is deliberately no transcribed fallback, because a fallback
     * is exactly the copy that drifts.
     */
    pinnedHelpers?: Readonly<Record<string, string>>;
    iridescence: boolean;
    dispersion: boolean;
    occlusionUv2: boolean;
}

interface ExtensionBinding {
    texture: string;
    sampler: string;
}

const baseCompositionExpression =
    "((((((v_89 * v_52) * v_34) + v_101) + v_102) + " +
    "((((v_70 * v_52) * v_71) * v_81) * v_69)) + " +
    "(bblExtraDiffuse + bblExtraSpecular)) + v_40";

const uniformFieldMarker = "  sphericalHarmonics : array<vec4<f32>, 9u>,";
const moduleHelperMarker = "var<private> v : vec4<f32>;";
const bindingMarker = "struct S {";
const layerMarker =
    "  let v_103 = (FragmentUniforms.materialOptions.z > 0.5f);";
const baseFresnelMarker =
    "  let v_75 = mix(vec3<f32>(v_51, v_51, v_51), v_31, " +
    "vec3<f32>(v_36, v_36, v_36));\n" +
    "  let v_76 = (vec3<f32>(1.0f) - v_75);";

export function materialExtensionBindings(
    options: MaterialExtensionOptions,
): ExtensionBinding[] {
    const result: ExtensionBinding[] = [];
    if (options.clearcoat) {
        result.push(
            {
                texture: "clearcoatTexture",
                sampler: "clearcoatSampler",
            },
            {
                texture: "clearcoatRoughnessTexture",
                sampler: "clearcoatRoughnessSampler",
            },
            {
                texture: "clearcoatNormalTexture",
                sampler: "clearcoatNormalSampler",
            },
        );
    }
    if (options.sheen) {
        result.push({
            texture: "sheenColorTexture",
            sampler: "sheenColorSampler",
        });
        // The legacy arm declares no separate roughness map — it reads
        // roughness from the tint texture's alpha — so the pair would be a
        // binding nothing samples, which the reflection check rejects.
        if (options.sheenAlbedoScaling) {
            result.push({
                texture: "sheenRoughnessTexture",
                sampler: "sheenRoughnessSampler",
            });
        }
    }
    if (options.iridescence) {
        result.push(
            {
                texture: "iridescenceTexture",
                sampler: "iridescenceSampler",
            },
            {
                texture: "iridescenceThicknessTexture",
                sampler: "iridescenceThicknessSampler",
            },
        );
    }
    if (options.occlusionUv2) {
        // Babylon Lite's pbr-template-ext appends a dedicated
        // occlusion texture pair when the glTF occlusionTexture
        // selects TEXCOORD_1.
        result.push({
            texture: "occlusionTexture",
            sampler: "occlusionSampler",
        });
    }
    return result;
}

function bindingDeclarations(
    options: MaterialExtensionOptions,
): string {
    const base = options.transmission ? 18 : 12;
    return materialExtensionBindings(options)
        .flatMap((binding, index) => [
            `@group(2u) @binding(${base + index * 2}u) var ` +
                `${binding.texture} : texture_2d<f32>;`,
            "",
            `@group(2u) @binding(${base + index * 2 + 1}u) var ` +
                `${binding.sampler} : sampler;`,
            "",
        ])
        .join("\n");
}

function uniformFields(options: MaterialExtensionOptions): string {
    const fields: string[] = [];
    if (options.clearcoat) {
        fields.push(
            "  clearcoatParams : vec4<f32>,",
            "  clearcoatRefractionParams : vec4<f32>,",
        );
    }
    if (options.sheen) {
        fields.push(
            "  sheenParams : vec4<f32>,",
            "  sheenParams2 : vec4<f32>,",
        );
    }
    if (options.iridescence) {
        fields.push(
            "  iridescenceParams : vec4<f32>,",
            "  iridescenceOptions : vec4<f32>,",
        );
    }
    if (options.occlusionUv2) {
        fields.push("  occlusionParams : vec4<f32>,");
    }
    return fields.length > 0 ? `${fields.join("\n")}\n` : "";
}

/**
 * One declaration from the pinned helper table, by the pin's own name.
 *
 * Every formula here used to be typed out in this file. They are now lifted
 * verbatim from real compositions — see `pinnedShaderHelpers` in
 * `pinned-pbr-variants.ts` — so the generated shader calls what upstream
 * calls, under upstream's names, and a formula the pin changes arrives here
 * instead of silently disagreeing. There is deliberately no transcribed
 * fallback: a fallback is exactly the copy that drifts.
 */
function pinnedHelper(
    options: MaterialExtensionOptions,
    name: string,
): string {
    const text = options.pinnedHelpers?.[name];
    if (text === undefined) {
        throw new Error(
            `Shader lowering needs the pinned declaration '${name}'; ` +
                "pass `pinnedHelpers` from `pinnedShaderHelpers()`.",
        );
    }
    return text;
}

function joinHelpers(
    options: MaterialExtensionOptions,
    names: readonly string[],
): string {
    return `${names
        .map((name) => pinnedHelper(options, name))
        .join("\n\n")}\n`;
}

/**
 * The coat's helpers. The base-F0 remap is composed only when the coat asks
 * for it — a glTF coat passes `useF0Remap: false` — so it is left out rather
 * than emitted as a function nothing calls.
 */
function clearcoatHelpers(options: MaterialExtensionOptions): string {
    return joinHelpers(options, [
        "visibility_Kelemen",
        ...(options.clearcoatF0Remap
            ? ["getR0RemappedForClearCoat"]
            : []),
        "ccSchlick",
    ]);
}

/**
 * The pinned `makeF0Remap` slot, which runs before the base layer shades:
 * a coat over a base changes the interface the base reflects off, so
 * `createClearcoatFragment` rewrites the base F0 through
 * `getR0RemappedForClearCoat` and mixes by the coat intensity.
 * `gltf-ext-clearcoat.ts` is the one caller that turns it off
 * (`useF0Remap: false`), which is why a glTF coat and a `setPbrClearCoat`
 * coat compose different fragments.
 */
const clearcoatF0RemapReplacement =
    "  let bblBaseColorF0 = mix(vec3<f32>(v_51, v_51, v_51), v_31, " +
    "vec3<f32>(v_36, v_36, v_36));\n" +
    "  let bblCcRemapIntensity = FragmentUniforms.clearcoatParams.x *\n" +
    "    textureSample(clearcoatTexture, clearcoatSampler, v_4).r;\n" +
    "  let v_75 = mix(\n" +
    "    bblBaseColorF0,\n" +
    "    getR0RemappedForClearCoat(\n" +
    "      bblBaseColorF0,\n" +
    "      FragmentUniforms.clearcoatRefractionParams.z,\n" +
    "      FragmentUniforms.clearcoatRefractionParams.w),\n" +
    "    vec3<f32>(bblCcRemapIntensity));\n" +
    "  let v_76 = (vec3<f32>(1.0f) - v_75);";

/** The sheen lobe's distribution and visibility terms. */
function sheenHelpers(options: MaterialExtensionOptions): string {
    return joinHelpers(options, [
        "normalDistributionFunction_CharlieSheen",
        "visibility_Ashikhmin",
    ]);
}

/**
 * The thin-film stack, including its XYZ→Rec.709 matrix: nine literals a
 * transcription can only get right by luck.
 */
function iridescenceHelpers(options: MaterialExtensionOptions): string {
    return joinHelpers(options, [
        "IRI_XYZ_TO_REC709",
        "iri_square3",
        "iri_iorFromAirF0",
        "iri_r0FromIor3",
        "iri_r0FromIor",
        "iri_fresSchlick",
        "iri_evalSensitivity",
        "iri_eval",
    ]);
}

/**
 * The environment rotation, as the pin's `rotateY` plus the plumbing that
 * supplies its angle.
 *
 * Upstream takes the angle as a parameter and the renderable passes it in;
 * here the layers reach the environment from inside one fragment, so the
 * wrapper reads the same value out of the uniform block. Only the wrapper is
 * ours — the rotation itself is the pin's text.
 */
function environmentRotationHelper(
    options: MaterialExtensionOptions,
): string {
    return `${pinnedHelper(options, "rotateY")}

fn bblRotateEnvironmentDirection(direction : vec3<f32>) -> vec3<f32> {
  return rotateY(direction, FragmentUniforms.imageProcessingOptions.y);
}
`;
}

function moduleHelpers(options: MaterialExtensionOptions): string {
    const helpers: string[] = [];
    if (options.clearcoat) {
        helpers.push(clearcoatHelpers(options));
    }
    if (options.sheen) helpers.push(sheenHelpers(options));
    if (options.iridescence) helpers.push(iridescenceHelpers(options));
    if (
        options.environmentRotation &&
        (options.clearcoat || options.sheen)
    ) {
        helpers.push(environmentRotationHelper(options));
    }
    return helpers.length > 0 ? `${helpers.join("\n")}\n` : "";
}

function environmentDirection(
    expression: string,
    options: MaterialExtensionOptions,
): string {
    return options.environmentRotation
        ? `bblRotateEnvironmentDirection(${expression})`
        : expression;
}

function clearcoatLayer(options: MaterialExtensionOptions): string {
    return `  let ccIntensity = FragmentUniforms.clearcoatParams.x *
    textureSample(clearcoatTexture, clearcoatSampler, v_4).r;
  let ccRoughness = clamp(
    FragmentUniforms.clearcoatParams.y *
      textureSample(
        clearcoatRoughnessTexture,
        clearcoatRoughnessSampler,
        v_4).g,
    0.0f,
    1.0f,
  );
  let cc_dp1 = dpdx(v_1);
  let cc_dp2 = dpdy(v_1);
  let cc_duv1 = dpdx(v_4);
  let cc_duv2 = dpdy(v_4);
  let cc_dp2perp = cross(cc_dp2, v_29);
  let cc_dp1perp = cross(v_29, cc_dp1);
  let cc_tFrame = cc_dp2perp * cc_duv1.x + cc_dp1perp * cc_duv2.x;
  let cc_bFrame = -(cc_dp2perp * cc_duv1.y + cc_dp1perp * cc_duv2.y);
  let cc_det = max(dot(cc_tFrame, cc_tFrame), dot(cc_bFrame, cc_bFrame));
  let cc_invmax = select(inverseSqrt(cc_det), 0.0f, cc_det == 0.0f);
  let cc_frame = mat3x3<f32>(
    cc_tFrame * cc_invmax,
    cc_bFrame * cc_invmax,
    v_29,
  );
  let ccNormalSample =
    textureSample(clearcoatNormalTexture, clearcoatNormalSampler, v_4).rgb *
      2.0f - vec3<f32>(1.0f);
  let ccNormalScale = FragmentUniforms.clearcoatParams.z;
  let ccMappedNormal = normalize(cc_frame * normalize(
    ccNormalSample * vec3<f32>(ccNormalScale, ccNormalScale, 1.0f)));
  let ccN = select(
    v_29,
    ccMappedNormal,
    FragmentUniforms.clearcoatParams.w > 0.5f,
  );
  let ccF0 = FragmentUniforms.clearcoatRefractionParams.x;
  let ccAlphaG_dl = ccRoughness * ccRoughness + 0.0005f;
  let ccNdotL_dl = clamp(dot(ccN, v_67), 0.0f, 1.0f);
  let ccH_dl = normalize(v_41 + v_67);
  let ccNdotH_dl = clamp(dot(ccN, ccH_dl), 0.0000001f, 1.0f);
  let ccVdotH_dl = clamp(dot(v_41, ccH_dl), 0.0f, 1.0f);
  let ccA2_dl = ccAlphaG_dl * ccAlphaG_dl;
  let ccDenominator_dl = ccNdotH_dl * ccNdotH_dl * (ccA2_dl - 1.0f) + 1.0f;
  let ccD_dl = ccA2_dl /
    (3.14159265358979323846f * ccDenominator_dl * ccDenominator_dl);
  let ccVis_dl = visibility_Kelemen(ccVdotH_dl);
  let ccFresnel_dl = ccSchlick(ccF0, ccVdotH_dl);
  let ccDirectSpecularTerm =
    vec3<f32>(ccFresnel_dl * ccD_dl * ccVis_dl * ccNdotL_dl) *
    FragmentUniforms.lightColor.xyz * v_69 * v_81 * ccIntensity;
  let ccDirectAttenuation = 1.0f - ccFresnel_dl * ccIntensity;
  let cc_nDfdx_AA = dpdx(ccN);
  let cc_nDfdy_AA = dpdy(ccN);
  let cc_slopeSquare_AA = max(
    dot(cc_nDfdx_AA, cc_nDfdx_AA),
    dot(cc_nDfdy_AA, cc_nDfdy_AA),
  );
  let ccAlphaG_ibl = ccRoughness * ccRoughness + 0.0005f + select(
    0.0f,
    sqrt(cc_slopeSquare_AA) * 0.75f,
    FragmentUniforms.emissiveFactor.w > 0.5f,
  );
  let ccReflection = reflect(-(v_41), ccN);
  let ccR_ibl = ${environmentDirection("ccReflection", options)};
  let ccNdotV_ibl = abs(dot(ccN, v_41)) + 0.0000001f;
  let ccSpecLod_ibl = log2(bblCubemapDimension * ccAlphaG_ibl) *
    FragmentUniforms.environmentFactors.z;
  let ccEnvRadiance_ibl = textureSampleLevel(
    environmentTexture,
    environmentSampler,
    ccR_ibl,
    clamp(ccSpecLod_ibl, 0.0f, bblMaxEnvironmentLod),
  ).rgb * v_88;
  let ccBrdf_ibl =
    textureSample(
      brdfTexture,
      brdfSampler,
      vec2<f32>(ccNdotV_ibl, ccRoughness)).rgb;
  let ccHorizon = clamp(1.0f + 1.1f * dot(ccReflection, v_29), 0.0f, 1.0f);
  let ccEho_ibl = select(
    1.0f,
    ccHorizon * ccHorizon,
    FragmentUniforms.normalOptions.y > 0.5f,
  );
  let ccSpecEnvRefl = (vec3<f32>(ccF0) * ccBrdf_ibl.y +
    (vec3<f32>(1.0f) - vec3<f32>(ccF0)) * ccBrdf_ibl.x) *
    ccIntensity * ccEho_ibl;
  let ccFresnelIBL = ccSchlick(ccF0, ccNdotV_ibl);
  let ccConservation_ibl = 1.0f - ccFresnelIBL * ccIntensity;
  let ccFinalRadiance_ibl = ccEnvRadiance_ibl * ccSpecEnvRefl;
`;
}

function sheenLayer(albedoScaling: boolean): string {
    // The legacy arm reads its tint through pow(rgb, 2.2), takes roughness
    // from the tint texture's alpha because it declares no separate
    // roughness map, and attenuates the lobe by the dielectric Fresnel term
    // rather than scaling the base layer.
    const tint = albedoScaling
        ? "sheenMapData.rgb"
        : "pow(sheenMapData.rgb, vec3<f32>(2.2f))";
    const roughnessSource = albedoScaling
        ? `FragmentUniforms.sheenParams2.x *
    textureSample(sheenRoughnessTexture, sheenRoughnessSampler, v_4).a`
        : "FragmentUniforms.sheenParams2.x * sheenMapData.a";
    const intensity = albedoScaling
        ? "FragmentUniforms.sheenParams.a"
        : "FragmentUniforms.sheenParams.a * (1.0f - v_51)";
    return `  let sheenMapData =
    textureSample(sheenColorTexture, sheenColorSampler, v_4);
  let sheenColorFinal = FragmentUniforms.sheenParams.rgb * ${tint};
  let sheenRoughnessAdjusted = ${roughnessSource};
  let shIntensity = ${intensity};
  let shColorScaled = sheenColorFinal * shIntensity;
  let shRoughness_clamped = max(sheenRoughnessAdjusted, v_47);
  let shAlphaG = shRoughness_clamped * shRoughness_clamped + 0.0005f;
  let shD = normalDistributionFunction_CharlieSheen(v_73, shAlphaG);
  let shV = visibility_Ashikhmin(v_68, v_43);
  let sheenDirectTerm = shColorScaled * shD * shV * v_68 *
    FragmentUniforms.lightColor.xyz * v_69 * v_81;
  let shRoughness_ibl = sheenRoughnessAdjusted;
  let shAlphaG_ibl =
    shRoughness_ibl * shRoughness_ibl + 0.0005f + bblAaFactorY;
  let shSpecLod = log2(bblCubemapDimension * shAlphaG_ibl) *
    FragmentUniforms.environmentFactors.z;
  let shEnvRadiance = textureSampleLevel(
    environmentTexture,
    environmentSampler,
    v_90,
    clamp(shSpecLod, 0.0f, bblMaxEnvironmentLod),
  ).rgb * v_88;
  let shBrdf = textureSampleLevel(
    brdfTexture,
    brdfSampler,
    vec2<f32>(v_43, shRoughness_ibl),
    0.0f,
  );
  let shEnvReflectance =
    shColorScaled * shBrdf.b${albedoScaling ? " * v_98 * (v_99 * v_99)" : ""};
  let sheenIblTerm = shEnvRadiance * shEnvReflectance;${albedoScaling ? `
  let shMax = max(shColorScaled.r, max(shColorScaled.g, shColorScaled.b));
  let sheenAlbedoScaling = 1.0f - shMax * shBrdf.b;` : ""}
`;
}

function layeredComposition(options: MaterialExtensionOptions): string {
    const conservation = options.clearcoat ? " * ccConservation_ibl" : "";
    const attenuation = options.clearcoat ? " * ccDirectAttenuation" : "";
    const albedoScaling =
        options.sheen && options.sheenAlbedoScaling
            ? " * sheenAlbedoScaling"
            : "";
    const additive = [
        ...(options.clearcoat
            ? ["ccDirectSpecularTerm", "ccFinalRadiance_ibl"]
            : []),
        ...(options.sheen ? ["sheenDirectTerm", "sheenIblTerm"] : []),
    ]
        .map((term) => `\n    ${term} +`)
        .join("");
    return `  let bblLayeredColor =
    (bblBaseIrradiance${conservation} +
      v_101${conservation} +
      v_102${attenuation} +
      bblBaseDirectDiffuse${attenuation})${albedoScaling} +${additive}
    v_40;
`;
}

function layerAliases(options: MaterialExtensionOptions): string {
    const aliases = [
        "  let bblBaseIrradiance = (v_89 * v_52) * v_34;",
        "  let bblBaseDirectDiffuse = (((v_70 * v_52) * v_71) * v_81) * v_69;",
        "  let bblCubemapDimension = " +
            "f32(textureDimensions(environmentTexture, 0u).x);",
        "  let bblMaxEnvironmentLod = " +
            "f32(textureNumLevels(environmentTexture) - 1u);",
    ];
    if (options.sheen) {
        aliases.push(
            "  let bblAaFactorY = select(\n" +
                "    0.0f,\n" +
                "    sqrt(v_46) * 0.75f,\n" +
                "    FragmentUniforms.normalOptions.y > 0.5f ||\n" +
                "      FragmentUniforms.emissiveFactor.w > 0.5f,\n" +
                "  );",
        );
    }
    return `${aliases.join("\n")}\n`;
}

function iridescenceFresnel(): string {
    return `  let bblBaseColorF0 = mix(
    vec3<f32>(v_51, v_51, v_51),
    v_31,
    vec3<f32>(v_36, v_36, v_36),
  );
  // A material with no iridescence textures reads its factor and its MAXIMUM
  // thickness directly: the pinned fragment composes the texture terms only
  // when the textures exist, so an absent thickness map means the maximum
  // rather than an interpolation toward the minimum. This fragment is shared
  // by the scene's materials, so the choice rides a per-material flag the way
  // the transmission options beside it already do. Getting it wrong is
  // invisible until a material sets a non-zero iridescence factor, because
  // the intensity multiplies the whole term away.
  let iriIntensity = clamp(
    FragmentUniforms.iridescenceParams.x *
      mix(
        1.0f,
        textureSample(iridescenceTexture, iridescenceSampler, v_4).r,
        FragmentUniforms.iridescenceOptions.x,
      ),
    0.0f,
    1.0f,
  );
  let iriThickness = max(
    mix(
      FragmentUniforms.iridescenceParams.w,
      mix(
        FragmentUniforms.iridescenceParams.z,
        FragmentUniforms.iridescenceParams.w,
        textureSample(
          iridescenceThicknessTexture,
          iridescenceThicknessSampler,
          v_4).g,
      ),
      FragmentUniforms.iridescenceOptions.y,
    ),
    0.0f,
  );
  let iriF0 = iri_eval(
    1.0f,
    max(FragmentUniforms.iridescenceParams.y, 1.0001f),
    v_43,
    iriThickness,
    bblBaseColorF0,
  );
  let v_75 = mix(bblBaseColorF0, iriF0, vec3<f32>(iriIntensity));
  let v_76 = (vec3<f32>(1.0f) - v_75);`;
}

const singleRayRefraction = `    let refractedDirection = refract(
      -(v_41),
      v_28,
      FragmentUniforms.refractionParams.y,
    );
    let refractedClip = FragmentUniforms.viewProjection *
      vec4<f32>(v_1 + refractedDirection * thickness, 1.0f);
    let refractedUv = (refractedClip.xy / refractedClip.w) *
      vec2<f32>(0.5f, -0.5f) + vec2<f32>(0.5f);
    let refractionLod = clamp(
      log2(f32(textureDimensions(sceneColorTexture).x) *
        mix(v_48, 0.0f, clamp(FragmentUniforms.refractionParams.w * 3.0f - 2.0f, 0.0f, 1.0f))) -
        4.0f,
      0.0f,
      f32(textureNumLevels(sceneColorTexture) - 1u),
    );
    let sceneTransmission = textureSampleLevel(
      sceneColorTexture,
      sceneColorSampler,
      refractedUv,
      refractionLod,
    ).rgb * FragmentUniforms.materialFactors.w;`;

const dispersionRefraction = `    let refractionLod = clamp(
      log2(f32(textureDimensions(sceneColorTexture).x) *
        mix(v_48, 0.0f, clamp(FragmentUniforms.refractionParams.w * 3.0f - 2.0f, 0.0f, 1.0f))) -
        4.0f,
      0.0f,
      f32(textureNumLevels(sceneColorTexture) - 1u),
    );
    let eta = FragmentUniforms.refractionParams.y;
    let realIOR = 1.0f / eta;
    let spread = 0.04f * FragmentUniforms.volumeParams.w * (realIOR - 1.0f);
    let etaR = 1.0f / (realIOR - spread);
    let etaB = 1.0f / (realIOR + spread);
    let cpR = FragmentUniforms.viewProjection *
      vec4<f32>(v_1 + refract(-(v_41), v_28, etaR) * thickness, 1.0f);
    let cpG = FragmentUniforms.viewProjection *
      vec4<f32>(v_1 + refract(-(v_41), v_28, eta) * thickness, 1.0f);
    let cpB = FragmentUniforms.viewProjection *
      vec4<f32>(v_1 + refract(-(v_41), v_28, etaB) * thickness, 1.0f);
    let uvR = (cpR.xy / cpR.w) * vec2<f32>(0.5f, -0.5f) +
      vec2<f32>(0.5f, 0.5f);
    let uvG = (cpG.xy / cpG.w) * vec2<f32>(0.5f, -0.5f) +
      vec2<f32>(0.5f, 0.5f);
    let uvB = (cpB.xy / cpB.w) * vec2<f32>(0.5f, -0.5f) +
      vec2<f32>(0.5f, 0.5f);
    let sceneTransmission = vec3<f32>(
      textureSampleLevel(
        sceneColorTexture,
        sceneColorSampler,
        uvR,
        refractionLod).r,
      textureSampleLevel(
        sceneColorTexture,
        sceneColorSampler,
        uvG,
        refractionLod).g,
      textureSampleLevel(
        sceneColorTexture,
        sceneColorSampler,
        uvB,
        refractionLod).b,
    ) * FragmentUniforms.materialFactors.w;`;

function replaceOnce(
    source: string,
    marker: string,
    replacement: string,
    label: string,
): string {
    const pattern = new RegExp(
        marker
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\n/g, "\\r?\\n"),
        "g",
    );
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) {
        throw new Error(
            `PBR material-extension marker changed: ${label}.`,
        );
    }
    const match = matches[0]!;
    const start = match.index;
    return (
        source.slice(0, start) +
        replacement +
        source.slice(start + match[0].length)
    );
}

export function applyMaterialExtensionWgsl(
    converted: string,
    options: MaterialExtensionOptions,
): string {
    if (
        !options.clearcoat &&
        !options.sheen &&
        !options.iridescence &&
        !options.dispersion &&
        !options.occlusionUv2
    ) {
        return converted;
    }
    let result = converted;
    const bindings = bindingDeclarations(options);
    if (bindings.length > 0) {
        result = replaceOnce(
            result,
            bindingMarker,
            `${bindings}${bindingMarker}`,
            "texture bindings",
        );
    }
    const fields = uniformFields(options);
    if (fields.length > 0) {
        result = replaceOnce(
            result,
            uniformFieldMarker,
            `${fields}${uniformFieldMarker}`,
            "uniform fields",
        );
    }
    const helpers = moduleHelpers(options);
    if (helpers.length > 0) {
        result = replaceOnce(
            result,
            moduleHelperMarker,
            `${helpers}\n${moduleHelperMarker}`,
            "module helpers",
        );
    }
    if (options.iridescence && options.clearcoatF0Remap) {
        // Both rewrite the base F0 lines, and the pin composes them into one
        // fragment through separate slots rather than one after the other, so
        // stacking the two text rewrites would not be the pinned arithmetic.
        throw new Error(
            "Iridescence composed with a clearcoat F0 remap is not lowered.",
        );
    }
    if (options.iridescence) {
        result = replaceOnce(
            result,
            baseFresnelMarker,
            iridescenceFresnel(),
            "base Fresnel reflectance",
        );
    }
    if (options.clearcoatF0Remap) {
        result = replaceOnce(
            result,
            baseFresnelMarker,
            clearcoatF0RemapReplacement,
            "clearcoat base F0 remap",
        );
    }
    if (options.clearcoat || options.sheen) {
        const layer =
            layerAliases(options) +
            (options.clearcoat ? clearcoatLayer(options) : "") +
            (options.sheen
                ? sheenLayer(options.sheenAlbedoScaling)
                : "") +
            layeredComposition(options);
        result = replaceOnce(
            result,
            layerMarker,
            `${layer}${layerMarker}`,
            "material layer insertion point",
        );
        // The second analytic light's terms stay additive outside the
        // layered composition; every reached layered scene leaves them
        // zero (layered multi-light composition remains tracked in TODO).
        result = replaceOnce(
            result,
            baseCompositionExpression,
            "bblLayeredColor + (bblExtraDiffuse + bblExtraSpecular)",
            "base lighting composition",
        );
    }
    if (options.dispersion) {
        result = replaceOnce(
            result,
            singleRayRefraction,
            dispersionRefraction,
            "refracted scene-color sample",
        );
    }
    if (options.occlusionUv2) {
        result = replaceOnce(
            result,
            "fn main_inner(v_1 : vec3<f32>, v_2 : vec3<f32>, " +
                "v_3 : vec4<f32>, v_4 : vec2<f32>, v_5 : vec4<f32>, " +
                "v_6 : bool, bblBitangent : vec3<f32>) {",
            "fn main_inner(v_1 : vec3<f32>, v_2 : vec3<f32>, " +
                "v_3 : vec4<f32>, v_4 : vec2<f32>, v_5 : vec4<f32>, " +
                "v_6 : bool, bblBitangent : vec3<f32>, "  +
                "bblUv2 : vec2<f32>) {",
            "occlusion uv2 inner signature",
        );
        // Babylon Lite's pbr-template-ext occlusionOverride: a material whose
        // occlusionTexture selects TEXCOORD_1 samples a dedicated texture at
        // uv2 instead of the ORM red channel. Upstream compiles that choice
        // into the material's own fragment; this fragment is shared by the
        // scene's materials, so the choice is a per-material uniform and both
        // sources keep the occlusion-strength mix the pin applies to each.
        result = replaceOnce(
            result,
            "  let v_34 = mix(1.0f, v_33.x, " +
                "FragmentUniforms.materialFactors.z);",
            "  let bblOcclusionSample = select(\n" +
                "    v_33.x,\n" +
                "    textureSample(occlusionTexture, occlusionSampler, bblUv2).x,\n" +
                "    FragmentUniforms.occlusionParams.x > 0.5f,\n" +
                "  );\n" +
                "  let v_34 = mix(1.0f, bblOcclusionSample, " +
                "FragmentUniforms.materialFactors.z);",
            "occlusion uv2 override",
        );
    }
    return result;
}
