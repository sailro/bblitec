// The scene composition records one compilation accumulates for its
// manifest: reached shader programs, meshes, materials, lights, shadows,
// sprites, effects and frame-graph tasks. Intrinsic lowerers stamp them
// through `LoweringServices.sceneManifest`; the compiler projects them into
// `manifest.json` once the entry walk is complete.
import type ts from "typescript";
import type { CompileAdaptation } from "../fidelity.js";
import type { CompiledMeshWalk } from "../gltf-mesh-walks.js";
import type { MaterialPluginManifest } from "../pinned-material-plugins.js";
import type { CompiledTextData } from "../pinned-text-data.js";
import {
    emissionArray,
    EmissionMap,
    emissionRecord,
    EmissionSet,
    journaled,
    writable,
} from "./emission-transaction.js";
import { nodeParticleManifest } from "./intrinsics/particle.js";
import type { LoweringServices } from "./lowering-services.js";
import { SceneMaterialRecorder } from "./scene-materials.js";
import { shaderThinInstanceLanes } from "./shader-material.js";
import type {
    ClusteredContainerState,
    CompileManifest,
    CompiledComputeProgram,
    CompiledNodeMaterial,
    CompiledNodeParticles,
    CompiledShaderProgram,
    EffectManifest,
    GeometryOutputTaskManifest,
    LightKind,
    PostProcessCompositeManifest,
    PostProcessTaskManifest,
    SceneMeshManifest,
    SceneMeshNamePredicate,
    ScenePbrAnisotropyManifest,
    ScenePbrClearCoatManifest,
    ScenePbrIridescenceManifest,
    ScenePbrLightmapManifest,
    ScenePbrMaterialManifest,
    ScenePbrMetallicReflectanceManifest,
    ScenePbrSheenManifest,
    ScenePbrSubsurfaceManifest,
    ScreenSpaceTaskManifest,
    ShadowCasterMeshManifest,
    ShadowGeneratorManifest,
    SplatFragmentManifest,
    SpriteCustomShaderManifest,
    Value,
} from "./types.js";

interface SceneManifestContext extends Pick<
    LoweringServices,
    | "assets"
    | "engineLifecycle"
    | "fail"
    | "failAtFile"
    | "hasFeature"
    | "hasRegisteredScene"
    | "isInFrameCallback"
    | "isInRuntimeControlFlow"
    | "sourceFile"
> {}

/** The generation-owned construction ordinals a resource checkpoint compares. */
export interface ResourceConstructionState {
    readonly counters: readonly number[];
    readonly lightIdentities: readonly NonNullable<Value["lightIdentity"]>[];
}

/** How many composition records existed when a caller started to watch. */
interface CompositionMark {
    meshes: number;
    materials: number;
    shaders: number;
    nodeMaterials: number;
}

/** The manifest keys the scene composition records own, around the adaptations. */
type SceneManifestRecords = Omit<
    CompileManifest,
    | "assetDecoders"
    | "source"
    | "inputs"
    | "features"
    | "engineMsaaSamples"
    | "featureSites"
    | "runtimeSources"
    | "generatedSources"
    | "sourceUnits"
    | "assets"
>;

