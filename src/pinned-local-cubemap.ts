// Execute the pin's local-cubemap validation, packing, setters and UBO writer.
// The recording device retains descriptors and copy commands; it implements no shading.
import {importPinnedModule, pinnedLibraryRoot} from "./pinned-shader-composer.js";
import {cachedBakeSync, moduleClosureBytes, moduleIdentity} from "./bake-cache.js";
import {LoweringContext} from "./lowering/context.js";
import {readAssetBytesSync} from "./compiler/asset-bytes-sync.js";
import {runGenerationChild} from "./compiler/generation-child.js";
import {createRecordingDevice, RecordedBuffer, RecordedTexture, type RecordedTextureView} from "./recording-device.js";

export type LocalCubemapJson = number | string | boolean | null | LocalCubemapJson[] | {[key: string]: LocalCubemapJson};
export interface LocalCubemapPlan {
    kind: "environment" | "single" | "probes";
    maxCandidates: number;
    entryFileName: string;
    environments: string[];
    options: {[key: string]: LocalCubemapJson};
    debug?: boolean;
}
export interface LocalCubemapPacket {
    overridesEnvironment: boolean;
    uniform: number[];
    grid: number[];
    width: number;
    mipCount: number;
    layers: number;
    copies: {source: number; sourceMip: number; sourceLayer: number; mip: number; layer: number; size: number}[];
    fields: Record<string, number[]>;
}
interface RecordedEnvironment {
    specularCube: RecordedTexture;
    specularCubeView: RecordedTextureView;
    cubeSampler: object;
    sphericalHarmonics: Float32Array;
    lodGenerationScale: number;
}
interface RecordedProbeSet {
    _texture: RecordedTexture;
}
interface LocalCubemapModule {
    enablePbrLocalCubemap(options: {maxCandidates: number}): Promise<void>;
    setPbrEnvironment(material: object, environment: RecordedEnvironment): void;
    setPbrLocalEnvironment(material: object, environment: RecordedEnvironment, options: LocalCubemapPlan["options"]): void;
    createPbrLocalEnvironmentProbeSet(scene: object, options: object): RecordedProbeSet;
    setPbrLocalEnvironmentProbeSet(material: object, set: RecordedProbeSet): void;
    setPbrLocalEnvironmentProbeDebug(set: RecordedProbeSet, enabled: boolean): void;
}
interface LocalFragmentModule {
    pbrExt: {
        detect(material: object): {f: number; f2: number};
        frag(context: object): {_uboFields: {_name: string; _type: string}[]};
        writeUbo(data: Float32Array, material: object, offsets: Map<string, number>): void;
        bind(context: object, entries: {binding: number; resource: unknown}[], binding: number): number;
    };
}

export function pinnedLocalCubemapLimits(): {defaultCandidates: number; candidateCapacity: number} {
    const context = new LoweringContext();
    const file = context.sourceFile("src/material/pbr/pbr-local-cubemap-limits.ts");
    return {
        defaultCandidates: context.numericValue(context.variableInitializer(file, "MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES"), file),
        candidateCapacity: context.numericValue(context.variableInitializer(file, "_PBR_LOCAL_ENVIRONMENT_CANDIDATE_CAPACITY"), file),
    };
}

/** Composition needs the actual WeakMap-backed setter, even when only presence matters. */
export async function applyPinnedLocalCubemap(material: object, maxCandidates: number): Promise<void> {
    const pin = await importPinnedModule<LocalCubemapModule>("material/pbr/enable-pbr-local-cubemap.js");
    await pin.enablePbrLocalCubemap({maxCandidates});
    // Only the state tag is inspected during feature derivation and composition.
    const state = await importPinnedModule<{
        _setPbrLocalEnvironment(material: object, state: {kind: "environment"; environment: object}): void;
    }>("material/pbr/pbr-local-cubemap-state.js");
    state._setPbrLocalEnvironment(material, {kind: "environment", environment: {}});
}

