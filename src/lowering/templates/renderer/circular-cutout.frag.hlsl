struct VertexOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

float4 main(VertexOutput input) : SV_Target
{
    if (distance(input.uv, float2(0.5, 0.5)) < 0.18)
    {
        discard;
    }
    return float4(1.0, 0.25, 0.05, 0.55);
}
