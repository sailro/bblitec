cbuffer CardFragmentUniforms : register(b0, space3)
{
    float4 colorOpacity;
};

float4 main() : SV_Target
{
    return colorOpacity;
}
