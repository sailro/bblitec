cbuffer VertexUniforms : register(b0, space1)
{
    float4x4 viewProjection;
};

struct VertexInput
{
    float3 position : TEXCOORD0;
    float3 normal : TEXCOORD1;
    float2 uv : TEXCOORD2;
};

struct VertexOutput
{
    float4 position : SV_Position;
    float3 normal : TEXCOORD0;
    float2 uv : TEXCOORD1;
};

VertexOutput main(VertexInput input)
{
    VertexOutput output;
    output.position = mul(viewProjection, float4(input.position, 1.0));
    output.normal = input.normal;
    output.uv = input.uv;
    return output;
}
