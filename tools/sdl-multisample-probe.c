// Standalone SDL_GPU probe for libsdl-org/SDL#15838: which usage flags a
// multisample texture accepts, and whether the driver can create it.
// No shaders, no window content — creation only, so it runs on any driver.
//
//   cl /nologo ms-probe.c /I<sdl>/include /link <sdl>/lib/SDL3.lib
//   set SDL_ASSERT=always_ignore
//   ms-probe.exe [driver]

#include <SDL3/SDL.h>
#include <stdio.h>

static const char *kUsageNames[] = {
    "SAMPLER",
    "COLOR_TARGET",
    "DEPTH_STENCIL_TARGET",
    "GRAPHICS_STORAGE_READ",
    "COMPUTE_STORAGE_READ",
    "COMPUTE_STORAGE_WRITE",
};

static void describe(SDL_GPUTextureUsageFlags usage, char *out, size_t size)
{
    out[0] = '\0';
    for (int bit = 0; bit < 6; bit += 1) {
        if (usage & (1u << bit)) {
            if (out[0]) SDL_strlcat(out, "|", size);
            SDL_strlcat(out, kUsageNames[bit], size);
        }
    }
    if (!out[0]) SDL_strlcpy(out, "(none)", size);
}

static void probe(SDL_GPUDevice *device,
                  const char *label,
                  SDL_GPUTextureUsageFlags usage,
                  SDL_GPUSampleCount samples,
                  Uint32 levels)
{
    SDL_GPUTextureCreateInfo info;
    SDL_zero(info);
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    info.usage = usage;
    info.width = 256;
    info.height = 256;
    info.layer_count_or_depth = 1;
    info.num_levels = levels;
    info.sample_count = samples;

    char usageText[256];
    describe(usage, usageText, sizeof(usageText));
    SDL_ClearError();
    SDL_GPUTexture *texture = SDL_CreateGPUTexture(device, &info);
    const char *error = SDL_GetError();
    printf("  %-34s %-56s -> %s%s%s\n",
           label,
           usageText,
           texture ? "created" : "REFUSED",
           (!texture && error && error[0]) ? ": " : "",
           (!texture && error && error[0]) ? error : "");
    if (texture) SDL_ReleaseGPUTexture(device, texture);
}

int main(int argc, char **argv)
{
    const char *requested = argc > 1 ? argv[1] : NULL;

    if (!SDL_Init(SDL_INIT_VIDEO)) {
        printf("SDL_Init failed: %s\n", SDL_GetError());
        return 1;
    }
    printf("SDL %d.%d.%d\n",
           SDL_VERSIONNUM_MAJOR(SDL_GetVersion()),
           SDL_VERSIONNUM_MINOR(SDL_GetVersion()),
           SDL_VERSIONNUM_MICRO(SDL_GetVersion()));
    printf("GPU drivers:");
    for (int i = 0; i < SDL_GetNumGPUDrivers(); i += 1) {
        printf(" %s", SDL_GetGPUDriver(i));
    }
    printf("\n");

    SDL_GPUDevice *device = SDL_CreateGPUDevice(
        SDL_GPU_SHADERFORMAT_DXIL | SDL_GPU_SHADERFORMAT_SPIRV |
            SDL_GPU_SHADERFORMAT_MSL,
        true,
        requested);
    if (!device) {
        printf("SDL_CreateGPUDevice(%s) failed: %s\n",
               requested ? requested : "auto",
               SDL_GetError());
        SDL_Quit();
        return 1;
    }
    printf("driver: %s\n\n", SDL_GetGPUDeviceDriver(device));

    for (int index = 0; index < 4; index += 1) {
        const SDL_GPUSampleCount counts[] = {
            SDL_GPU_SAMPLECOUNT_1,
            SDL_GPU_SAMPLECOUNT_2,
            SDL_GPU_SAMPLECOUNT_4,
            SDL_GPU_SAMPLECOUNT_8,
        };
        const char *names[] = {"1x", "2x", "4x", "8x"};
        printf("%s (supported: %s)\n",
               names[index],
               SDL_GPUTextureSupportsSampleCount(
                   device,
                   SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
                   counts[index])
                   ? "yes"
                   : "no");
        probe(device, "colour target only", SDL_GPU_TEXTUREUSAGE_COLOR_TARGET,
              counts[index], 1);
        probe(device, "colour target + sampler",
              SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER,
              counts[index], 1);
        probe(device, "colour target + graphics read",
              SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                  SDL_GPU_TEXTUREUSAGE_GRAPHICS_STORAGE_READ,
              counts[index], 1);
        probe(device, "colour target + compute read",
              SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                  SDL_GPU_TEXTUREUSAGE_COMPUTE_STORAGE_READ,
              counts[index], 1);
        probe(device, "colour target + compute write",
              SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                  SDL_GPU_TEXTUREUSAGE_COMPUTE_STORAGE_WRITE,
              counts[index], 1);
        printf("\n");
    }

    printf("mip levels on a 4x texture\n");
    probe(device, "sampler, num_levels = 2",
          SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER,
          SDL_GPU_SAMPLECOUNT_4, 2);
    printf("\n");

    SDL_DestroyGPUDevice(device);
    SDL_Quit();
    return 0;
}
