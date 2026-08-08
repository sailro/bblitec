Texture2D groundTexture : register(t0, space2);
SamplerState groundSampler : register(s0, space2);

cbuffer GroundUniforms : register(b0, space3)
{
    float4 primaryColorAlpha;
    float4 backgroundCenter;
    float4 cameraExposure;
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
    const float4 sampleValue = groundTexture.Sample(groundSampler, input.uv);
    float3 color = max(sampleValue.rgb, 0.0) * primaryColorAlpha.rgb;
    float alpha = primaryColorAlpha.a * sampleValue.a;
    const float3 normal = normalize(input.normal);
    const float facing = dot(
        normal,
        normalize(cameraExposure.xyz - backgroundCenter.xyz));
    const float fade = saturate(facing / 0.1);
    alpha *= fade * fade;
    color *= cameraExposure.w;
    if (imageParameters.y > 0.5)
    {
        color = 1.0 - exp2(-1.590579 * color);
    }
    color = pow(max(color, 0.0), 1.0 / 2.2);
    color = saturate(color);
    const float3 highContrast = color * color * (3.0 - 2.0 * color);
    color = imageParameters.x < 1.0
        ? lerp(float3(0.5, 0.5, 0.5), color, imageParameters.x)
        : lerp(color, highContrast, imageParameters.x - 1.0);
    return float4(color * alpha, alpha);
}