export class SceneManifestRecorder {
    public readonly reachedTextData: CompiledTextData[] = emissionArray([]);
    public readonly reachedComputePrograms: CompiledComputeProgram[] =
        emissionArray([]);
    public readonly reachedShaderPrograms: CompiledShaderProgram[] =
        emissionArray([]);
    public readonly reachedNodeMaterials: CompiledNodeMaterial[] =
        emissionArray([]);
    public readonly meshWalks: CompiledMeshWalk[] = emissionArray([]);
    public readonly reachedNodeParticles: CompiledNodeParticles =
        emissionRecord({
            sets: emissionArray([]),
            steps: emissionArray([]),
            billboards: emissionArray([]),
            registrations: emissionArray([]),
            textures: emissionArray([]),
            sprite2d: emissionArray([]),
            buffers: emissionArray([]),
        });
    public readonly geometryOutputTasks: GeometryOutputTaskManifest[] =
        emissionArray([]);
    private readonly copyTasks: string[] = emissionArray([]);
    public readonly postProcessTasks: PostProcessTaskManifest[] = emissionArray(
        [],
    );
    public readonly postProcessComposites: PostProcessCompositeManifest[] =
        emissionArray([]);
    public readonly screenSpaceTasks: ScreenSpaceTaskManifest[] = emissionArray(
        [],
    );
    /** The clustered container this scene added, if it added one. */
    @journaled private accessor clusteredContainer:
        ClusteredContainerState | undefined;
    /** The pinned tone-mapping export the scene selected, if any. */
    @journaled private accessor selectedToneMapping: string | undefined;
    private readonly effects: Readonly<EffectManifest>[] = emissionArray([]);
    private readonly sceneMaterials = new SceneMaterialRecorder();
    private readonly sceneMaterialGltfAssetsBefore: number[] = emissionArray(
        [],
    );
    private readonly sceneMeshes: Readonly<SceneMeshManifest>[] = emissionArray(
        [],
    );
    private readonly shadowGenerators: Array<
        Readonly<
            Omit<ShadowGeneratorManifest, "casters"> & {
                casters: readonly ShadowCasterMeshManifest[];
                lightIdentity?: NonNullable<Value["lightIdentity"]>;
            }
        >
    > = emissionArray([]);
    private readonly shadowReceiverMeshes = new EmissionSet<number>();
    @journaled private accessor dynamicShadowReceivers = false;
    /**
     * `mesh.id`, by the handle spelling the write named, and the meshes each
     * id names.
     *
     * `Mesh.id` is not `SceneNode.name`: the pin declares it separately as
     * the unique id a source file carries, and `src/render/lights-ubo.ts`
     * `affectsMesh` is its only reader. So the string is a join key rather
     * than record state, and the join folds here exactly as the `.babylon`
     * loader folds its own `meshes_by_id` — an id names a LIST,
     * because nothing upstream enforces uniqueness.
     */
    private readonly sceneMeshesById = new EmissionMap<
        string,
        readonly string[]
    >();
    /** The id each mesh handle currently carries, so a rewrite is visible. */
    private readonly sceneMeshIdByHandle = new EmissionMap<string, string>();
    /** Every id an emitted light include set has already resolved against. */
    private readonly resolvedLightMeshIds = new EmissionSet<string>();
    /** The active lights and kinds, kept in one receiver-binding order. */
    private readonly sceneLights: Array<{
        identity: NonNullable<Value["lightIdentity"]>;
        kind: LightKind;
    }> = emissionArray([]);
    /** Scene topology survives value reconstruction through record fields. */
    private readonly sceneTopologyStates = new EmissionMap<
        string,
        NonNullable<Value["sceneTopologyState"]>
    >();
    @journaled private accessor dynamicSceneLights = false;
    @journaled private accessor mutableToneMappingEnabled = false;
    private readonly sceneSpriteCustomShaders: Readonly<SpriteCustomShaderManifest>[] =
        emissionArray([]);
    /**
     * The splat shader plugins one `loadSplat` call passed, in its order.
     * Undefined until a call records one, so an empty list stays
     * distinguishable from no list at all.
     */
    @journaled private accessor sceneSplatFragments:
        SplatFragmentManifest[] | undefined;
    /**
     * Which material each scene-code mesh ended up carrying.
     *
     * A caster's material is a LAZY task input upstream --
     * `setShadowTaskCasterMeshes` stores the mesh list and
     * `getEsmShadowView(mesh.material, ...)` reads the material when the
     * pass builds -- so a scene may name its casters before assigning
     * their materials, and scene 65 does exactly that. Recorded per mesh
     * here and joined to the casters when the manifest is built.
     */
    private readonly sceneMeshMaterials = new EmissionMap<
        number,
        {
            readonly pbrMaterial: number | null;
            readonly nodeMaterial: number | null;
        }
    >();
    /** Every reachable assignment, rather than only the final assignment the
     *  lazy shadow view needs. This closes each PBR material over the meshes
     *  it can actually draw on. */
    private readonly scenePbrMaterialMeshes = new EmissionMap<
        number,
        Set<number>
    >();
    private readonly scenePbrMaterialsWithUnknownMesh =
        new EmissionSet<number>();
    @journaled private accessor unknownSceneMaterialAssignment = false;
    @journaled private accessor standardMaterialUnknownMesh = false;
    private readonly runtimeMaterialProfiles = new EmissionSet<number>();
    @journaled private accessor runtimeMeshProfileCount = 0;
    private readonly runtimeShaderProfiles = new EmissionSet<number>();
    private readonly runtimeNodeProfiles = new EmissionSet<number>();
    @journaled private accessor reachedPlainSpriteLayer = false;
    /** A standalone SpriteRenderer needs the pure-2D vertex permutation. */
    @journaled private accessor reachedPureSpriteVertex = false;
    @journaled private accessor reachedPlainBillboardSystem = false;

    constructor(private readonly context: SceneManifestContext) {}

    /**
     * The manifest's composition records, in manifest key order.
     *
     * `adaptations` is the one row between them the recorder does not own;
     * it is placed where manifest.json has always carried it.
     */
    public manifestRecords(
        adaptations: CompileAdaptation[],
    ): SceneManifestRecords {
        return {
            ...(this.reachedComputePrograms.length
                ? { computePrograms: this.reachedComputePrograms }
                : {}),
            shaderVariants: this.reachedShaderPrograms.map(({ name }) => name),
            customShaderPrograms: this.reachedShaderPrograms,
            nodeMaterials: this.reachedNodeMaterials,
            ...(this.meshWalks.length ? { meshWalks: this.meshWalks } : {}),
            ...(this.reachedTextData.length > 0
                ? { textData: this.reachedTextData }
                : {}),
            ...(this.reachedNodeParticles.sets.length > 0
                ? {
                      nodeParticles: nodeParticleManifest(
                          this.reachedNodeParticles,
                      ),
                  }
                : {}),
            ...(this.selectedToneMapping
                ? { toneMapping: this.selectedToneMapping }
                : {}),
            geometryOutputTasks: this.geometryOutputTasks,
            ...(this.copyTasks.length > 0 ? { copyTasks: this.copyTasks } : {}),
            postProcessTasks: this.postProcessTasks,
            postProcessComposites: this.postProcessComposites,
            screenSpaceTasks: this.screenSpaceTasks,
            adaptations,
            scenePbrMaterials: this.scenePbrMaterials.map(
                (material, index) => ({
                    ...material,
                    sceneMeshIndices: [
                        ...(this.scenePbrMaterialMeshes.get(index) ?? []),
                    ].sort((left, right) => left - right),
                    ...(this.unknownSceneMaterialAssignment ||
                    this.scenePbrMaterialsWithUnknownMesh.has(index)
                        ? { unknownSceneMesh: true as const }
                        : {}),
                }),
            ),
            standardMaterialPlugins:
                this.sceneMaterials.standardMaterialPlugins,
            standardMaterialPluginInputs:
                this.sceneMaterials.standardMaterialPluginInputs,
            ...(this.standardMaterialUnknownMesh ||
            (this.unknownSceneMaterialAssignment &&
                this.context.hasFeature("material:standard"))
                ? { standardMaterialUnknownMesh: true as const }
                : {}),
            sceneMaterialCount: this.sceneMaterials.count,
            sceneMaterialGltfAssetsBefore: this.sceneMaterialGltfAssetsBefore,
            ...(this.runtimeMaterialProfiles.size > 0
                ? {
                      runtimeMaterialProfiles: [
                          ...this.runtimeMaterialProfiles,
                      ],
                  }
                : {}),
            sceneMeshes: this.sceneMeshes,
            sceneLightKinds: this.sceneLights.map(({ kind }) => kind),
            dynamicSceneLights: this.dynamicSceneLights,
            mutableToneMappingEnabled: this.mutableToneMappingEnabled,
            ...(this.clusteredContainer
                ? {
                      clusteredLights: {
                          hasSpots: this.clusteredContainer.hasSpots,
                      },
                  }
                : {}),
            shadowGenerators: this.shadowGenerators.map((generator, index) => {
                const lightIndex =
                    generator.lightIndex >= 0
                        ? generator.lightIndex
                        : this.dynamicShadowLightIndex(index);
                if (lightIndex === undefined) {
                    throw new Error(
                        "A shadow generator's light was never added to the scene.",
                    );
                }
                const { lightIdentity, ...manifest } = generator;
                void lightIdentity;
                return {
                    ...manifest,
                    lightIndex,
                    // The caster's material as the mesh finally carried
                    // it, which is what the pin's lazy view lookup reads.
                    casters: generator.casters.map((caster) => ({
                        meshIndex: caster.meshIndex,
                        pbrMaterial: null,
                        nodeMaterial: null,
                        ...(this.sceneMeshMaterials.get(caster.meshIndex) ??
                            {}),
                    })),
                };
            }),
            shadowReceiverMeshes: [...this.shadowReceiverMeshes].sort(
                (left, right) => left - right,
            ),
            dynamicShadowReceivers: this.dynamicShadowReceivers,
            splatFragments: this.sceneSplatFragments ?? [],
            spriteCustomShaders: this.sceneSpriteCustomShaders,
            effects: this.effects,
            pureSpriteVertex: this.reachedPureSpriteVertex,
            plainSpriteLayer: this.reachedPlainSpriteLayer,
            plainBillboardSystem: this.reachedPlainBillboardSystem,
        };
    }

