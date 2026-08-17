// Transcribed from the validated native PBR HLSL through DXC SPIR-V and
// pinned Tint a21a4a1c7c497e6366947ccaefbab768d16f32a8.
diagnostic(off, derivative_uniformity);

@group(2u) @binding(0u) var baseColorTexture : texture_2d<f32>;

@group(2u) @binding(1u) var baseColorSampler : sampler;

@group(2u) @binding(2u) var metallicRoughnessTexture : texture_2d<f32>;

@group(2u) @binding(3u) var metallicRoughnessSampler : sampler;

@group(2u) @binding(4u) var normalTexture : texture_2d<f32>;

@group(2u) @binding(5u) var normalSampler : sampler;

@group(2u) @binding(6u) var emissiveTexture : texture_2d<f32>;

@group(2u) @binding(7u) var emissiveSampler : sampler;

@group(2u) @binding(8u) var environmentTexture : texture_cube<f32>;

@group(2u) @binding(9u) var environmentSampler : sampler;

@group(2u) @binding(10u) var brdfTexture : texture_2d<f32>;

@group(2u) @binding(11u) var brdfSampler : sampler;

@group(2u) @binding(12u) var sceneColorTexture : texture_2d<f32>;

@group(2u) @binding(13u) var sceneColorSampler : sampler;

@group(2u) @binding(14u) var transmissionTexture : texture_2d<f32>;

@group(2u) @binding(15u) var transmissionSampler : sampler;

@group(2u) @binding(16u) var thicknessTexture : texture_2d<f32>;

@group(2u) @binding(17u) var thicknessSampler : sampler;

struct S {
  lightDirection : vec4<f32>,
  lightColor : vec4<f32>,
  groundColor : vec4<f32>,
  lightDirection2 : vec4<f32>,
  lightColor2 : vec4<f32>,
  groundColor2 : vec4<f32>,
  cameraPosition : vec4<f32>,
  cameraForwardNear : vec4<f32>,
  viewRight : vec4<f32>,
  viewUp : vec4<f32>,
  viewForward : vec4<f32>,
  baseColorFactor : vec4<f32>,
  emissiveFactor : vec4<f32>,
  materialFactors : vec4<f32>,
  environmentFactors : vec4<f32>,
  materialOptions : vec4<f32>,
  normalOptions : vec4<f32>,
  imageProcessingOptions : vec4<f32>,
  refractionParams : vec4<f32>,
  volumeParams : vec4<f32>,
  transmissionOptions : vec4<f32>,
  viewProjection : mat4x4<f32>,
  sphericalHarmonics : array<vec4<f32>, 9u>,
}

@group(3u) @binding(0u) var<uniform> FragmentUniforms : S;

var<private> v : vec4<f32>;

