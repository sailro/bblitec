Texture2D baseColorTexture : register(t0, space2);
SamplerState baseColorSampler : register(s0, space2);
Texture2D emissiveTexture : register(t1, space2);
SamplerState emissiveSampler : register(s1, space2);

cbuffer FragmentUniforms : register(b0, space3)
{
    float4 lightDirection;
    float4 baseColorFactor;
    float4 emissiveFactor;
};

struct FragmentInput
{
    float4 position : SV_Position;
    float3 normal : TEXCOORD0;
    float2 uv : TEXCOORD1;
};

float4 main(FragmentInput input) : SV_Target
{
    const float3 normal = normalize(input.normal);
    const float hemisphere = saturate(dot(normal, normalize(lightDirection.xyz)) * 0.5 + 0.5);
    const float3 albedo = baseColorTexture.Sample(baseColorSampler, input.uv).rgb * baseColorFactor.rgb;
    const float3 emissive = emissiveTexture.Sample(emissiveSampler, input.uv).rgb * emissiveFactor.rgb;
    const float3 color = albedo * (0.25 + 0.75 * hemisphere) + emissive;
    return float4(color, baseColorFactor.a);
}