    /** Settles the records whose final shape depends on the whole entry. */
    public settle(): void {
        if (this.unknownSceneMaterialAssignment) {
            if (this.context.hasFeature("material:standard")) {
                for (const mesh of this.sceneMeshes)
                    writable(mesh).standardMaterial = true;
            }
            // A runtime material choice can make an otherwise-known caster
            // PBR. Its views must use the existing unknown-caster product.
            for (const generator of this.shadowGenerators)
                writable(generator).dynamicCasters = true;
        }
        // After the whole entry, because the mesh a shader material ends up
        // on is what decides its instanced form and either may come first.
        this.settleShaderThinInstances();
    }

    /** Whether generation registered a runtime-profiled scene mesh. */
    public hasRuntimeMeshProfiles(): boolean {
        return this.runtimeMeshProfileCount > 0;
    }

    /**
     * Feature/fact writes such as thin-instance updates are not construction.
     * Only changes to generation-owned ordinals or baked work make a helper's
     * runtime return invalidate the surrounding static iteration count.
     */
    public constructionState(): ResourceConstructionState {
        return {
            counters: [
                this.sceneMeshes.length - this.runtimeMeshProfileCount,
                this.sceneMaterials.count - this.runtimeMaterialProfiles.size,
                this.shadowGenerators.length,
                // Packaged files are deduplicated inputs, not runtime allocation
                // ordinals. Closed-directory discovery can happen inside a loop.
                this.currentGltfAssetCount(),
                this.reachedShaderPrograms.length -
                    this.runtimeShaderProfiles.size,
                this.reachedNodeMaterials.length -
                    this.runtimeNodeProfiles.size,
                this.effects.length,
                this.geometryOutputTasks.length,
                this.postProcessTasks.length,
                this.postProcessComposites.length,
                this.sceneSpriteCustomShaders.length,
                this.reachedNodeParticles.steps.length,
                this.reachedNodeParticles.registrations.length,
                this.reachedNodeParticles.textures.length,
                this.reachedNodeParticles.sprite2d.length,
                // Construction/bake entries are append-only during lowering.
                // Their counts detect changes without rehashing immutable graphs.
                this.reachedNodeParticles.sets.length,
                this.reachedNodeParticles.billboards.length,
            ],
            lightIdentities: this.sceneLights.map(({ identity }) => identity),
        };
    }

    /** The record counts a later `repeatComposition` or profile pass starts from. */
    public compositionMark(): CompositionMark {
        return {
            meshes: this.sceneMeshes.length,
            materials: this.sceneMaterials.count,
            shaders: this.reachedShaderPrograms.length,
            nodeMaterials: this.reachedNodeMaterials.length,
        };
    }

    /**
     * Repeats the meshes and material slots one iteration of a parameterized
     * resource loop recorded after `mark`, for the remaining iterations, in
     * creation order. `checkTotals` sees the final counts first.
     */
    public repeatComposition(
        mark: CompositionMark,
        iterations: number,
        checkTotals: (totalMeshes: number, totalMaterials: number) => void,
    ): void {
        const firstMesh = mark.meshes;
        const firstMaterial = mark.materials;
        const meshes = this.sceneMeshes.slice(firstMesh);
        const materials =
            this.sceneMaterialGltfAssetsBefore.slice(firstMaterial);
        if (meshes.length === 0 && materials.length === 0) return;
        const totalMeshes = firstMesh + meshes.length * iterations;
        const totalMaterials = firstMaterial + materials.length * iterations;
        checkTotals(totalMeshes, totalMaterials);
        for (let iteration = 1; iteration < iterations; ++iteration) {
            for (const [offset, mesh] of meshes.entries()) {
                const source = firstMesh + offset;
                const index = this.sceneMeshes.length;
                this.sceneMeshes.push({ ...mesh });
                const material = this.sceneMeshMaterials.get(source);
                if (material) {
                    this.recordSceneMeshMaterial(index, {
                        ...material,
                        standardMaterial: mesh.standardMaterial === true,
                        standardMaterialPluginIndex:
                            mesh.standardMaterialPluginIndex,
                        sceneShaderVariant: mesh.shaderVariant,
                        sceneShaderVariants: mesh.shaderVariants,
                    });
                }
                if (this.shadowReceiverMeshes.has(source)) {
                    this.shadowReceiverMeshes.add(index);
                }
            }
            for (const loadCount of materials) {
                this.sceneMaterialGltfAssetsBefore.push(loadCount);
                this.sceneMaterials.recordSceneMaterialSlot();
            }
        }
    }