export async function packLocalCubemap(plan: LocalCubemapPlan): Promise<LocalCubemapPacket> {
    const {device, recorder} = createRecordingDevice({
        producer: "local-cubemap",
        device: ["createBuffer", "createSampler", "createTexture", "createCommandEncoder"],
        queue: ["submit", "writeBuffer"],
        encoder: ["copyTextureToTexture", "finish"],
        deviceFields: {limits: {maxTextureArrayLayers: 2048, maxUniformBufferBindingSize: 65536,
            maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 256 * 1024 * 1024}},
    });
    const engine = {_device: device};
    const pin = await importPinnedModule<LocalCubemapModule>("material/pbr/enable-pbr-local-cubemap.js");
    await pin.enablePbrLocalCubemap({maxCandidates: plan.maxCandidates});
    const parser = await importPinnedModule<{
        parseEnvFile(buffer: ArrayBuffer): {width: number; mipCount: number; irradianceSH: Float32Array};
    }>("loader-env/env-parse.js");
    const assembler = await importPinnedModule<{
        assembleEnvironmentTextures(cube: RecordedTexture, brdf: RecordedTexture, sh: Float32Array, lod: number, engine: object): RecordedEnvironment;
    }>("loader-env/env-helpers.js");
    const flags = await importPinnedModule<{TU: {TEXTURE_BINDING: number; COPY_SRC: number}}>("engine/gpu-flags.js");
    const context = new LoweringContext();
    const loader = context.functionDeclaration("src/loader-env/load-env.ts", "loadEnvironment");
    const lod = context.callExpression(loader.declaration, "assembleEnvironmentTextures").arguments[3];
    if (!lod) throw new Error("Pinned .env loader has no LOD-generation scale.");
    const lodGenerationScale = context.numericValue(lod, loader.file);
    // Each environment's cube is a texture of this port's making, keyed to the
    // plan index a copy out of it names; a copy out of any other texture
    // names no environment.
    const environmentIndices = new Map<RecordedTexture, number>();
    const environments = plan.environments.map((source, index) => {
        const bytes = readAssetBytesSync(source, plan.entryFileName);
        const parsed = parser.parseEnvFile(Uint8Array.from(bytes).buffer);
        const texture = new RecordedTexture({size: [parsed.width, parsed.width, 6], mipLevelCount: parsed.mipCount,
            format: "rgba16float", usage: flags.TU.TEXTURE_BINDING | flags.TU.COPY_SRC});
        environmentIndices.set(texture, index);
        return assembler.assembleEnvironmentTextures(texture, texture, parsed.irradianceSH, lodGenerationScale, engine);
    });
    if (environments.length === 0) throw new Error("Local cubemap has no environment.");
    const material = {};
    let set: RecordedProbeSet | undefined;
    if (plan.kind === "probes") {
        const authored = plan.options["probes"];
        if (!Array.isArray(authored)) throw new Error("Local probe options require a probe array.");
        const probes = authored.map(probe => {
            if (!probe || typeof probe !== "object" || Array.isArray(probe)) throw new Error("Local probe is not an object.");
            const index = probe["environment"];
            if (typeof index !== "number" || !environments[index]) throw new Error("Local probe environment identity is missing.");
            return {...probe, environment: environments[index]};
        });
        set = pin.createPbrLocalEnvironmentProbeSet({surface: {engine}, _disposables: []}, {...plan.options, probes});
        if (plan.debug !== undefined) pin.setPbrLocalEnvironmentProbeDebug(set, plan.debug);
        pin.setPbrLocalEnvironmentProbeSet(material, set);
    } else if (plan.kind === "single") pin.setPbrLocalEnvironment(material, environments[0]!, plan.options);
    else pin.setPbrEnvironment(material, environments[0]!);
    const fragment = (await importPinnedModule<LocalFragmentModule>("material/pbr/fragments/local-cubemap-fragment.js")).pbrExt;
    const features = fragment.detect(material);
    const fields = fragment.frag({_features: features.f, _features2: features.f2, _hasSceneIbl: true})._uboFields;
    // Independent padded slots let the pinned writer name every field without depending on any composed layout.
    const offsets = new Map(fields.map((field, index) => [field._name, index * 16]));
    const data = new Float32Array(fields.length * 4);
    fragment.writeUbo(data, material, offsets);
    const entries: {binding: number; resource: unknown}[] = [];
    fragment.bind({_engine: engine, _material: material, _env: environments[0]}, entries, 0);
    const buffer = (index: number) => {
        const resource = entries[index]?.resource;
        if (!resource || typeof resource !== "object" || !("buffer" in resource) || !(resource.buffer instanceof RecordedBuffer))
            throw new Error("Pinned local cubemap binding is not the recorded buffer.");
        return Array.from(new Uint32Array(resource.buffer.bytes));
    };
    const texture = set?._texture ?? environments[0]!.specularCube;
    const copies: LocalCubemapPacket["copies"] = recorder.textureCopies.map(copy => ({
        source: environmentIndices.get(copy.source.texture) ?? -1, sourceMip: copy.source.mipLevel,
        sourceLayer: copy.source.origin.z, mip: copy.destination.mipLevel, layer: copy.destination.origin.z, size: copy.size.width}));
    if (!set) for (let mip = 0; mip < texture.mipLevelCount; mip++) for (let layer = 0; layer < 6; layer++)
        copies.push({source: 0, sourceMip: mip, sourceLayer: layer, mip, layer, size: Math.max(1, texture.width >> mip)});
    return {overridesEnvironment: plan.kind !== "probes", uniform: buffer(0), grid: buffer(1), width: texture.width, mipCount: texture.mipLevelCount,
        layers: texture.depthOrArrayLayers, copies,
        fields: Object.fromEntries(fields.map((field, index) => [field._name,
            Array.from(data.subarray(index * 4, index * 4 + (field._type === "f32" ? 1 : field._type === "vec3<f32>" ? 3 : 4)))]))};
}

/** The synchronous compiler shares the same evaluator used by semantic tests. */
export function packLocalCubemapSync(plan: LocalCubemapPlan): string {
    const execute = () => Buffer.from(runGenerationChild({label: "Packing pinned local cubemap resources", maxBuffer: 8 * 1024 * 1024,
        script: `import {readFileSync} from 'node:fs';
const {packLocalCubemap} = await import(process.env.BBLITE_LOCAL_CUBEMAP_MODULE);
process.stdout.write(JSON.stringify(await packLocalCubemap(JSON.parse(readFileSync(0, 'utf8')))));`,
        input: JSON.stringify(plan), env: {BBLITE_LOCAL_CUBEMAP_MODULE: import.meta.url}}));
    const modules = moduleClosureBytes(["material/pbr/enable-pbr-local-cubemap.js", "loader-env/env-parse.js",
        "loader-env/env-helpers.js", "material/pbr/fragments/local-cubemap-fragment.js"], pinnedLibraryRoot());
    const bytes = modules ? cachedBakeSync({kind: "local-cubemap", version: "1", module: moduleIdentity(import.meta.url),
        browser: false, parameters: {...plan},
        inputs: [...modules, ...plan.environments.map(source => readAssetBytesSync(source, plan.entryFileName))]}, execute) : execute();
    return Buffer.from(bytes).toString("utf8");
}
