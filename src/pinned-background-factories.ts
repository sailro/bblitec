/**
 * Per factory module: the factory, the builder its geometry comes from and
 * the writer of its mesh block, as the factory calls them. Generation runs
 * the factories and the builders; the lowerer lowers the builders and the
 * writers.
 */
export interface PinnedBackgroundFactory {
    modulePath: string;
    factory: string;
    builder: string;
    writer: string;
}

export const backgroundFactories = {
    ground: {
        modulePath: "src/material/pbr/background-ground.ts",
        factory: "buildGroundRenderable",
        builder: "createGroundBuffers",
        writer: "createBgMeshUBO",
    },
    ddsSkybox: {
        modulePath: "src/material/pbr/background-dds-skybox.ts",
        factory: "buildDdsSkyboxRenderable",
        builder: "createSkyboxBuffers",
        writer: "createDdsMeshUBO",
    },
    hdrSkybox: {
        modulePath: "src/material/pbr/background-hdr-skybox.ts",
        factory: "buildHdrSkyboxRenderable",
        builder: "createSkyboxBuffers",
        writer: "createSkyHdrMeshUBO",
    },
    solidSkybox: {
        modulePath: "src/material/pbr/background-solid-skybox.ts",
        factory: "buildSolidSkyboxRenderable",
        builder: "createSkyboxBuffers",
        writer: "createSkyMeshUBO",
    },
} as const satisfies Record<string, PinnedBackgroundFactory>;

/** The image skybox: its loader builds the renderable, and its box through `createBoxData`. */
export const imageSkyboxLoader = {
    modulePath: "src/loader-skybox/load-skybox.ts",
    factory: "loadSkybox",
    builder: "createBoxData",
} as const;
