#pragma once

#define BBLITE_COMPRESSED_FORMATS(F) \
    F(bc1_rgba_unorm, "bc1-rgba-unorm", BC1_RGBA_UNORM, BC1RGBAUnorm) \
    F(bc2_rgba_unorm, "bc2-rgba-unorm", BC2_RGBA_UNORM, BC2RGBAUnorm) \
    F(bc3_rgba_unorm, "bc3-rgba-unorm", BC3_RGBA_UNORM, BC3RGBAUnorm) \
    F(bc7_rgba_unorm, "bc7-rgba-unorm", BC7_RGBA_UNORM, BC7RGBAUnorm) \
    F(bc7_rgba_unorm_srgb, "bc7-rgba-unorm-srgb", BC7_RGBA_UNORM_SRGB, BC7RGBAUnormSrgb) \
    F(astc_4x4_unorm, "astc-4x4-unorm", ASTC_4x4_UNORM, ASTC4x4Unorm) \
    F(astc_4x4_unorm_srgb, "astc-4x4-unorm-srgb", ASTC_4x4_UNORM_SRGB, ASTC4x4UnormSrgb) \
    F(astc_5x4_unorm, "astc-5x4-unorm", ASTC_5x4_UNORM, ASTC5x4Unorm) \
    F(astc_5x4_unorm_srgb, "astc-5x4-unorm-srgb", ASTC_5x4_UNORM_SRGB, ASTC5x4UnormSrgb) \
    F(astc_5x5_unorm, "astc-5x5-unorm", ASTC_5x5_UNORM, ASTC5x5Unorm) \
    F(astc_5x5_unorm_srgb, "astc-5x5-unorm-srgb", ASTC_5x5_UNORM_SRGB, ASTC5x5UnormSrgb) \
    F(astc_6x5_unorm, "astc-6x5-unorm", ASTC_6x5_UNORM, ASTC6x5Unorm) \
    F(astc_6x5_unorm_srgb, "astc-6x5-unorm-srgb", ASTC_6x5_UNORM_SRGB, ASTC6x5UnormSrgb) \
    F(astc_6x6_unorm, "astc-6x6-unorm", ASTC_6x6_UNORM, ASTC6x6Unorm) \
    F(astc_6x6_unorm_srgb, "astc-6x6-unorm-srgb", ASTC_6x6_UNORM_SRGB, ASTC6x6UnormSrgb) \
    F(astc_8x5_unorm, "astc-8x5-unorm", ASTC_8x5_UNORM, ASTC8x5Unorm) \
    F(astc_8x5_unorm_srgb, "astc-8x5-unorm-srgb", ASTC_8x5_UNORM_SRGB, ASTC8x5UnormSrgb) \
    F(astc_8x6_unorm, "astc-8x6-unorm", ASTC_8x6_UNORM, ASTC8x6Unorm) \
    F(astc_8x6_unorm_srgb, "astc-8x6-unorm-srgb", ASTC_8x6_UNORM_SRGB, ASTC8x6UnormSrgb) \
    F(astc_8x8_unorm, "astc-8x8-unorm", ASTC_8x8_UNORM, ASTC8x8Unorm) \
    F(astc_8x8_unorm_srgb, "astc-8x8-unorm-srgb", ASTC_8x8_UNORM_SRGB, ASTC8x8UnormSrgb) \
    F(astc_10x5_unorm, "astc-10x5-unorm", ASTC_10x5_UNORM, ASTC10x5Unorm) \
    F(astc_10x5_unorm_srgb, "astc-10x5-unorm-srgb", ASTC_10x5_UNORM_SRGB, ASTC10x5UnormSrgb) \
    F(astc_10x6_unorm, "astc-10x6-unorm", ASTC_10x6_UNORM, ASTC10x6Unorm) \
    F(astc_10x6_unorm_srgb, "astc-10x6-unorm-srgb", ASTC_10x6_UNORM_SRGB, ASTC10x6UnormSrgb) \
    F(astc_10x8_unorm, "astc-10x8-unorm", ASTC_10x8_UNORM, ASTC10x8Unorm) \
    F(astc_10x8_unorm_srgb, "astc-10x8-unorm-srgb", ASTC_10x8_UNORM_SRGB, ASTC10x8UnormSrgb) \
    F(astc_10x10_unorm, "astc-10x10-unorm", ASTC_10x10_UNORM, ASTC10x10Unorm) \
    F(astc_10x10_unorm_srgb, "astc-10x10-unorm-srgb", ASTC_10x10_UNORM_SRGB, ASTC10x10UnormSrgb) \
    F(astc_12x10_unorm, "astc-12x10-unorm", ASTC_12x10_UNORM, ASTC12x10Unorm) \
    F(astc_12x10_unorm_srgb, "astc-12x10-unorm-srgb", ASTC_12x10_UNORM_SRGB, ASTC12x10UnormSrgb) \
    F(astc_12x12_unorm, "astc-12x12-unorm", ASTC_12x12_UNORM, ASTC12x12Unorm) \
    F(astc_12x12_unorm_srgb, "astc-12x12-unorm-srgb", ASTC_12x12_UNORM_SRGB, ASTC12x12UnormSrgb)
