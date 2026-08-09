Texture2D diffuseTexture : register(t0, space2);
SamplerState diffuseSampler : register(s0, space2);
Texture2D specularTexture : register(t1, space2);
SamplerState specularSampler : register(s1, space2);
Texture2D opacityTexture : register(t2, space2);
SamplerState opacitySampler : register(s2, space2);
Texture2D ambientTexture : register(t3, space2);
SamplerState ambientSampler : register(s3, space2);
TextureCube reflectionTexture : register(t4, space2);
SamplerState reflectionSampler : register(s4, space2);
Texture2D emissiveTexture : register(t5, space2);
SamplerState emissiveSampler : register(s5, space2);

cbuffer FragmentUniforms : register(b0, space3)
{
    float4 cameraPosition;
    float4 cameraForwardNear;
    float4 viewRight;
    float4 viewUp;
    float4 viewForward;
    float4 lightData;
    float4 lightDiffuse;
    float4 lightSpecular;
    float4 lightDirection;
    float4 diffuseAlpha;
    float4 specularPower;
    float4 emissiveLevel;
    float4 ambientLevel;
    float4 textureOptions;
    float4 uvOptions;
    float4 materialOptions;
    float4 reflectionOptions;
};

struct FragmentInput
{
    float4 position : SV_Position;
    float3 worldPosition : TEXCOORD0;
    float3 normal : TEXCOORD1;
    float4 tangent : TEXCOORD2;
    float2 uv : TEXCOORD3;
    float3 localPosition : TEXCOORD4;
    float2 uv2 : TEXCOORD5;
    bool frontFacing : SV_IsFrontFace;
};

#if defined(BBLITE_GEOMETRY_OUTPUT)
struct FragmentOutput
{
    BBLITE_GEOMETRY_OUTPUT_STRUCT
};
#endif

#if defined(BBLITE_GEOMETRY_OUTPUT)
FragmentOutput main(FragmentInput input)
#else
float4 main(FragmentInput input) : SV_Target
#endif
{
    float3 normalW = normalize(input.normal);
    if (materialOptions.x > 0.5 && !input.frontFacing)
    {
        normalW = -normalW;
    }
    const float2 diffuseUv = input.uv * uvOptions.xy;
    const float4 diffuseSample = textureOptions.x > 0.5
        ? diffuseTexture.Sample(diffuseSampler, diffuseUv)
        : float4(1.0, 1.0, 1.0, 1.0);
    if (diffuseSample.a < materialOptions.y)
    {
        discard;
    }
    const float3 baseColor = diffuseSample.rgb * emissiveLevel.w;
    const float4 emissiveSample = reflectionOptions.z > 0.5
        ? emissiveTexture.Sample(emissiveSampler, input.uv)
        : float4(0.0, 0.0, 0.0, 0.0);
    const float3 emissiveTextureColor = emissiveSample.rgb;
    const float3 emissiveContrib =
        emissiveLevel.rgb + emissiveTextureColor * emissiveLevel.w;
    float alpha = diffuseAlpha.a;
    if (textureOptions.z > 0.5)
    {
        alpha *= opacityTexture.Sample(opacitySampler, input.uv).a *
            materialOptions.z;
    }
    const float2 specularUv = uvOptions.z > 0.5 ? input.uv2 : input.uv;
    const float4 specularSample = textureOptions.y > 0.5
        ? specularTexture.Sample(specularSampler, specularUv)
        : float4(specularPower.rgb, 1.0);
    const float3 specularColor = specularSample.rgb;
    const float2 ambientUv = uvOptions.w > 0.5 ? input.uv2 : input.uv;
    const float3 baseAmbientColor = textureOptions.w > 0.5
        ? ambientTexture.Sample(ambientSampler, ambientUv).rgb *
            ambientLevel.w
        : float3(1.0, 1.0, 1.0);
    const float3 viewDirectionW =
        normalize(cameraPosition.xyz - input.worldPosition);
    float3 diffuseBase;
    float3 specularBase;
    if (lightData.w > 2.5)
    {
        const float nDotL =
            0.5 + 0.5 * dot(normalW, normalize(lightData.xyz));
        diffuseBase = lerp(
            lightDirection.rgb,
            lightDiffuse.rgb,
            nDotL);
        const float3 halfDirection =
            normalize(viewDirectionW + normalize(lightData.xyz));
        const float specularTerm = pow(
            max(0.0, dot(normalW, halfDirection)),
            max(1.0, specularPower.w));
        specularBase = specularTerm * lightSpecular.rgb;
    }
    else
    {
        const bool directionalLight =
            lightData.w > 0.5 && lightData.w < 1.5;
        const float3 lightVector =
            lightData.xyz - input.worldPosition;
        const float lightDistance = length(lightVector);
        const float attenuation =
            !directionalLight && lightDiffuse.a > 0.0
                ? max(
                      0.0,
                      1.0 - lightDistance / lightDiffuse.a)
                : 1.0;
        const float3 resolvedLightDirection = directionalLight
            ? normalize(-lightData.xyz)
            : lightDistance > 0.000001
                ? lightVector / lightDistance
                : float3(0.0, 1.0, 0.0);
        const float nDotL =
            max(0.0, dot(normalW, resolvedLightDirection));
        diffuseBase =
            nDotL * lightDiffuse.rgb * attenuation;
        const float3 halfDirection =
            normalize(viewDirectionW + resolvedLightDirection);
        const float specularTerm = pow(
            max(0.0, dot(normalW, halfDirection)),
            max(1.0, specularPower.w));
        specularBase =
            specularTerm * lightSpecular.rgb * attenuation;
    }
    const float3 finalDiffuse = clamp(
        diffuseBase * diffuseAlpha.rgb +
            emissiveContrib +
            ambientLevel.rgb,
        0.0,
        1.0) * baseColor;
    const float3 finalSpecular = specularBase * specularColor;
    const float3 viewFromCamera =
        normalize(input.worldPosition - cameraPosition.xyz);
    const float3 reflectionColor = reflectionOptions.x > 0.5
        ? reflectionTexture.Sample(
              reflectionSampler,
              reflect(viewFromCamera, normalW)).rgb *
            reflectionOptions.y
        : float3(0.0, 0.0, 0.0);
    const float3 litColor =
        finalDiffuse * baseAmbientColor +
        finalSpecular +
        reflectionColor;
    const float3 unlitColor =
        clamp(emissiveContrib * diffuseAlpha.rgb, 0.0, 1.0) *
        baseColor;
    const float4 color = float4(
        max(materialOptions.w > 0.5 ? unlitColor : litColor, 0.0),
        alpha);
#if defined(BBLITE_GEOMETRY_OUTPUT)
    FragmentOutput output;
    BBLITE_GEOMETRY_OUTPUT_WRITES
    return output;
#else
    return color;
#endif
}
