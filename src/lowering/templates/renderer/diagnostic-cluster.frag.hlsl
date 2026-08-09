Texture2D baseColorTexture : register(t0, space2);
SamplerState baseColorSampler : register(s0, space2);

cbuffer ClusterUniforms : register(b0, space3)
{
    uint4 clusterOptions;
    float4 alphaOptions;
};

struct FragmentInput
{
    float4 position : SV_Position;
    float3 worldPosition : TEXCOORD0;
    float3 normal : TEXCOORD1;
    float4 tangent : TEXCOORD2;
    float2 uv : TEXCOORD3;
};

float4 main(FragmentInput input, uint primitiveId : SV_PrimitiveID) : SV_Target
{
    const float alpha =
        baseColorTexture.Sample(baseColorSampler, input.uv).a *
        alphaOptions.z;
    if (
        (alphaOptions.x > 0.5 && alphaOptions.x < 1.5 && alpha < alphaOptions.y) ||
        (alphaOptions.x > 1.5 && alpha <= 0.0))
    {
        discard;
    }
    const uint clusterId =
        clusterOptions.x + primitiveId / max(clusterOptions.y, 1u);
    return float4(
        float(clusterId & 0xffu) / 255.0,
        float((clusterId >> 8) & 0xffu) / 255.0,
        float((clusterId >> 16) & 0xffu) / 255.0,
        1.0);
}
