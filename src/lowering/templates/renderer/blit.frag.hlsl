Texture2D sourceTexture : register(t0, space2);
SamplerState sourceSampler : register(s0, space2);

struct FragmentInput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

float4 main(FragmentInput input) : SV_Target
{
    return sourceTexture.SampleLevel(sourceSampler, input.uv, 0.0);
}
