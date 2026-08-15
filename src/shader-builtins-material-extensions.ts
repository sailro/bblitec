export interface MaterialExtensionOptions {
    transmission: boolean;
    environmentRotation: boolean;
    clearcoat: boolean;
    sheen: boolean;
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
        result.push(
            {
                texture: "sheenColorTexture",
                sampler: "sheenColorSampler",
            },
            {
                texture: "sheenRoughnessTexture",
                sampler: "sheenRoughnessSampler",
            },
        );
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
        fields.push("  iridescenceParams : vec4<f32>,");
    }
    if (options.occlusionUv2) {
        fields.push("  occlusionParams : vec4<f32>,");
    }
    return fields.length > 0 ? `${fields.join("\n")}\n` : "";
}

const clearcoatHelpers = `fn bblVisibilityKelemen(VdotH_kl : f32) -> f32 {
  return 0.25f / (VdotH_kl * VdotH_kl + 0.0000001f);
}

fn bblClearcoatSchlick(f0 : f32, cosTheta : f32) -> f32 {
  let t = 1.0f - cosTheta;
  let t2 = t * t;
  return f0 + (1.0f - f0) * (t2 * t2 * t);
}
`;

const sheenHelpers =
    `fn bblCharlieSheenDistribution(NdotH_sh : f32, alphaG_sh : f32) -> f32 {
  let invR = 1.0f / alphaG_sh;
  let cos2h = NdotH_sh * NdotH_sh;
  let sin2h = 1.0f - cos2h;
  return (2.0f + invR) * pow(sin2h, invR * 0.5f) /
    (2.0f * 3.14159265358979323846f);
}

fn bblVisibilityAshikhmin(NdotL_sh : f32, NdotV_sh : f32) -> f32 {
  return 1.0f / (4.0f * (NdotL_sh + NdotV_sh - NdotL_sh * NdotV_sh));
}
`;

const iridescenceHelpers = `const bblIridescenceXyzToRec709 : mat3x3<f32> = mat3x3<f32>(
  3.2404542f, -0.9692660f, 0.0556434f,
  -1.5371385f, 1.8760108f, -0.2040259f,
  -0.4985314f, 0.0415560f, 1.0572252f,
);

fn bblIridescenceSquare3(x : vec3<f32>) -> vec3<f32> {
  return x * x;
}

fn bblIridescenceIorFromAirF0(f0 : vec3<f32>) -> vec3<f32> {
  let s = sqrt(clamp(f0, vec3<f32>(0.0f), vec3<f32>(0.9999f)));
  return (vec3<f32>(1.0f) + s) / (vec3<f32>(1.0f) - s);
}

fn bblIridescenceR0FromIor3(
  iorT : vec3<f32>,
  iorI : f32,
) -> vec3<f32> {
  return bblIridescenceSquare3(
    (iorT - vec3<f32>(iorI)) / (iorT + vec3<f32>(iorI)));
}

fn bblIridescenceR0FromIor(iorT : f32, iorI : f32) -> f32 {
  let r = (iorT - iorI) / (iorT + iorI);
  return r * r;
}

fn bblIridescenceFresnelSchlick(
  c : f32,
  F0 : vec3<f32>,
  F90 : vec3<f32>,
) -> vec3<f32> {
  let t = 1.0f - c;
  let t2 = t * t;
  return F0 + (F90 - F0) * (t2 * t2 * t);
}

fn bblIridescenceEvalSensitivity(
  opd : f32,
  shift : vec3<f32>,
) -> vec3<f32> {
  let phase = 6.283185307179586f * opd * 1.0e-9f;
  let val = vec3<f32>(5.4856e-13f, 4.4201e-13f, 5.2481e-13f);
  let pos = vec3<f32>(1.6810e+06f, 1.7953e+06f, 2.2084e+06f);
  let vr = vec3<f32>(4.3278e+09f, 9.3046e+09f, 6.6121e+09f);
  var xyz = val * sqrt(6.283185307179586f * vr) *
    cos(pos * phase + shift) * exp(-(phase * phase) * vr);
  xyz.x = xyz.x + 9.7470e-14f *
    sqrt(6.283185307179586f * 4.5282e+09f) *
    cos(2.2399e+06f * phase + shift.x) *
    exp(-4.5282e+09f * phase * phase);
  xyz = xyz / 1.0685e-7f;
  return bblIridescenceXyzToRec709 * xyz;
}

fn bblIridescenceEval(
  outsideIor : f32,
  eta2 : f32,
  cosTheta1 : f32,
  thickness : f32,
  baseF0 : vec3<f32>,
) -> vec3<f32> {
  let iridescenceIor =
    mix(outsideIor, eta2, smoothstep(0.0f, 0.03f, thickness));
  let eta = outsideIor / iridescenceIor;
  let sinTheta2Sq = eta * eta * (1.0f - cosTheta1 * cosTheta1);
  let cosTheta2Sq = 1.0f - sinTheta2Sq;
  if (cosTheta2Sq < 0.0f) {
    return vec3<f32>(1.0f);
  }
  let cosTheta2 = sqrt(cosTheta2Sq);
  let r0 = bblIridescenceR0FromIor(iridescenceIor, outsideIor);
  let r12 = bblIridescenceFresnelSchlick(
    cosTheta1,
    vec3<f32>(r0),
    vec3<f32>(1.0f)).x;
  let t121 = 1.0f - r12;
  var phi12 = 0.0f;
  if (iridescenceIor < outsideIor) {
    phi12 = 3.141592653589793f;
  }
  let phi21 = 3.141592653589793f - phi12;
  let baseIor = bblIridescenceIorFromAirF0(baseF0);
  let r1 = bblIridescenceR0FromIor3(baseIor, iridescenceIor);
  let r23 = bblIridescenceFresnelSchlick(
    cosTheta2,
    r1,
    vec3<f32>(1.0f));
  var phi23 = vec3<f32>(0.0f);
  if (baseIor.x < iridescenceIor) {
    phi23.x = 3.141592653589793f;
  }
  if (baseIor.y < iridescenceIor) {
    phi23.y = 3.141592653589793f;
  }
  if (baseIor.z < iridescenceIor) {
    phi23.z = 3.141592653589793f;
  }
  let opd = 2.0f * iridescenceIor * thickness * cosTheta2;
  let phi = vec3<f32>(phi21) + phi23;
  let r123 = clamp(
    vec3<f32>(r12) * r23,
    vec3<f32>(1e-5f),
    vec3<f32>(0.9999f));
  let smallR123 = sqrt(r123);
  let rs = (t121 * t121) * r23 / (vec3<f32>(1.0f) - r123);
  var outI = vec3<f32>(r12) + rs;
  var cm = rs - vec3<f32>(t121);
  for (var m : i32 = 1; m <= 2; m = m + 1) {
    cm = cm * smallR123;
    outI = outI + cm * (2.0f * bblIridescenceEvalSensitivity(
      f32(m) * opd,
      f32(m) * phi));
  }
  return max(outI, vec3<f32>(0.0f));
}
`;

