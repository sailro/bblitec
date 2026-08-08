TextureCube skyboxTexture : register(t0, space2);
SamplerState skyboxSampler : register(s0, space2);

cbuffer SkyboxUniforms : register(b0, space3)
{
    float4 primaryColorExposure;
    float4 backgroundCenter;
    float4 imageParameters;
};

struct FragmentInput
{
    float4 position : SV_Position;
    float3 worldPosition : TEXCOORD0;
    float3 normal : TEXCOORD1;
    float4 tangent : TEXCOORD2;
    float2 uv : TEXCOORD3;
};

float4 main(FragmentInput input) : SV_Target
{
    const float3 direction = normalize(input.worldPosition - backgroundCenter.xyz);
    float3 color =
        skyboxTexture.SampleLevel(skyboxSampler, direction, 0.0).rgb *
        primaryColorExposure.rgb;
    color *= primaryColorExposure.a;
    color = 1.0 - exp2(-1.590579 * color);
    color = pow(max(color, 0.0), 1.0 / 2.2);
    color = saturate(color);
    const float3 highContrast = color * color * (3.0 - 2.0 * color);
    color = lerp(color, highContrast, imageParameters.x - 1.0);
    return float4(max(color, 0.0), 1.0);
}
