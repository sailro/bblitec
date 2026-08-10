cbuffer VertexUniforms : register(b0, space1)
{
    float4x4 viewProjection;
};

struct VertexInput
{
    float3 position : TEXCOORD0;
    float3 localPosition : TEXCOORD4;
    float3 localNormal : TEXCOORD7;
};

struct VertexOutput
{
    float4 position : SV_Position;
    float3 localPosition : TEXCOORD0;
    float3 localNormal : TEXCOORD1;
};

VertexOutput main(VertexInput input)
{
    VertexOutput output;
    output.position =
        mul(viewProjection, float4(input.position, 1.0));
    output.localPosition = input.localPosition;
    output.localNormal = input.localNormal;
    return output;
}
