Texture2D baseColorTexture : register(t0, space2);
SamplerState baseColorSampler : register(s0, space2);
Texture2D metallicRoughnessTexture : register(t1, space2);
SamplerState metallicRoughnessSampler : register(s1, space2);
Texture2D normalTexture : register(t2, space2);
SamplerState normalSampler : register(s2, space2);
Texture2D emissiveTexture : register(t3, space2);
SamplerState emissiveSampler : register(s3, space2);
TextureCube environmentTexture : register(t4, space2);
SamplerState environmentSampler : register(s4, space2);
Texture2D brdfTexture : register(t5, space2);
SamplerState brdfSampler : register(s5, space2);

cbuffer FragmentUniforms : register(b0, space3)
{
    float4 lightDirection;
    float4 lightColor;
    float4 groundColor;
    float4 cameraPosition;
    float4 baseColorFactor;
    float4 emissiveFactor;
    float4 materialFactors;
    float4 environmentFactors;
    float4 materialOptions;
    float4 sphericalHarmonics[9];
};

struct FragmentInput
{
    float4 position : SV_Position;
    float3 worldPosition : TEXCOORD0;
    float3 normal : TEXCOORD1;
    float4 tangent : TEXCOORD2;
    float2 uv : TEXCOORD3;
};

#if defined(BBLITE_DIAGNOSTICS)
struct FragmentOutput
{
    float4 color : SV_Target0;
    float4 normal : SV_Target1;
    float4 material : SV_Target2;
    float4 direct : SV_Target3;
    float4 ibl : SV_Target4;
    float4 depth : SV_Target5;
};
#endif

static const float PI = 3.14159265358979323846;

float3 evaluateIrradiance(float3 normal)
{
    if (materialFactors.w < 0.5)
    {
        return 0.25;
    }
    float3 result = sphericalHarmonics[0].rgb;
    result += sphericalHarmonics[1].rgb * normal.y;
    result += sphericalHarmonics[2].rgb * normal.z;
    result += sphericalHarmonics[3].rgb * normal.x;
    result += sphericalHarmonics[4].rgb * normal.y * normal.x;
    result += sphericalHarmonics[5].rgb * normal.y * normal.z;
    result += sphericalHarmonics[6].rgb * (3.0 * normal.z * normal.z - 1.0);
    result += sphericalHarmonics[7].rgb * normal.z * normal.x;
    result += sphericalHarmonics[8].rgb * (normal.x * normal.x - normal.y * normal.y);
    return clamp(result, 0.0, 4.0);
}

float distributionGGX(float nDotH, float alphaG)
{
    const float a2 = alphaG * alphaG;
    const float denominator = nDotH * nDotH * (a2 - 1.0) + 1.0;
    return a2 / max(PI * denominator * denominator, 0.0001);
}

float geometrySmithGGX(float nDotL, float nDotV, float alphaG)
{
    const float a2 = alphaG * alphaG;
    const float gl = nDotL * sqrt(nDotV * (nDotV - a2 * nDotV) + a2);
    const float gv = nDotV * sqrt(nDotL * (nDotL - a2 * nDotL) + a2);
    return 0.5 / max(gl + gv, 0.00001);
}

float3 fresnelSchlick(float cosine, float3 f0)
{
    return f0 + (1.0 - f0) * pow(1.0 - cosine, 5.0);
}