fn main_inner(v_1 : vec3<f32>, v_2 : vec3<f32>, v_3 : vec4<f32>, v_4 : vec2<f32>, v_5 : vec4<f32>, v_6 : bool, bblBitangent : vec3<f32>) {
  let v_7 = normalize(v_2);
  let v_8_raw = ((textureSample(normalTexture, normalSampler, v_4).xyz * 2.0f) - vec3<f32>(1.0f));
  let v_8 = vec3<f32>(
    v_8_raw.xy * FragmentUniforms.normalOptions.w,
    v_8_raw.z,
  );
  var v_9 : vec3<f32>;
  if ((FragmentUniforms.normalOptions.y < 0.5f)) {
    v_9 = v_7;
  } else {
    var v_10 : vec3<f32>;
    if ((FragmentUniforms.normalOptions.x > 0.5f)) {
      let v_11 = dpdx(v_1);
      let v_12 = dpdy(v_1);
      let v_13 = dpdx(v_4);
      let v_14 = dpdy(v_4);
      let v_15 = cross(v_12, v_7);
      let v_16 = cross(v_7, v_11);
      let v_17 = ((v_15 * v_13.x) + (v_16 * v_14.x));
      let v_18 = -(((v_15 * v_13.y) + (v_16 * v_14.y)));
      let v_19 = max(dot(v_17, v_17), dot(v_18, v_18));
      var v_20 : f32;
      if ((v_19 > 0.0f)) {
        v_20 = inverseSqrt(v_19);
      } else {
        v_20 = 0.0f;
      }
      let v_21 = v_20;
      v_10 = normalize(((((v_17 * v_21) * v_8.x) + ((v_18 * v_21) * v_8.y)) + (v_7 * v_8.z)));
    } else {
      // src/material/pbr/pbr-template.ts normalBlock, hasNormal arm:
      //   let TBN=mat3x3<f32>(input.worldTangent,input.worldBitangent,input.worldNormal);
      //   var N=normalize(TBN*normalMapNorm);
      // The columns are the raw varyings and the sample is normalized before
      // the frame, not after it — neither holds for an orthonormalized frame,
      // which is what this arm used to build.
      let v_22 = mat3x3<f32>(v_3.xyz, bblBitangent, v_2);
      v_10 = normalize((v_22 * normalize(v_8)));
    }
    v_9 = v_10;
  }
  let v_24 = v_9;
  var v_25 : bool;
  if ((FragmentUniforms.materialOptions.w > 0.5f)) {
    v_25 = !(v_6);
  } else {
    v_25 = false;
  }
  var v_26 : vec3<f32>;
  var v_27 : vec3<f32>;
  if (v_25) {
    v_26 = -(v_7);
    v_27 = -(v_24);
  } else {
    v_26 = v_7;
    v_27 = v_24;
  }
  let v_28 = v_27;
  let v_29 = v_26;
  let v_30 = textureSample(baseColorTexture, baseColorSampler, v_4);
  let v_31 = ((v_30.xyz * FragmentUniforms.baseColorFactor.xyz) * v_5.xyz);
  let v_32 = ((v_30.w * FragmentUniforms.baseColorFactor.w) * v_5.w);
  let v_33 = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, v_4);
  let v_34 = mix(1.0f, v_33.x, FragmentUniforms.materialFactors.z);
  let v_35 = clamp((v_33.y * FragmentUniforms.materialFactors.y), 0.03999999910593032837f, 1.0f);
  let v_36 = clamp((v_33.z * FragmentUniforms.materialFactors.x), 0.0f, 1.0f);
  let v_37 = FragmentUniforms.materialOptions.x;
  var v_38 : bool;
  if ((v_37 > 0.5f)) {
    v_38 = (v_37 < 1.5f);
  } else {
    v_38 = false;
  }
  var v_39 : bool;
  if (v_38) {
    v_39 = (v_32 < FragmentUniforms.materialOptions.y);
  } else {
    v_39 = false;
  }
  if (v_39) {
    discard;
    return;
  }
  let v_40 = (textureSample(emissiveTexture, emissiveSampler, v_4).xyz * FragmentUniforms.emissiveFactor.xyz);
  let v_41 = normalize((FragmentUniforms.cameraPosition.xyz - v_1));
  let v_42 = dot(v_28, v_41);
  let v_43 = (abs(v_42) + 0.00000010000000116861f);
  let v_44 = dpdx(v_28);
  let v_45 = dpdy(v_28);
  let v_46 = max(dot(v_44, v_44), dot(v_45, v_45));
  let v_47 = select(
    0.0f,
    pow(clamp(v_46, 0.0f, 1.0f), 0.333f),
    FragmentUniforms.normalOptions.y > 0.5f ||
      FragmentUniforms.emissiveFactor.w > 0.5f,
  );
  let v_48 = (((v_35 * v_35) + 0.00050000002374872565f) + select(
    0.0f,
    sqrt(v_46) * 0.75f,
    FragmentUniforms.normalOptions.y > 0.5f ||
      FragmentUniforms.emissiveFactor.w > 0.5f,
  ));
  let v_49 = max(v_35, v_47);
  let v_50 = ((v_49 * v_49) + 0.00050000002374872565f);
  let v_51 = FragmentUniforms.normalOptions.z;
  let v_52 = ((v_31 * (1.0f - v_51)) * (1.0f - v_36));
  var v_53 : f32;
  var v_54 : vec3<f32>;
  var v_55 : f32;
  var v_56 : f32;
  var v_57 : vec3<f32>;
  if ((FragmentUniforms.lightDirection.w > 1.5f)) {
    let bblDirectionalL = normalize(-(FragmentUniforms.lightDirection.xyz));
    let bblDirectionalNdotL = max(dot(v_28, bblDirectionalL), 0.0f);
    v_53 = (bblDirectionalNdotL * 0.31830987334251403809f);
    v_54 = FragmentUniforms.lightColor.xyz;
    v_55 = 1.0f;
    v_56 = bblDirectionalNdotL;
    v_57 = bblDirectionalL;
  } else if ((FragmentUniforms.lightDirection.w > 0.5f)) {
    let v_58 = (FragmentUniforms.lightDirection.xyz - v_1);
    let v_59 = dot(v_58, v_58);
    let v_60 = normalize(v_58);
    let v_61 = max(dot(v_28, v_60), 0.0f);
    let v_62 = max(0.0f, (1.0f - (sqrt(v_59) / max(FragmentUniforms.groundColor.w, 0.00009999999747378752f))));
    let v_63 = FragmentUniforms.lightColor.xyz;
    v_53 = (v_61 * 0.31830987334251403809f);
    v_54 = v_63;
    v_55 = v_62;
    v_56 = v_61;
    v_57 = v_60;
  } else {
    let v_64 = normalize(FragmentUniforms.lightDirection.xyz);
    let v_65 = clamp(((dot(v_28, v_64) * 0.5f) + 0.5f), 0.00000010000000116861f, 1.0f);
    let v_66 = mix(FragmentUniforms.groundColor.xyz, FragmentUniforms.lightColor.xyz, vec3<f32>(v_65, v_65, v_65));
    v_53 = 1.0f;
    v_54 = v_66;
    v_55 = 1.0f;
    v_56 = v_65;
    v_57 = v_64;
  }
  let v_67 = v_57;
  let v_68 = v_56;
  let v_69 = v_55;
  let v_70 = v_54;
  let v_71 = v_53;
  let v_72 = normalize((v_41 + v_67));
  let v_73 = clamp(dot(v_28, v_72), 0.00000010000000116861f, 1.0f);
  let v_74 = clamp(dot(v_41, v_72), 0.0f, 1.0f);
  let v_75 = mix(vec3<f32>(v_51, v_51, v_51), v_31, vec3<f32>(v_36, v_36, v_36));
  let v_76 = (vec3<f32>(1.0f) - v_75);
  let v_77 = (v_75 + (v_76 * pow((1.0f - v_74), 5.0f)));
  let v_78 = (v_50 * v_50);
  let v_79 = (((v_73 * v_73) * (v_78 - 1.0f)) + 1.0f);
  let v_80 = ((((v_77 * (v_78 / ((3.14159274101257324219f * v_79) * v_79))) * (0.5f / ((v_68 * sqrt(((v_43 * (v_43 - (v_78 * v_43))) + v_78))) + (v_43 * sqrt(((v_68 * (v_68 - (v_78 * v_68))) + v_78)))))) * v_68) * FragmentUniforms.lightColor.xyz);
  let v_81 = FragmentUniforms.lightColor.w;
  var v_82 : vec3<f32>;
  var v_83 : f32;
  switch(0u) {
    default: {
      // materialFactors.w is the material's environmentIntensity, and
      // is exactly 0 when the scene has no irradiance. The pinned
      // shader has no runtime gate here at all -- it multiplies the
      // harmonics by environmentIntensity and decides at build time
      // whether the block exists (ibl-fragment.ts) -- so this early
      // out may only catch the no-environment case. Testing it against
      // 0.5 instead silently dropped the environment from every
      // material that asked for less than half intensity.
      let v_84 = FragmentUniforms.materialFactors.w;
      if ((v_84 <= 0.0f)) {
        v_82 = vec3<f32>();
        v_83 = v_84;
        break;
      }
      let v_85 = v_28.y;
      let v_86 = v_28.z;
      let v_87 = v_28.x;
      v_82 = ((((((((FragmentUniforms.sphericalHarmonics[0i].xyz + (FragmentUniforms.sphericalHarmonics[1i].xyz * v_85)) + (FragmentUniforms.sphericalHarmonics[2i].xyz * v_86)) + (FragmentUniforms.sphericalHarmonics[3i].xyz * v_87)) + ((FragmentUniforms.sphericalHarmonics[4i].xyz * v_85) * v_87)) + ((FragmentUniforms.sphericalHarmonics[5i].xyz * v_85) * v_86)) + (FragmentUniforms.sphericalHarmonics[6i].xyz * (((3.0f * v_86) * v_86) - 1.0f))) + ((FragmentUniforms.sphericalHarmonics[7i].xyz * v_86) * v_87)) + (FragmentUniforms.sphericalHarmonics[8i].xyz * ((v_87 * v_87) - (v_85 * v_85))));
      v_83 = v_84;
    }
  }
  let v_88 = v_83;
  let v_89 = (v_82 * v_88);
  let v_90 = reflect(-(v_41), v_28);
  let v_91 = textureDimensions(environmentTexture, 0u).x;
  let v_92 = textureNumLevels(environmentTexture);
  let v_93 = clamp((log2(max((f32(v_91) * v_48), 1.0f)) * FragmentUniforms.environmentFactors.z), 0.0f, f32((v_92 - 1u)));
  let v_94 = mix((textureSampleLevel(environmentTexture, environmentSampler, v_90, v_93).xyz * v_88), v_89, vec3<f32>(v_48, v_48, v_48));
  let v_95 = textureSample(brdfTexture, brdfSampler, vec2<f32>(v_43, v_35));
  let v_96 = v_95.y;
  let v_97 = (v_42 + v_34);
  let v_98 = clamp((((v_97 * v_97) - 1.0f) + v_34), 0.0f, 1.0f);
  let v_99_horizon = clamp((1.0f + (1.10000002384185791016f * dot(v_90, v_29))), 0.0f, 1.0f);
  let v_99 = select(1.0f, v_99_horizon, FragmentUniforms.normalOptions.y > 0.5f);
  let v_100 = (vec3<f32>(1.0f) + (v_75 * ((1.0f / max(v_96, 0.00100000004749745131f)) - 1.0f)));
  let v_101 = ((v_94 * (((((v_76 * v_95.x) + (v_75 * v_96)) * v_98) * v_99) * v_99)) * v_100);
  var bblExtraDiffuse = vec3<f32>(0.0f);
  var bblExtraSpecular = vec3<f32>(0.0f);
  if ((FragmentUniforms.lightColor2.w > 0.0f)) {
    var bblSecondL : vec3<f32>;
    var bblSecondNdotL : f32;
    var bblSecondAttenuation : f32;
    var bblSecondColor : vec3<f32>;
    var bblSecondDiffuseFactor : f32;
    if ((FragmentUniforms.lightDirection2.w > 1.5f)) {
      bblSecondL = normalize(-(FragmentUniforms.lightDirection2.xyz));
      bblSecondNdotL = max(dot(v_28, bblSecondL), 0.0f);
      bblSecondAttenuation = 1.0f;
      bblSecondColor = FragmentUniforms.lightColor2.xyz;
      bblSecondDiffuseFactor = (bblSecondNdotL * 0.31830987334251403809f);
    } else if ((FragmentUniforms.lightDirection2.w > 0.5f)) {
      let bblSecondDelta = (FragmentUniforms.lightDirection2.xyz - v_1);
      let bblSecondDistanceSquared = dot(bblSecondDelta, bblSecondDelta);
      bblSecondL = normalize(bblSecondDelta);
      bblSecondNdotL = max(dot(v_28, bblSecondL), 0.0f);
      bblSecondAttenuation = max(0.0f, (1.0f - (sqrt(bblSecondDistanceSquared) / max(FragmentUniforms.groundColor2.w, 0.00009999999747378752f))));
      bblSecondColor = FragmentUniforms.lightColor2.xyz;
      bblSecondDiffuseFactor = (bblSecondNdotL * 0.31830987334251403809f);
    } else {
      bblSecondL = normalize(FragmentUniforms.lightDirection2.xyz);
      let bblSecondHalfLambert = clamp(((dot(v_28, bblSecondL) * 0.5f) + 0.5f), 0.00000010000000116861f, 1.0f);
      bblSecondColor = mix(FragmentUniforms.groundColor2.xyz, FragmentUniforms.lightColor2.xyz, vec3<f32>(bblSecondHalfLambert, bblSecondHalfLambert, bblSecondHalfLambert));
      bblSecondNdotL = bblSecondHalfLambert;
      bblSecondAttenuation = 1.0f;
      bblSecondDiffuseFactor = 1.0f;
    }
    let bblSecondHalf = normalize((v_41 + bblSecondL));
    let bblSecondNdotH = clamp(dot(v_28, bblSecondHalf), 0.00000010000000116861f, 1.0f);
    let bblSecondVdotH = clamp(dot(v_41, bblSecondHalf), 0.0f, 1.0f);
    let bblSecondFresnel = (v_75 + (v_76 * pow((1.0f - bblSecondVdotH), 5.0f)));
    let bblSecondDistributionDenominator = (((bblSecondNdotH * bblSecondNdotH) * (v_78 - 1.0f)) + 1.0f);
    let bblSecondDistribution = (v_78 / ((3.14159274101257324219f * bblSecondDistributionDenominator) * bblSecondDistributionDenominator));
    let bblSecondVisibility = (0.5f / ((bblSecondNdotL * sqrt(((v_43 * (v_43 - (v_78 * v_43))) + v_78))) + (v_43 * sqrt(((bblSecondNdotL * (bblSecondNdotL - (v_78 * bblSecondNdotL))) + v_78)))));
    let bblSecondSpecularTerm = (((bblSecondFresnel * bblSecondDistribution) * bblSecondVisibility) * bblSecondNdotL) * bblSecondColor;
    bblExtraSpecular += (((bblSecondSpecularTerm * FragmentUniforms.lightColor2.w) * bblSecondAttenuation) * mix(vec3<f32>(1.0f), v_100, vec3<f32>(v_88, v_88, v_88)));
    bblExtraDiffuse += ((((bblSecondColor * v_52) * bblSecondDiffuseFactor) * FragmentUniforms.lightColor2.w) * bblSecondAttenuation);
  }
  let v_102 = (((v_80 * v_81) * v_69) * mix(vec3<f32>(1.0f), v_100, vec3<f32>(v_88, v_88, v_88)));
  let v_103 = (FragmentUniforms.materialOptions.z > 0.5f);
  var shadedColor = ((((((v_89 * v_52) * v_34) + v_101) + v_102) + ((((v_70 * v_52) * v_71) * v_81) * v_69)) + (bblExtraDiffuse + bblExtraSpecular)) + v_40;
  if (FragmentUniforms.transmissionOptions.x > 0.5f) {
    let skyDirection = normalize(v_1 - FragmentUniforms.cameraPosition.xyz);
    let skyboxAlphaG = max((v_35 * v_35), 0.00000099999999747524f);
    let skyLod = clamp(
      log2(f32(textureDimensions(environmentTexture).x) * skyboxAlphaG) *
        FragmentUniforms.environmentFactors.z,
      0.0f,
      f32(textureNumLevels(environmentTexture) - 1u),
    );
    shadedColor =
      textureSampleLevel(environmentTexture, environmentSampler, skyDirection, skyLod).rgb *
        v_88 +
      v_40;
  } else if (FragmentUniforms.refractionParams.x > 0.0f) {
    let transmissionSample = textureSample(
      transmissionTexture,
      transmissionSampler,
      v_4,
    ).r;
    let transmissionIntensity = FragmentUniforms.refractionParams.x *
      mix(1.0f, transmissionSample, FragmentUniforms.transmissionOptions.z);
    let thicknessSample = textureSample(
      thicknessTexture,
      thicknessSampler,
      v_4,
    ).g;
    let thickness = FragmentUniforms.refractionParams.z *
      mix(1.0f, thicknessSample, FragmentUniforms.transmissionOptions.w);
    let refractedDirection = refract(
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
    ).rgb * FragmentUniforms.materialFactors.w;
    let absorption = exp(FragmentUniforms.volumeParams.rgb * thickness);
    let environmentReflectance =
      ((v_76 * v_95.x) + (v_75 * v_96)) * v_98 * v_99 * v_99;
    let transmitted = sceneTransmission * v_52 * transmissionIntensity *
      absorption * (vec3<f32>(1.0f) - environmentReflectance);
    let opaqueRatio = 1.0f - transmissionIntensity;
    shadedColor = ((v_89 * v_52) * v_34) * opaqueRatio + v_101 + v_102 + bblExtraSpecular +
      ((((v_70 * v_52) * v_71) * v_81) * v_69) * opaqueRatio + bblExtraDiffuse * opaqueRatio +
      transmitted + v_40;
  }
  let linearColor = select(shadedColor, v_31, vec3<bool>(v_103, v_103, v_103));
  let v_104 = linearColor * FragmentUniforms.environmentFactors.x;
  var v_105 : vec3<f32>;
  if ((FragmentUniforms.environmentFactors.w > 0.5f)) {
    v_105 = (vec3<f32>(1.0f) - exp2((v_104 * -1.59057903289794921875f)));
  } else {
    v_105 = v_104;
  }
  let v_106 = clamp(pow(max(v_105, vec3<f32>()), vec3<f32>(0.45454546809196472168f)), vec3<f32>(), vec3<f32>(1.0f));
  let v_107 = FragmentUniforms.environmentFactors.y;
  var v_108 : vec3<f32>;
  if ((v_107 < 1.0f)) {
    v_108 = mix(vec3<f32>(0.5f), v_106, vec3<f32>(v_107, v_107, v_107));
  } else {
    let v_109 = (v_107 - 1.0f);
    v_108 = mix(v_106, ((v_106 * v_106) * (vec3<f32>(3.0f) - (v_106 * 2.0f))), vec3<f32>(v_109, v_109, v_109));
  }
  let v_110 = v_108;
  let finalColor = select(
    v_108,
    linearColor,
    FragmentUniforms.imageProcessingOptions.x > 0.5f,
  );
  let v_111 = (v_37 > 1.5f);
  var v_112 : f32;
  if (v_111) {
    let v_113 = dot((v_101 + v_102), vec3<f32>(0.21259999275207519531f, 0.71520000696182250977f, 0.07220000028610229492f));
    v_112 = clamp((v_32 + (v_113 * v_113)), 0.0f, 1.0f);
  } else {
    v_112 = v_32;
  }
  v = vec4<f32>(finalColor.x, finalColor.y, finalColor.z, select(1.0f, v_112, v_111));
}

@fragment
fn main(@location(0u) v_114 : vec3<f32>, @location(1u) v_115 : vec3<f32>, @location(2u) v_116 : vec4<f32>, @location(3u) v_117 : vec2<f32>, @location(5u) v_118 : vec4<f32>, @builtin(front_facing) v_119 : bool) -> @location(0u) vec4<f32> {
  main_inner(v_114, v_115, v_116, v_117, v_118, v_119);
  return v;
}
