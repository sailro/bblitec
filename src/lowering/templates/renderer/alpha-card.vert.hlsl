cbuffer CardVertexUniforms : register(b0, space1)
{
    float4 centerAngleDepth;
};

struct VertexInput
{
    float3 position : TEXCOORD0;
};

float4 main(VertexInput input) : SV_Position
{
    const float cosine = cos(centerAngleDepth.z);
    const float sine = sin(centerAngleDepth.z);
    const float2 local = input.position.xy * 1.65;
    const float2 rotated = float2(
        local.x * cosine - local.y * sine,
        local.x * sine + local.y * cosine);
    const float2 world = centerAngleDepth.xy + rotated;
    return float4(world.x / 3.3, world.y / 2.2, 1.0 - centerAngleDepth.w, 1.0);
}
