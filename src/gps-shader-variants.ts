/**
 * The WGSL point splatting builds at run time (gaussian-point-splatting/
 * gps-shaders.ts, gps-reproject.ts), executed from the pin at generation.
 * SDL_GPU loads each stage precompiled by its text (`wgsl_stage_stem`);
 * Dawn compiles the run-time text itself.
 *
 * The domain is what a native program reaches: a streamed target (spherical
 * harmonics degree 0), one sample per accumulation plane and no scene
 * depth, since sampling the scene pass's depth and linear disc depth are not
 * lowered (library_runtime.hpp `SceneDepthTexture`, the subset's
 * single-format textures).
 */
import {
    importPinnedModule,
    importPinnedModuleWithExports,
} from "./pinned-shader-composer.js";

interface GpsShaders {
    gpsPreprocessShader(stream: boolean, degree: number): string;
    readonly GPS_SCAN_BLOCKS: string;
    readonly GPS_SCAN_SUMS: string;
    readonly GPS_SCAN_ADD: string;
    readonly GPS_PARTITION: string;
    readonly GPS_SPLAT: string;
    readonly GPS_RESOLVE: string;
    readonly GPS_HIZ: string;
    readonly GPS_COMPOSITE: string;
}

interface GpsReproject {
    scatterShader(source: boolean): string;
    readonly GATHER: string;
}

/** Every WGSL text a native point renderer compiles. */
export async function gpsShaderVariants(): Promise<string[]> {
    const shaders = await importPinnedModule<GpsShaders>(
        "gaussian-point-splatting/gps-shaders.js",
    );
    const reproject = await importPinnedModuleWithExports<GpsReproject>(
        "gaussian-point-splatting/gps-reproject.js",
        ["scatterShader", "GATHER"],
    );
    return [
        shaders.gpsPreprocessShader(true, 0),
        shaders.GPS_SCAN_BLOCKS,
        shaders.GPS_SCAN_SUMS,
        shaders.GPS_SCAN_ADD,
        shaders.GPS_PARTITION,
        shaders.GPS_SPLAT,
        shaders.GPS_RESOLVE,
        shaders.GPS_HIZ,
        shaders.GPS_COMPOSITE,
        reproject.scatterShader(false),
        reproject.scatterShader(true),
        reproject.GATHER,
    ];
}