#if defined(BBLITE_DIAGNOSTICS)
FragmentOutput main(FragmentInput input)
#else
float4 main(FragmentInput input) : SV_Target
#endif
{
    const float3 geometricNormal = normalize(input.normal);
    const float3 tangent = normalize(input.tangent.xyz - geometricNormal * dot(input.tangent.xyz, geometricNormal));
    const float3 bitangent = normalize(cross(geometricNormal, tangent)) * input.tangent.w;
    const float3 sampledNormal = normalTexture.Sample(normalSampler, input.uv).xyz * 2.0 - 1.0;
    const float3 normal = normalize(
        tangent * sampledNormal.x +
        bitangent * sampledNormal.y +
        geometricNormal * sampledNormal.z);
    const float4 baseColorSample = baseColorTexture.Sample(baseColorSampler, input.uv);
    const float3 albedo = baseColorSample.rgb * baseColorFactor.rgb;
    const float alpha = baseColorSample.a * baseColorFactor.a;
    const float3 packed = metallicRoughnessTexture.Sample(metallicRoughnessSampler, input.uv).rgb;
    const float occlusion = packed.r;
    const float roughness = clamp(packed.g * materialFactors.y, 0.04, 1.0);
    const float metallic = saturate(packed.b * materialFactors.x);
    if (materialOptions.x > 0.5 && materialOptions.x < 1.5 && alpha < materialOptions.y)
    {
        discard;
    }
    const float3 emissive = emissiveTexture.Sample(emissiveSampler, input.uv).rgb * emissiveFactor.rgb;
    const float3 viewDirection = normalize(cameraPosition.xyz - input.worldPosition);
    const float nDotVUnclamped = dot(normal, viewDirection);
    const float nDotV = abs(nDotVUnclamped) + 0.0000001;
    const float3 normalDx = ddx(normal);
    const float3 normalDy = ddy(normal);
    const float slopeSquare = max(dot(normalDx, normalDx), dot(normalDy, normalDy));
    const float aaRoughness = pow(saturate(slopeSquare), 0.3333333333);
    const float aaAlpha = sqrt(slopeSquare) * 0.75;
    const float alphaG = roughness * roughness + 0.0005 + aaAlpha;
    const float directRoughness = max(roughness, aaRoughness);
    const float directAlphaG = directRoughness * directRoughness + 0.0005;
    const float3 surfaceAlbedo = albedo * (1.0 - 0.04) * (1.0 - metallic);
    const float3 lightDirectionNormalized = normalize(lightDirection.xyz);
    const float3 halfDirection = normalize(viewDirection + lightDirectionNormalized);
    const float nDotL = clamp(dot(normal, lightDirectionNormalized) * 0.5 + 0.5, 0.0000001, 1.0);
    const float nDotH = saturate(dot(normal, halfDirection));
    const float vDotH = saturate(dot(viewDirection, halfDirection));
    const float3 f0 = lerp(float3(0.04, 0.04, 0.04), albedo, metallic);
    const float3 fresnel = fresnelSchlick(vDotH, f0);
    const float distribution = distributionGGX(nDotH, directAlphaG);
    const float geometry = geometrySmithGGX(nDotL, nDotV, directAlphaG);
    const float3 directSpecular =
        fresnel * distribution * geometry * nDotL * lightColor.rgb * lightColor.a;
    const float3 groundSky = lerp(groundColor.rgb, lightColor.rgb, nDotL);
    const float3 directDiffuse = groundSky * surfaceAlbedo * lightColor.a;

    const float3 irradiance = evaluateIrradiance(normal);
    const float3 reflection = reflect(-viewDirection, normal);
    uint cubeWidth = 1;
    uint cubeHeight = 1;
    uint mipLevels = 1;
    environmentTexture.GetDimensions(0, cubeWidth, cubeHeight, mipLevels);
    const float mipLevel = clamp(
        log2(max(float(cubeWidth) * alphaG, 1.0)) * environmentFactors.z,
        0.0,
        float(mipLevels - 1));
    float3 environmentRadiance =
        environmentTexture.SampleLevel(environmentSampler, reflection, mipLevel).rgb;
    environmentRadiance = lerp(environmentRadiance, irradiance, alphaG);
    const float2 brdf = brdfTexture.Sample(brdfSampler, float2(nDotV, roughness)).rg;
    const float3 environmentReflectance = (1.0 - f0) * brdf.x + f0 * brdf.y;
    const float specularOcclusion = saturate(
        (nDotVUnclamped + occlusion) * (nDotVUnclamped + occlusion) -
        1.0 +
        occlusion);
    const float horizon = saturate(1.0 + 1.1 * dot(reflection, geometricNormal));
    const float3 colorSpecularEnvironment =
        environmentReflectance * specularOcclusion * horizon * horizon;
    const float3 energyConservation =
        1.0 + f0 * (1.0 / max(brdf.y, 0.001) - 1.0);
    const float3 finalIrradiance = irradiance * surfaceAlbedo * occlusion;
    const float3 finalRadiance =
        environmentRadiance * colorSpecularEnvironment * energyConservation;
    const float3 finalDirectSpecular = directSpecular * energyConservation;
    float3 color =
        finalIrradiance +
        finalRadiance +
        finalDirectSpecular +
        directDiffuse +
        emissive;
    color *= environmentFactors.x;
    if (environmentFactors.w > 0.5)
    {
        color = 1.0 - exp2(-1.590579 * color);
    }
    color = pow(max(color, 0.0), 1.0 / 2.2);
    color = saturate(color);
    const float3 highContrast = color * color * (3.0 - 2.0 * color);
    color = environmentFactors.y < 1.0
        ? lerp(float3(0.5, 0.5, 0.5), color, environmentFactors.y)
        : lerp(color, highContrast, environmentFactors.y - 1.0);
#if defined(BBLITE_DIAGNOSTICS)
    FragmentOutput output;
    output.color = float4(color, materialOptions.x > 1.5 ? alpha : 1.0);
    output.normal = float4(normal * 0.5 + 0.5, 1.0);
    output.material = float4(roughness, metallic, occlusion, 1.0);
    output.direct = float4(saturate(finalDirectSpecular + directDiffuse), 1.0);
    output.ibl = float4(saturate(finalIrradiance + finalRadiance), 1.0);
    output.depth = float4(input.position.z, input.position.z, input.position.z, 1.0);
    return output;
#else
    return float4(color, materialOptions.x > 1.5 ? alpha : 1.0);
#endif
}