    /** Whether a runtime-profiled construction already took a material row. */
    public hasRuntimeMaterialProfiles(): boolean {
        return this.runtimeMaterialProfiles.size > 0;
    }

    /**
     * Marks every material, shader and node-material record created since
     * `mark` as a native call-site profile rather than a physical creation.
     */
    public recordRuntimeProfiles(mark: CompositionMark): void {
        for (
            let index = mark.materials;
            index < this.sceneMaterials.count;
            ++index
        ) {
            this.runtimeMaterialProfiles.add(index);
        }
        for (
            let index = mark.shaders;
            index < this.reachedShaderPrograms.length;
            ++index
        ) {
            this.runtimeShaderProfiles.add(index);
        }
        for (
            let index = mark.nodeMaterials;
            index < this.reachedNodeMaterials.length;
            ++index
        ) {
            this.runtimeNodeProfiles.add(index);
        }
    }

    public recordRuntimeMeshProfile(index: number): void {
        if (this.sceneMeshes[index]!.runtimeInstances) return;
        writable(this.sceneMeshes[index]!).runtimeInstances = true;
        ++this.runtimeMeshProfileCount;
    }

    public reachedShaderProgram(
        name: string,
        node: ts.Node,
    ): CompiledShaderProgram {
        const program = this.reachedShaderPrograms.find(
            (candidate) => candidate.name === name,
        );
        if (!program) {
            this.context.fail(
                node,
                `Shader variant '${name}' was not created in this scene.`,
            );
        }
        return program;
    }

    /** Records one effect descriptor and returns its index in reach order. */
    public recordEffect(effect: EffectManifest): number {
        return this.effects.push(effect) - 1;
    }

    public selectToneMapping(name: string, node: ts.Node): void {
        if (this.selectedToneMapping && this.selectedToneMapping !== name) {
            this.context.fail(
                node,
                "A scene selects one tone mapping; the composed arms are " +
                    `closed at generation and '${this.selectedToneMapping}' ` +
                    "was already selected.",
            );
        }
        this.selectedToneMapping = name;
    }

    /**
     * The scene-material manifest recorders live in
     * `compiler/scene-materials.ts`; this surface stamps the glTF load count
     * beside each material slot.
     */
    public get scenePbrMaterials(): ScenePbrMaterialManifest[] {
        return this.sceneMaterials.scenePbrMaterials;
    }

    public recordScenePbrNoColorView(sourceIndex: number | undefined): number {
        this.sceneMaterialGltfAssetsBefore.push(this.currentGltfAssetCount());
        return this.sceneMaterials.recordScenePbrNoColorView(sourceIndex);
    }

    public recordSceneMaterialSlot(): number {
        this.sceneMaterialGltfAssetsBefore.push(this.currentGltfAssetCount());
        return this.sceneMaterials.recordSceneMaterialSlot();
    }

    public currentGltfAssetCount(): number {
        return [...this.context.assets.values()]
            .filter((asset) => asset.kind === "gltf")
            .reduce((count, asset) => count + (asset.containerCount ?? 0), 0);
    }

    public recordScenePbrUnlit(index: number | undefined): void {
        this.sceneMaterials.recordScenePbrUnlit(index);
    }

    public recordScenePbrSkybox(index: number | undefined): void {
        this.sceneMaterials.recordScenePbrSkybox(index);
    }

    public recordScenePbrGammaAlbedo(index: number | undefined): void {
        this.sceneMaterials.recordScenePbrGammaAlbedo(index);
    }

    public recordScenePbrShadowOnly(
        index: number | undefined,
        options: NonNullable<ScenePbrMaterialManifest["shadowOnly"]>,
    ): void {
        this.sceneMaterials.recordScenePbrShadowOnly(index, options);
    }

    public recordScenePbrPlugins(
        plugins: readonly MaterialPluginManifest[],
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrPlugins(plugins, index);
    }

    public recordStandardMaterialPlugins(
        plugins: readonly MaterialPluginManifest[],
        material: NonNullable<Value["standardMaterialInput"]>,
    ): number {
        return this.sceneMaterials.recordStandardMaterialPlugins(
            plugins,
            material,
        );
    }

    public recordScenePbrSheen(
        sheen: ScenePbrSheenManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrSheen(sheen, index);
    }

    public recordScenePbrClearCoat(
        clearCoat: ScenePbrClearCoatManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrClearCoat(clearCoat, index);
    }

    public recordScenePbrEmissive(
        color: readonly [number, number, number] | undefined,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrEmissive(color, index);
    }

    public recordScenePbrIridescence(
        iridescence: ScenePbrIridescenceManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrIridescence(iridescence, index);
    }

    public recordScenePbrLightmap(
        lightmap: ScenePbrLightmapManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrLightmap(lightmap, index);
    }

