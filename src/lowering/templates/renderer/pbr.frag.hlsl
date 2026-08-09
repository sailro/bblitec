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
    float4 cameraForwardNear;
    float4 viewRight;
    float4 viewUp;
    float4 viewForward;
    float4 baseColorFactor;
    float4 emissiveFactor;
    float4 materialFactors;
    float4 environmentFactors;
    float4 materialOptions;
    float4 normalOptions;
    float4 sphericalHarmonics[9];
};

struct FragmentInput
{
    float4 position : SV_Position;
    float3 worldPosition : TEXCOORD0;
    float3 normal : TEXCOORD1;
    float4 tangent : TEXCOORD2;
    float2 uv : TEXCOORD3;
    float3 localPosition : TEXCOORD4;
    bool frontFacing : SV_IsFrontFace;
};

#if defined(BBLITE_GEOMETRY_OUTPUT)
struct FragmentOutput
{
    BBLITE_GEOMETRY_OUTPUT_STRUCT
};
#elif defined(BBLITE_DIAGNOSTICS_A)
struct FragmentOutput
{
    float4 normal : SV_Target0;
    float4 reflectivity : SV_Target1;
    float4 irradiance : SV_Target2;
    float4 ibl : SV_Target3;
};
#elif defined(BBLITE_DIAGNOSTICS_B)
struct FragmentOutput
{
    float4 depth : SV_Target0;
    float4 albedo : SV_Target1;
    float4 direct : SV_Target2;
};
#endif

static const float PI = 3.14159265358979323846;

float3 evaluateIrradiance(float3 normal)
{
    if (materialFactors.w < 0.5)
    {
        return 0.0;
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
    return a2 / (PI * denominator * denominator);
}

float geometrySmithGGX(float nDotL, float nDotV, float alphaG)
{
    const float a2 = alphaG * alphaG;
    const float gl = nDotL * sqrt(nDotV * (nDotV - a2 * nDotV) + a2);
    const float gv = nDotV * sqrt(nDotL * (nDotL - a2 * nDotL) + a2);
    return 0.5 / (gl + gv);
}

float3 fresnelSchlick(float cosine, float3 f0)
{
    return f0 + (1.0 - f0) * pow(1.0 - cosine, 5.0);
}

#if defined(BBLITE_GEOMETRY_OUTPUT) || defined(BBLITE_DIAGNOSTICS_A) || defined(BBLITE_DIAGNOSTICS_B)
FragmentOutput main(FragmentInput input)
#else
float4 main(FragmentInput input) : SV_Target
#endif
{
    float3 geometricNormal = normalize(input.normal);
    const float3 sampledNormal = normalTexture.Sample(normalSampler, input.uv).xyz * 2.0 - 1.0;
    float3 normal;
    if (normalOptions.y < 0.5)
    {
        normal = geometricNormal;
    }
    else if (normalOptions.x > 0.5)
    {
        const float3 positionDx = ddx(input.worldPosition);
        const float3 positionDy = ddy(input.worldPosition);
        const float2 uvDx = ddx(input.uv);
        const float2 uvDy = ddy(input.uv);
        const float3 positionDyPerpendicular = cross(positionDy, geometricNormal);
        const float3 positionDxPerpendicular = cross(geometricNormal, positionDx);
        const float3 cotangent =
            positionDyPerpendicular * uvDx.x + positionDxPerpendicular * uvDy.x;
        const float3 cobitangent =
            -(positionDyPerpendicular * uvDx.y + positionDxPerpendicular * uvDy.y);
        const float determinant =
            max(dot(cotangent, cotangent), dot(cobitangent, cobitangent));
        const float inverseMaximum = determinant > 0.0 ? rsqrt(determinant) : 0.0;
        normal = normalize(
            cotangent * inverseMaximum * sampledNormal.x +
            cobitangent * inverseMaximum * sampledNormal.y +
            geometricNormal * sampledNormal.z);
    }
    else
    {
        const float3 tangent =
            normalize(input.tangent.xyz - geometricNormal * dot(input.tangent.xyz, geometricNormal));
        const float3 bitangent = normalize(cross(geometricNormal, tangent)) * input.tangent.w;
        normal = normalize(
            tangent * sampledNormal.x +
            bitangent * sampledNormal.y +
            geometricNormal * sampledNormal.z);
    }
    if (materialOptions.w > 0.5 && !input.frontFacing)
    {
        geometricNormal = -geometricNormal;
        normal = -normal;
    }
    const float4 baseColorSample = baseColorTexture.Sample(baseColorSampler, input.uv);
    const float3 albedo = baseColorSample.rgb * baseColorFactor.rgb;
    const float alpha = baseColorSample.a * baseColorFactor.a;
    const float3 packed = metallicRoughnessTexture.Sample(metallicRoughnessSampler, input.uv).rgb;
    const float occlusion = lerp(1.0, packed.r, materialFactors.z);
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
    const float nDotH = clamp(dot(normal, halfDirection), 0.0000001, 1.0);
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
        environmentRadiance * colorSpecularEnvironment * energyConservation *
        materialFactors.w;
    const float3 finalDirectSpecular =
        directSpecular * lerp(float3(1.0, 1.0, 1.0), energyConservation, materialFactors.w);
    float3 color =
        finalIrradiance +
        finalRadiance +
        finalDirectSpecular +
        directDiffuse +
        emissive;
    if (materialOptions.z > 0.5)
    {
        color = albedo;
    }
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
#if defined(BBLITE_GEOMETRY_OUTPUT)
    FragmentOutput output;
    BBLITE_GEOMETRY_OUTPUT_WRITES
    return output;
#elif defined(BBLITE_DIAGNOSTICS_A)
    FragmentOutput output;
    output.normal = float4(normal * 0.5 + 0.5, 1.0);
    output.reflectivity = float4(f0, 1.0 - roughness);
    output.irradiance = float4(saturate(directDiffuse + finalIrradiance), 1.0);
    output.ibl = float4(saturate(finalIrradiance + finalRadiance), 1.0);
    return output;
#elif defined(BBLITE_DIAGNOSTICS_B)
    FragmentOutput output;
    const float viewDepth =
        dot(input.worldPosition - cameraPosition.xyz, cameraForwardNear.xyz);
    const float normalizedDepth =
        (viewDepth - cameraForwardNear.w) /
        max(cameraPosition.w - cameraForwardNear.w, 0.0001);
    output.depth = float4(normalizedDepth, normalizedDepth, normalizedDepth, 1.0);
    output.albedo = float4(surfaceAlbedo, 1.0);
    output.direct = float4(saturate(directDiffuse + finalDirectSpecular), 1.0);
    return output;
#else
    return float4(color, materialOptions.x > 1.5 ? alpha : 1.0);
#endif
}