const environmentRotationHelper =
    `fn bblRotateEnvironmentDirection(direction : vec3<f32>) -> vec3<f32> {
  let angle = FragmentUniforms.imageProcessingOptions.y;
  let c = cos(angle);
  let s = sin(angle);
  return vec3<f32>(
    direction.x * c + direction.z * s,
    direction.y,
    -direction.x * s + direction.z * c,
  );
}
`;

function moduleHelpers(options: MaterialExtensionOptions): string {
    const helpers: string[] = [];
    if (options.clearcoat) helpers.push(clearcoatHelpers);
    if (options.sheen) helpers.push(sheenHelpers);
    if (options.iridescence) helpers.push(iridescenceHelpers);
    if (
        options.environmentRotation &&
        (options.clearcoat || options.sheen)
    ) {
        helpers.push(environmentRotationHelper);
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
  let ccVis_dl = bblVisibilityKelemen(ccVdotH_dl);
  let ccFresnel_dl = bblClearcoatSchlick(ccF0, ccVdotH_dl);
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
  let ccFresnelIBL = bblClearcoatSchlick(ccF0, ccNdotV_ibl);
  let ccConservation_ibl = 1.0f - ccFresnelIBL * ccIntensity;
  let ccFinalRadiance_ibl = ccEnvRadiance_ibl * ccSpecEnvRefl;
`;
}

function sheenLayer(): string {
    return `  let sheenMapData =
    textureSample(sheenColorTexture, sheenColorSampler, v_4);
  let sheenColorFinal = FragmentUniforms.sheenParams.rgb * sheenMapData.rgb;
  let sheenRoughnessAdjusted = FragmentUniforms.sheenParams2.x *
    textureSample(sheenRoughnessTexture, sheenRoughnessSampler, v_4).a;
  let shIntensity = FragmentUniforms.sheenParams.a;
  let shColorScaled = sheenColorFinal * shIntensity;
  let shRoughness_clamped = max(sheenRoughnessAdjusted, v_47);
  let shAlphaG = shRoughness_clamped * shRoughness_clamped + 0.0005f;
  let shD = bblCharlieSheenDistribution(v_73, shAlphaG);
  let shV = bblVisibilityAshikhmin(v_68, v_43);
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
    shColorScaled * shBrdf.b * v_98 * (v_99 * v_99);
  let sheenIblTerm = shEnvRadiance * shEnvReflectance;
  let shMax = max(shColorScaled.r, max(shColorScaled.g, shColorScaled.b));
  let sheenAlbedoScaling = 1.0f - shMax * shBrdf.b;
`;
}

function layeredComposition(options: MaterialExtensionOptions): string {
    const conservation = options.clearcoat ? " * ccConservation_ibl" : "";
    const attenuation = options.clearcoat ? " * ccDirectAttenuation" : "";
    const albedoScaling = options.sheen ? " * sheenAlbedoScaling" : "";
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
  let iriIntensity = clamp(
    FragmentUniforms.iridescenceParams.x *
      textureSample(iridescenceTexture, iridescenceSampler, v_4).r,
    0.0f,
    1.0f,
  );
  let iriThickness = max(
    mix(
      FragmentUniforms.iridescenceParams.z,
      FragmentUniforms.iridescenceParams.w,
      textureSample(
        iridescenceThicknessTexture,
        iridescenceThicknessSampler,
        v_4).g,
    ),
    0.0f,
  );
  let iriF0 = bblIridescenceEval(
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
    if (options.iridescence) {
        result = replaceOnce(
            result,
            baseFresnelMarker,
            iridescenceFresnel(),
            "base Fresnel reflectance",
        );
    }
    if (options.clearcoat || options.sheen) {
        const layer =
            layerAliases(options) +
            (options.clearcoat ? clearcoatLayer(options) : "") +
            (options.sheen ? sheenLayer() : "") +
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
                "v_6 : bool) {",
            "fn main_inner(v_1 : vec3<f32>, v_2 : vec3<f32>, " +
                "v_3 : vec4<f32>, v_4 : vec2<f32>, v_5 : vec4<f32>, " +
                "v_6 : bool, bblUv2 : vec2<f32>) {",
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