    /**
     * Records the `setPbrLightmap` a scene applied to a loaded container's
     * materials, with the mesh-name filter the walk selected them by.
     *
     * `sceneUnlit` beside this is container-wide; a lightmap is not. PBR
     * composition is settled per material at generation, and the reached
     * walk stamps only the meshes whose name passes its own filter — so
     * what is kept is that filter, for the DOCUMENT to evaluate against
     * its own renderables. Nothing here reads a name.
     */
    public recordAssetSceneLightmap(
        meshNamePredicate: SceneMeshNamePredicate,
        lightmap: ScenePbrLightmapManifest,
        node: ts.Node,
    ): void {
        // `scene.meshes` is walked live, so what generation folds is the
        // scene's mesh membership at this point in the program. A
        // scene-code mesh already created could be in that list under a
        // name generation does not carry, and a second container could be
        // in or out of it depending on where its `addToScene` sits —
        // neither is represented, so both refuse rather than stamping a
        // set the run-time loop will not reproduce.
        const containers = [...this.context.assets.values()].filter(
            (candidate) => candidate.kind === "gltf",
        );
        if (
            containers.length !== 1 ||
            (containers[0]!.containerCount ?? 0) > 1
        ) {
            this.context.fail(
                node,
                "A lightmap walk over `scene.meshes` folds against exactly " +
                    "one loaded glTF container: with several, which of them " +
                    "the walk has reached depends on where each " +
                    "`addToScene` sits, which generation does not model.",
            );
        }
        if (this.sceneMeshes.length > 0) {
            this.context.fail(
                node,
                "A lightmap walk over `scene.meshes` runs before the scene " +
                    "creates any mesh of its own: generation carries no name " +
                    "for a scene-code mesh, so it could not tell whether the " +
                    "filter selects one.",
            );
        }
        const asset = containers[0]!;
        const existing = asset.sceneLightmap;
        if (
            existing &&
            JSON.stringify(existing) !==
                JSON.stringify({ meshNamePredicate, options: lightmap })
        ) {
            this.context.fail(
                node,
                "setPbrLightmap already stamped this container's materials " +
                    "differently; each material composes one lightmap arm, " +
                    "so a second selection would need the blend and the UV " +
                    "set to be per-material record reads.",
            );
        }
        writable(asset).sceneLightmap = {
            meshNamePredicate,
            options: lightmap,
        };
    }

    public recordScenePbrSubsurface(
        subsurface: ScenePbrSubsurfaceManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrSubsurface(subsurface, index);
    }

    public recordScenePbrAnisotropy(
        anisotropy: ScenePbrAnisotropyManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrAnisotropy(anisotropy, index);
    }

    public recordScenePbrMetallicReflectance(
        reflectance: ScenePbrMetallicReflectanceManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrMetallicReflectance(
            reflectance,
            index,
        );
    }

    /** One layer or system built without a custom shader, so with the stock program. */
    public recordPlainSpriteProgram(family: "sprite" | "billboard"): void {
        if (family === "sprite") this.reachedPlainSpriteLayer = true;
        else this.reachedPlainBillboardSystem = true;
    }

    public recordPureSpriteVertex(): void {
        this.reachedPureSpriteVertex = true;
    }

    public spriteCustomShaders(): readonly SpriteCustomShaderManifest[] {
        return this.sceneSpriteCustomShaders;
    }

    /** One custom-shader descriptor, in the pin's own `_key` order. */
    public recordSpriteCustomShader(shader: SpriteCustomShaderManifest): void {
        this.sceneSpriteCustomShaders.push(shader);
    }

    /**
     * The shader plugins one `loadSplat` call passed.
     *
     * Upstream keys its module cache by the plugin ids, so two clouds
     * loaded with different lists compile different modules; this port
     * deploys one splat stage pair, so a second differing list refuses
     * rather than drawing both clouds through the first one's.
     */
    public recordSplatFragments(
        fragments: readonly SplatFragmentManifest[],
        node: ts.Node,
    ): void {
        if (!this.sceneSplatFragments) {
            this.sceneSplatFragments = [...fragments];
            return;
        }
        if (
            JSON.stringify(this.sceneSplatFragments) !==
            JSON.stringify(fragments)
        ) {
            this.context.fail(
                node,
                "A second loadSplat with a different shader-fragment list " +
                    "is not lowered: the generated splat stages are one " +
                    "composed module per scene.",
            );
        }
    }

    /**
     * Records one shadow generator, returning its reach index.
     *
     * Its casters arrive separately, through `recordShadowCasters`:
     * the pin keeps them as a lazy task input rather than on the generator,
     * and `setShadowTaskCasterMeshes` is the call that names them.
     */
    public recordShadowGenerator(
        entry: Omit<ShadowGeneratorManifest, "casters"> & {
            lightIdentity?: NonNullable<Value["lightIdentity"]>;
        },
    ): number {
        this.shadowGenerators.push({ ...entry, casters: [] });
        return this.shadowGenerators.length - 1;
    }

    private dynamicShadowLightIndex(index: number): number | undefined {
        const candidates =
            this.shadowGenerators[index]?.lightIdentity?.dataCollectionIndices;
        return candidates?.size === 1 ? [...candidates][0] : undefined;
    }

    /** Preserve a light's position when a compile-time tuple becomes data. */
    public recordDataLightSlot(value: Value, index: number): void {
        if (!value.lightIdentity) return;
        const slots =
            value.lightIdentity.dataCollectionIndices ??
            new EmissionSet<number>();
        slots.add(index);
        writable(value.lightIdentity).dataCollectionIndices = slots;
    }

    /**
     * The filter and light slot one recorded generator was built with.
     *
     * A node material names its generators rather than its lights, and the
     * pin reads only `_shadowType` off each one -- so this is the pair the
     * composition needs, resolved through the record the factory made.
     */
    public shadowGeneratorLight(
        index: number,
        node: ts.Node,
    ): { lightIndex: number } {
        const generator = this.shadowGenerators[index];
        if (!generator) {
            this.context.fail(
                node,
                `Shadow generator ${index} was never recorded.`,
            );
        }
        if (generator.lightIndex < 0) {
            this.context.fail(
                node,
                "A node material's shadow generator light must be added to the scene before the material is parsed.",
            );
        }
        return { lightIndex: generator.lightIndex };
    }

