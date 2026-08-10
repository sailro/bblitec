cbuffer GridUniforms : register(b0, space3)
{
    float4 gridControl;
    float4 mainColor;
    float4 lineColor;
    float4 gridOffsetVisibility;
    float4 options;
};

struct FragmentInput
{
    float4 position : SV_Position;
    float3 localPosition : TEXCOORD0;
    float3 localNormal : TEXCOORD1;
};

static const float SQRT2 = 1.41421356;
static const float PI = 3.14159;

float gridDynamicVisibility(float position)
{
    const float frequency = gridControl.y;
    if (
        floor(position + 0.5) ==
        floor(position / frequency + 0.5) * frequency)
    {
        return 1.0;
    }
    return gridControl.z;
}

float gridAniso(float derivative)
{
    return clamp(
        1.0 / (derivative + 1.0) - 1.0 / 10.0,
        0.0,
        1.0);
}

float gridIsOnLine(float position, float derivative)
{
    float fraction =
        position - floor(position + 0.5);
    fraction /= derivative;
    if (options.y > 0.5)
    {
        fraction = clamp(fraction, -1.0, 1.0);
        return 0.5 + 0.5 * cos(fraction * PI);
    }
    return abs(fraction) < SQRT2 / 4.0
        ? 1.0
        : 0.0;
}

float gridContrib(float position)
{
    float derivative =
        length(float2(ddx(position), ddy(position)));
    derivative *= SQRT2;
    float result = gridIsOnLine(position, derivative);
    result *= gridDynamicVisibility(position);
    result *= gridAniso(derivative);
    return result;
}

float gridNormalImpact(float value)
{
    return clamp(
        1.0 - 3.0 * abs(value * value * value),
        0.0,
        1.0);
}

float4 main(FragmentInput input) : SV_Target
{
    const float3 gridPosition =
        (input.localPosition + gridOffsetVisibility.xyz) /
        gridControl.x;
    float x = gridContrib(gridPosition.x);
    float y = gridContrib(gridPosition.y);
    float z = gridContrib(gridPosition.z);
    const float3 normal = normalize(input.localNormal);
    x *= gridNormalImpact(normal.x);
    y *= gridNormalImpact(normal.y);
    z *= gridNormalImpact(normal.z);
    const float grid = options.z > 0.5
        ? clamp(max(max(x, y), z), 0.0, 1.0)
        : clamp(x + y + z, 0.0, 1.0);
    float3 rgb = lerp(mainColor.rgb, lineColor.rgb, grid);
    float opacity = options.x > 0.5
        ? clamp(grid, 0.08, gridControl.w * grid)
        : 1.0;
    if (options.x > 0.5 && options.w > 0.5)
    {
        rgb *= opacity;
    }
    return float4(
        rgb,
        opacity * gridOffsetVisibility.w);
}
