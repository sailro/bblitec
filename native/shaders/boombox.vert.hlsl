cbuffer VertexUniforms : register(b0, space1)
{
    float4x4 viewProjection;
};

struct VertexInput
{
    float3 position : TEXCOORD0;
    float3 normal : TEXCOORD1;
    float4 tangent : TEXCOORD2;
    float2 uv : TEXCOORD3;
};

struct VertexOutput
{
    float4 position : SV_Position;
    float3 worldPosition : TEXCOORD0;
    float3 normal : TEXCOORD1;
    float4 tangent : TEXCOORD2;
    float2 uv : TEXCOORD3;
};

VertexOutput main(VertexInput input)
{
    VertexOutput output;
    output.position = mul(viewProjection, float4(input.position, 1.0));
    output.worldPosition = input.position;
    output.normal = input.normal;
    output.tangent = input.tangent;
    output.uv = input.uv;
    return output;
}