    /** Records that a mesh carries the per-instance RGBA stream. */
    public recordThinInstanceColorMesh(
        sceneMeshIndex: number | undefined,
    ): void {
        if (sceneMeshIndex === undefined) {
            // A handle selected from a runtime pool has lost its one static
            // scene index, but it can only name a mesh that already owns a
            // thin-instance pool. Keep every such row's coloured arm; the
            // runtime key still selects it only after colors are attached.
            for (const mesh of this.sceneMeshes) {
                if (mesh.thinInstances) {
                    writable(mesh).thinInstanceColors = true;
                }
            }
            return;
        }
        const mesh = this.sceneMeshes[sceneMeshIndex];
        if (mesh) writable(mesh).thinInstanceColors = true;
    }

    /**
     * Settles each scene-local shader program's instanced form.
     *
     * The pin builds the instanced pipeline from the MESH -- `hasColor` is
     * `!!ti.colors && material._tic != 0`, and this port refuses the `_tic`
     * key, so the mesh decides outright -- and it builds one pipeline per
     * renderable, keyed `"" + +hasColor`. This port bakes one variant into
     * the material record instead, so the lanes are settled once, after the
     * entry, from the pairs recorded on the way through.
     */
    private settleShaderThinInstances(): void {
        for (const [variant, colors] of shaderThinInstanceLanes(
            this.sceneMeshes,
            (message) => this.context.failAtFile(message),
        )) {
            const program = this.reachedShaderProgram(
                variant,
                this.context.sourceFile,
            );
            writable(program).useThinInstances = true;
            if (colors) writable(program).useThinInstanceColors = true;
        }
    }

    /** Which material a scene-code mesh was assigned, by its mesh index. */
    public recordSceneMeshMaterial(
        meshIndex: number,
        material: {
            pbrMaterial: number | null;
            nodeMaterial: number | null;
            standardMaterial: boolean;
            standardMaterialPluginIndex?: number | undefined;
            sceneShaderVariant?: string | undefined;
            sceneShaderVariants?: readonly string[] | undefined;
        },
    ): void {
        this.sceneMeshMaterials.set(meshIndex, {
            pbrMaterial: material.pbrMaterial,
            nodeMaterial: material.nodeMaterial,
        });
        if (material.standardMaterial) {
            const mesh = this.sceneMeshes[meshIndex];
            if (mesh) {
                writable(mesh).standardMaterial = true;
                if (material.standardMaterialPluginIndex !== undefined) {
                    writable(mesh).standardMaterialPluginIndex =
                        material.standardMaterialPluginIndex;
                }
            }
        }
        const shaderMesh = this.sceneMeshes[meshIndex];
        if (shaderMesh) {
            if (this.context.isInRuntimeControlFlow()) {
                const variants = new EmissionSet([
                    ...(shaderMesh.shaderVariant === undefined
                        ? []
                        : [shaderMesh.shaderVariant]),
                    ...(shaderMesh.shaderVariants ?? []),
                    ...(material.sceneShaderVariant === undefined
                        ? []
                        : [material.sceneShaderVariant]),
                    ...(material.sceneShaderVariants ?? []),
                ]);
                delete writable(shaderMesh).shaderVariant;
                if (variants.size > 0)
                    writable(shaderMesh).shaderVariants = [...variants].sort();
            } else {
                if (material.sceneShaderVariant === undefined)
                    delete writable(shaderMesh).shaderVariant;
                else
                    writable(shaderMesh).shaderVariant =
                        material.sceneShaderVariant;
                if (material.sceneShaderVariants === undefined)
                    delete writable(shaderMesh).shaderVariants;
                else
                    writable(shaderMesh).shaderVariants =
                        material.sceneShaderVariants;
            }
        }
        if (material.pbrMaterial !== null) {
            const meshes =
                this.scenePbrMaterialMeshes.get(material.pbrMaterial) ??
                new EmissionSet<number>();
            meshes.add(meshIndex);
            this.scenePbrMaterialMeshes.set(material.pbrMaterial, meshes);
        }
    }

    /** A material assignment reached a mesh handle not tied to one static
     *  scene-mesh row (for example an imported collection element). */
    public recordUnknownSceneMeshMaterial(materialIndex: number): void {
        this.scenePbrMaterialsWithUnknownMesh.add(materialIndex);
    }

    public recordUnknownSceneMaterialAssignment(): void {
        this.unknownSceneMaterialAssignment = true;
    }

    public recordUnknownStandardMeshMaterial(): void {
        this.standardMaterialUnknownMesh = true;
    }

    public recordSceneMeshAssetPbrMaterial(meshIndex: number): void {
        const mesh = this.sceneMeshes[meshIndex];
        if (!mesh) {
            throw new Error(
                `Scene mesh ${meshIndex} was not recorded before its asset material assignment.`,
            );
        }
        writable(mesh).assetPbrMaterial = true;
    }

    /**
     * A definite skeleton or morph attachment on a scene-code mesh.
     *
     * The pin's `_computeMeshFeatures` reads these mesh properties for
     * the material variant key. Record them beside the scene-created
     * mesh's streams so composition executes that same predicate.
     */
    public recordSceneMeshDeformation(
        meshIndex: number,
        property: "skinned" | "morphTargets",
        site: ts.Node,
    ): void {
        const mesh = this.sceneMeshes[meshIndex];
        if (!mesh) {
            throw new Error(
                `Scene mesh ${meshIndex} was not recorded before its ${property} assignment.`,
            );
        }
        if (property === "morphTargets" && mesh.morphTargets) {
            this.context.fail(
                site,
                "Replacing a direct morph target attachment is not supported; " +
                    "updates to detached morph resources require independent storage.",
            );
        }
        writable(mesh)[property] = true;
    }

    public recordShadowCasters(
        generatorIndex: number,
        casters: readonly ShadowCasterMeshManifest[],
    ): void {
        const generator = this.shadowGenerators[generatorIndex];
        if (!generator) {
            throw new Error(
                `Shadow generator ${generatorIndex} was never recorded.`,
            );
        }
        writable(generator).casters = [...casters];
    }

