/** Build-shape decisions shared by the scene command and its tests. */

export const DEVELOPMENT_VCPKG_INSTALL = "development-full";

/** The pinned Dawn development install is currently a Windows D3D12 build. */
export function defaultDevelopmentBackend(
    platform: NodeJS.Platform,
): "SDL_GPU" | "BOTH" {
    return platform === "win32" ? "BOTH" : "SDL_GPU";
}

export type OfflineShaderTarget = "d3d12" | "vulkan" | "metal" | "all";

/** Dawn consumes WGSL directly; an explicit offline target still requests a sweep. */
export function needsOfflineShaders(backend: string, requestedTarget?: string): boolean {
    return backend !== "DAWN" || requestedTarget !== undefined;
}

export function canonicalOfflineShaderTarget(
    value: string,
): OfflineShaderTarget {
    const canonical = value.toLowerCase();
    if (
        canonical === "d3d12" ||
        canonical === "vulkan" ||
        canonical === "metal" ||
        canonical === "all"
    ) {
        return canonical;
    }
    throw new Error(
        `--shader must be d3d12|vulkan|metal|all (got '${value}').`,
    );
}

/** The one offline format the current host can execute and validate. */
export function hostOfflineShaderTarget(
    platform: NodeJS.Platform,
    override?: string,
): OfflineShaderTarget {
    if (override !== undefined) {
        return canonicalOfflineShaderTarget(override);
    }
    if (platform === "win32") return "d3d12";
    if (platform === "darwin") return "metal";
    return "vulkan";
}

/**
 * Every optional manifest feature belongs in the reusable development install.
 * Scene feature selection still decides what the application compiles and
 * links; the full dependency set only prevents an all-scene build from
 * reconciling one mutable vcpkg install between incompatible manifests.
 *
 * Shipping builds do not use this path. They configure the exact scene
 * features with the static triplet and BBLITE_MINSIZE.
 */
export function developmentVcpkgFeatures(manifestJson: string): string[] {
    const manifest: unknown = JSON.parse(manifestJson);
    if (
        typeof manifest !== "object" ||
        manifest === null ||
        !("features" in manifest) ||
        typeof manifest.features !== "object" ||
        manifest.features === null ||
        Array.isArray(manifest.features)
    ) {
        throw new Error("native/vcpkg.json must contain a features object.");
    }
    return Object.keys(manifest.features).sort();
}

export function canonicalDevelopmentCompiler(
    value: string,
): "auto" | "msvc" | "clangcl" {
    const canonical = value.toLowerCase().replaceAll("-", "");
    if (
        canonical === "auto" ||
        canonical === "msvc" ||
        canonical === "clangcl"
    ) {
        return canonical;
    }
    throw new Error(
        `--compiler must be auto|msvc|clangcl (got '${value}').`,
    );
}

export function canonicalCompiledBackend(
    value: string,
    command: string,
): "SDL_GPU" | "DAWN" | "BOTH" {
    const canonical = value.toUpperCase().replaceAll("-", "_");
    if (
        canonical === "SDL_GPU" ||
        canonical === "DAWN" ||
        canonical === "BOTH"
    ) {
        return canonical;
    }
    throw new Error(
        `--backend must be sdl_gpu|dawn|both (got '${value}') for ${command}.`,
    );
}
