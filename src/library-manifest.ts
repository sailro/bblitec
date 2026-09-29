// The Babylon Lite C++ library as a generation input.
//
// A scene's tree is specialized to what its program reached. A library has
// no program: its description (`lite/library.json`) lists the features it
// bundles, and this builds the compile result generation writes a tree from,
// through the same writer every scene goes through. The tree has no
// application sources, which is what makes `native/CMakeLists.txt` build it
// as the static library instead of an executable.
//
// What the scene composition would otherwise learn from call sites is
// answered for every client instead:
// - one scene-mesh row stands for every procedural builder, which all share
//   the one stream set `pinnedSceneMeshFeatures` keys a variant on;
// - lights are dynamic, so the light arms are composed for every light kind
//   the features bundle rather than for one scene's list.
// Populations only call sites or assets supply (PBR variants, shadow
// generators, post-process and geometry-output tasks, flow graphs) stay
// empty, so those features compile without anything to draw.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { featureKeyedAdaptations } from "./compiler/adaptations.js";
import type { CompileResult, Feature } from "./compiler/types.js";
import {
    asFeatures,
    featureOrder,
    impliedFeatures,
    projectFeatures,
} from "./compiler/output-projection.js";
import { imageCodecs } from "./image-codec-manifest.js";
import { parseLibraryDescription } from "./library-description.js";
import { findRepositoryRoot } from "./repository-root.js";
import { repositoryRelativePath } from "./upstream-source.js";

/** The compile result for the library description `text`, read from `fileName`. */
export function compileLibrary(text: string, fileName: string): CompileResult {
    const description = parseLibraryDescription(text, fileName);
    // Closed over implications the way the compiler's reach closes them.
    const listed = new Set<Feature>();
    const reach = (feature: Feature): void => {
        if (listed.has(feature)) return;
        listed.add(feature);
        for (const implied of impliedFeatures(feature)) reach(implied);
    };
    for (const feature of asFeatures(description.features)) reach(feature);
    const features = featureOrder.filter((feature) => listed.has(feature));
    for (const codec of description.imageCodecs) {
        if (!imageCodecs.some((known) => known.codec === codec))
            throw new Error(`${fileName}: unknown image codec '${codec}'.`);
    }
    const { runtimeSources, generatedSources, cmake } = projectFeatures(
        features,
        [],
    );
    const source = repositoryRelativePath(
        findRepositoryRoot(dirname(fileURLToPath(import.meta.url))),
        fileName,
    );
    const standardMaterial = listed.has("material:standard");
    return {
        cpp: "",
        cppFiles: new Map(),
        cmake,
        assetPayloads: new Map(),
        manifest: {
            source,
            inputs: [source],
            features,
            featureSites: {},
            runtimeSources,
            generatedSources,
            sourceUnits: [],
            assets: [],
            shaderVariants: [],
            customShaderPrograms: [],
            nodeMaterials: [],
            spriteCustomShaders: [],
            effects: [],
            pureSpriteVertex: false,
            plainSpriteLayer: false,
            plainBillboardSystem: false,
            geometryOutputTasks: [],
            postProcessTasks: [],
            postProcessComposites: [],
            screenSpaceTasks: [],
            adaptations: featureKeyedAdaptations(features),
            scenePbrMaterials: [],
            splatFragments: [],
            standardMaterialPlugins: [],
            standardMaterialPluginInputs: [],
            sceneMaterialCount: standardMaterial ? 1 : 0,
            sceneMeshes: features.some((feature) => feature.startsWith("mesh:"))
                ? [
                      {
                          kind: "procedural",
                          gltfAssetsBefore: 0,
                          standardMaterial: true,
                      },
                  ]
                : [],
            sceneLightKinds: [],
            dynamicSceneLights: true,
            mutableToneMappingEnabled: false,
            shadowGenerators: [],
            shadowReceiverMeshes: [],
            dynamicShadowReceivers: false,
            imageCodecs: description.imageCodecs,
        },
    };
}