    public recordDynamicShadowCasters(generatorIndex: number): void {
        const generator = this.shadowGenerators[generatorIndex];
        if (!generator) {
            throw new Error(
                `Shadow generator ${generatorIndex} was never recorded.`,
            );
        }
        writable(generator).dynamicCasters = true;
    }

    /** A runtime-selected generator may denote any reached generator. */
    public recordDynamicShadowCastersForUnknownGenerator(): void {
        for (const generator of this.shadowGenerators) {
            writable(generator).dynamicCasters = true;
        }
    }

    /**
     * Which resource row the NEXT ESM generator takes.
     *
     * Generation composes one row per ESM factory call, in reach order, so
     * the ordinal is settled here rather than counted again at run time.
     */
    public esmGeneratorOrdinal(): number {
        return this.shadowGenerators.filter(
            (generator) => generator.kind === "esm-directional",
        ).length;
    }

    /** `mesh.receiveShadows = true`, by scene-mesh index. */
    public recordShadowReceiver(sceneMeshIndex: number): void {
        this.shadowReceiverMeshes.add(sceneMeshIndex);
    }

    public recordDynamicShadowReceivers(): void {
        this.dynamicShadowReceivers = true;
    }

    /**
     * `mesh.id = "..."`, by the handle spelling the write named.
     *
     * Nothing is emitted: the pin's only reader of `Mesh.id` is
     * `affectsMesh`, whose join `resolveSceneMeshIds` folds, so the string
     * has no run-time reader to store it for. A write that would make an
     * ALREADY-emitted include set stale refuses instead, because the fold
     * cannot revisit a statement it has written.
     */
    public recordSceneMeshId(meshCpp: string, id: string, node: ts.Node): void {
        const previous = this.sceneMeshIdByHandle.get(meshCpp);
        if (previous === id) return;
        const stale = this.resolvedLightMeshIds.has(id)
            ? id
            : previous !== undefined && this.resolvedLightMeshIds.has(previous)
              ? previous
              : undefined;
        if (stale !== undefined) {
            this.context.fail(
                node,
                `Mesh id "${stale}" already resolved a light's ` +
                    "includedOnlyMeshIds, so this write would change a " +
                    "selection generation has emitted. Assign every " +
                    "mesh id before restricting a light by it.",
            );
        }
        if (previous !== undefined) {
            const bound = this.sceneMeshesById.get(previous);
            const at = bound?.indexOf(meshCpp) ?? -1;
            if (bound && at >= 0) writable(bound).splice(at, 1);
        }
        this.sceneMeshIdByHandle.set(meshCpp, id);
        const meshes = this.sceneMeshesById.get(id);
        if (meshes) {
            if (!meshes.includes(meshCpp)) writable(meshes).push(meshCpp);
        } else {
            this.sceneMeshesById.set(id, [meshCpp]);
        }
    }

    /**
     * The meshes a light's `includedOnlyMeshIds` set names, as handle
     * spellings, in the Set's own insertion order.
     *
     * The pin gates on the SET being non-empty (`included?.size`), not on
     * what it resolves to, so an id no mesh carries would light nothing at
     * all — a state an index vector cannot express, since an empty one is
     * how the record says "every mesh". That id refuses here rather than
     * silently taking the other arm.
     */
    public resolveSceneMeshIds(
        ids: readonly string[],
        node: ts.Node,
    ): string[] {
        const meshes: string[] = [];
        for (const id of new EmissionSet(ids)) {
            const bound = this.sceneMeshesById.get(id);
            if (!bound || bound.length === 0) {
                this.context.fail(
                    node,
                    `No mesh carries the id "${id}". A light include ` +
                        "set naming an id no mesh has lights nothing " +
                        "upstream, which the folded per-mesh index list " +
                        "cannot express.",
                );
            }
            this.resolvedLightMeshIds.add(id);
            for (const mesh of bound) {
                if (!meshes.includes(mesh)) meshes.push(mesh);
            }
        }
        return meshes;
    }

    /** Place a light in the current scene topology and bind its generators. */
    public addSceneLight(scene: Value, light: Value, kind: LightKind): void {
        const identity = light.lightIdentity;
        if (!identity) {
            throw new Error("A scene light is missing its compiler identity.");
        }
        const topology = scene.sceneTopologyState ??
            this.sceneTopologyStates.get(scene.cpp) ?? { lights: [] };
        writable(scene).sceneTopologyState = topology;
        this.sceneTopologyStates.set(scene.cpp, topology);
        const index = topology.lights.length;
        writable(topology.lights).push({ identity, kind });
        this.sceneLights.push({ identity, kind });
        if (
            identity.sceneLightIndex !== undefined &&
            identity.sceneLightIndex !== index
        ) {
            throw new Error(
                "A shadow-casting light occupies different light slots across scenes; " +
                    "scene-specific receiver variants are not lowered.",
            );
        }
        writable(identity).sceneLightIndex = index;
        if (identity.shadowGeneratorIndex !== undefined) {
            const generator =
                this.shadowGenerators[identity.shadowGeneratorIndex];
            if (generator) writable(generator).lightIndex = index;
        }
        if (
            this.context.isInFrameCallback() ||
            this.context.engineLifecycle.engineHasStarted()
        ) {
            this.dynamicSceneLights = true;
        }
    }

    /** A light recovered from native data has no single AOT kind/identity. */
    public addDynamicSceneLight(): void {
        this.dynamicSceneLights = true;
    }

    /** Remove a light and compact the slots exactly as Array.splice does. */
    public removeSceneLight(scene: Value, light: Value): void {
        const identity = light.lightIdentity;
        if (!identity) return;
        const topology = scene.sceneTopologyState ??
            this.sceneTopologyStates.get(scene.cpp) ?? { lights: [] };
        writable(scene).sceneTopologyState = topology;
        this.sceneTopologyStates.set(scene.cpp, topology);
        const index = topology.lights.findIndex(
            (entry) => entry.identity === identity,
        );
        if (index < 0) return;
        writable(topology.lights).splice(index, 1);
        const globalIndex = this.sceneLights.findIndex(
            (entry) => entry.identity === identity,
        );
        if (globalIndex >= 0) this.sceneLights.splice(globalIndex, 1);
        delete writable(identity).sceneLightIndex;
        for (let slot = index; slot < topology.lights.length; slot++) {
            const moved = topology.lights[slot]!.identity;
            writable(moved).sceneLightIndex = slot;
            if (moved.shadowGeneratorIndex !== undefined) {
                const generator =
                    this.shadowGenerators[moved.shadowGeneratorIndex];
                if (generator) writable(generator).lightIndex = slot;
            }
        }
        if (
            this.context.isInFrameCallback() ||
            this.context.engineLifecycle.engineHasStarted()
        ) {
            this.dynamicSceneLights = true;
        }
    }

    /** A tone-mapping enable write can occur after environment loading, and
     *  callback writes can alternate it at run time. */
    public recordToneMappingEnabledMutation(): void {
        this.mutableToneMappingEnabled = true;
    }

    /** Records the exact mesh on which a thin-instance pool exists. */
    public recordThinInstanceMesh(sceneMeshIndex: number | undefined): void {
        if (sceneMeshIndex === undefined) return;
        const mesh = this.sceneMeshes[sceneMeshIndex];
        if (!mesh) return;
        if (
            this.context.isInFrameCallback() &&
            mesh.thinInstances !== "always"
        ) {
            writable(mesh).thinInstances = "possible";
        } else {
            writable(mesh).thinInstances = "always";
        }
    }

    /**
     * Whether a `mesh.thinInstances` read on this value can stand.
     *
     * A mesh whose scene identity generation resolved is answered from what
     * it recorded, so a source reading the pool of a mesh that never binds
     * one is refused at its own line. A mesh that arrives as a runtime
     * handle -- read out of plain data, indexed out of a collection -- has
     * no compile-time identity to ask about, so the question is the
     * runtime's: the emitted read raises the pin's own non-null failure.
     */
    public meshHasThinInstancePool(owner: Value): boolean {
        return (
            owner.sceneMeshIndex === undefined ||
            this.sceneMeshes[owner.sceneMeshIndex]?.thinInstances !== undefined
        );
    }

    /**
     * Records that this mesh reached an `enableThinInstanceGpuCulling` that
     * can leave the pin's `_gpuCullingEnabled` set.
     */
    public recordThinInstanceGpuCulling(
        sceneMeshIndex: number | undefined,
    ): void {
        if (sceneMeshIndex === undefined) return;
        const mesh = this.sceneMeshes[sceneMeshIndex];
        if (!mesh) return;
        writable(mesh).thinInstanceGpuCulling = true;
    }

    /**
     * Whether a statically-`false` culling opt-in on this value still has
     * something to say.
     *
     * `_gpuCullingEnabled` starts false, so a `false` call is the pin's own
     * idempotent early return unless an enabling call already ran on the
     * same mesh — which is a question about this mesh's own state, answered
     * from what it recorded during the same single deterministic walk that
     * records its pool. A mesh with no compile-time identity has no such
     * state to read, so the call stands and the runtime decides.
     */
    public meshMayHaveThinInstanceGpuCulling(owner: Value): boolean {
        return (
            owner.sceneMeshIndex === undefined ||
            this.sceneMeshes[owner.sceneMeshIndex]?.thinInstanceGpuCulling ===
                true
        );
    }

    /** Records a scene-code mesh creation for the per-renderable variant key. */
    public recordSceneMesh(
        kind: string,
        streams?: {
            hasUv2: boolean;
            hasTangents: boolean;
            hasColors: boolean;
            runtimeStreams?: true;
        },
    ): number {
        this.sceneMeshes.push({
            kind,
            gltfAssetsBefore: this.currentGltfAssetCount(),
            ...(streams ?? {}),
        });
        return this.sceneMeshes.length - 1;
    }

    /**
     * Records that this scene composes the clustered light fragment.
     *
     * Only `hasSpots` reaches composition -- it decides which of the pin's
     * two extensions detects a material, and with it the data layout the
     * fragment reads -- so that is what travels to the compose pipeline.
     */
    public reachClusteredContainer(
        state: ClusteredContainerState,
        node: ts.Node,
    ): void {
        if (
            this.clusteredContainer &&
            this.clusteredContainer.hasSpots !== state.hasSpots
        ) {
            this.context.fail(
                node,
                "Two clustered light containers disagree about spot " +
                    "lights: the composed fragment carries one data layout.",
            );
        }
        this.clusteredContainer = state;
    }

    public recordGeometryOutputTask(
        manifest: GeometryOutputTaskManifest,
    ): void {
        this.geometryOutputTasks.push(manifest);
    }

    public recordCopyTask(name: string): void {
        this.copyTasks.push(name);
    }

    public recordPostProcessTask(manifest: PostProcessTaskManifest): void {
        this.postProcessTasks.push(manifest);
    }

    public recordPostProcessComposite(
        manifest: PostProcessCompositeManifest,
        site: ts.Node,
    ): void {
        if (
            manifest.intrinsic === "createTaaPostProcessTask" &&
            (this.context.isInFrameCallback() ||
                this.context.engineLifecycle.engineHasStarted())
        ) {
            this.context.fail(
                site,
                "TAA task creation after frame execution is not lowered; its source must retain scene UBO history from its first frame.",
            );
        }
        if (
            manifest.intrinsic === "createTaaPostProcessTask" &&
            this.context.hasRegisteredScene()
        ) {
            this.context.fail(
                site,
                "TAA tasks must be constructed and attached before initial scene registration; later task record epochs are not lowered.",
            );
        }
        this.postProcessComposites.push(manifest);
    }

    public recordScreenSpaceTask(manifest: ScreenSpaceTaskManifest): void {
        this.screenSpaceTasks.push(manifest);
    }
}
