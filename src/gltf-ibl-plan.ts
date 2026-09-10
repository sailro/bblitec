import ts from "typescript";
import {asIndex, asObject, asRecords, GLTF_MESH_PLAN, type JsonObject} from "./gltf-document.js";
import type {GltfGeometryPacker} from "./gltf-mesh-geometry.js";
import type {LoweringContext} from "./lowering/context.js";
import {featureMethod} from "./lowering/gltf/shared.js";
import {loadPinnedBrdfLutShader} from "./ibl-brdf-lut.js";
import {javascriptModuleUrl} from "./data-url.js";
import {pinnedModuleTextUrl} from "./pinned-shader-composer.js";
import {transpileForBrowser} from "./typescript-transpile.js";
import {RecordedTexture, RecordedTextureView, type Recorder, type DescriptorShapes, type RecordedComputeDispatch,
    type RecordedExtent, type RecordedOrigin} from "./recording-device.js";

export interface GltfIblTextures {
    width: number;
    mipCount: number;
    faces: Array<{bufferView: number; mimeType: string}>;
    harmonics: number;
    lodScale: number;
    brdfWidth: number;
}
export type GltfIblWrite =
    | {kind: "textures"; index: number}
    | {kind: "rotation" | "exposure" | "contrast"; value: number}
    | {kind: "toneMappingEnabled"; value: boolean};
export interface GltfIblPlan { textures: GltfIblTextures[]; setup: GltfIblWrite[] }

/** Execute source selection and assembly; only the browser image decoder is replaced. */
export function gltfIblSourceUrls(context: LoweringContext): {feature: string; assembly: string; rgbdShader: string; brdfShader: string} {
    const assemblyModule = "src/loader-gltf/ibl-env-assembly.ts";
    const assemblyFile = context.sourceFile(assemblyModule);
    const resolveImage = context.functionDeclaration(assemblyModule, "resolveImage").declaration;
    const transform = ts.transform(assemblyFile, [visitorContext => root => {
        const visit: ts.Visitor = node => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
                (node.expression.text === "createImageBitmap" || node.expression.text === "fetch"))
                return ts.factory.updateCallExpression(node, ts.factory.createIdentifier(
                    node.expression.text === "fetch" ? "__fetch" : "__decode"), undefined, node.arguments);
            const visited = ts.visitEachChild(node, visit, visitorContext);
            if (node === resolveImage && ts.isFunctionDeclaration(visited)) return ts.factory.updateFunctionDeclaration(visited,
                visited.modifiers, visited.asteriskToken, visited.name, visited.typeParameters,
                [...visited.parameters, ...["__decode", "__fetch"].map(name => ts.factory.createParameterDeclaration(undefined, undefined, name))],
                visited.type, visited.body);
            return visited;
        };
        return ts.visitNode(root, visit, ts.isSourceFile)!;
    }]);
    const brdfShader = loadPinnedBrdfLutShader();
    const assembly = pinnedModuleTextUrl("loader-gltf/ibl-env-assembly.js",
        transpileForBrowser(ts.createPrinter().printFile(transform.transformed[0]!), assemblyModule), [],
        new Map([["../../shaders/hdr-brdf-lut.compute.wgsl?raw", javascriptModuleUrl(`export default ${JSON.stringify(brdfShader)};`)]]));
    transform.dispose();
    const featureModule = "src/loader-gltf/gltf-ext-lights-image-based.ts";
    const file = context.sourceFile(featureModule);
    const method = featureMethod(file, "EXT_lights_image_based", "applyAsset");
    const ctx = method.parameters[2]?.name;
    const imageCalls = context.findNodes(method, (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "resolveImage"));
    if (!ctx || !ts.isIdentifier(ctx) || imageCalls.length !== 1 || imageCalls[0]!.arguments.length !== 4)
        context.contractError(method, "Expected the glTF IBL image resolution boundary.");
    const featureTransform = ts.transform(file, [visitorContext => root => {
        const visit: ts.Visitor = node => node === imageCalls[0]
            ? ts.factory.updateCallExpression(imageCalls[0], ts.factory.createPropertyAccessExpression(ctx, "recordIblImage"),
                undefined, imageCalls[0].arguments)
            : ts.visitEachChild(node, visit, visitorContext);
        return ts.visitNode(root, visit, ts.isSourceFile)!;
    }]);
    const uploadModule = "src/loader-gltf/ibl-cubemap-upload.ts";
    const upload = pinnedModuleTextUrl("loader-gltf/ibl-cubemap-upload.js",
        transpileForBrowser(context.sourceFile(uploadModule).text, uploadModule));
    const feature = pinnedModuleTextUrl("loader-gltf/gltf-ext-lights-image-based.js",
        transpileForBrowser(ts.createPrinter().printFile(featureTransform.transformed[0]!), featureModule), [],
        new Map([["./ibl-env-assembly.js", assembly], ["./ibl-cubemap-upload.js", upload]]));
    featureTransform.dispose();
    // Native RGBD arithmetic is generated from this shared shader. Different
    // addressing or kernels require a wider native texture adapter.
    const rgbdFile = context.sourceFile("src/loader-env/rgbd-decode.ts");
    const rgbdShader = context.stringValue(context.variableInitializer(rgbdFile, "WGSL"), rgbdFile);
    return {feature, assembly, rgbdShader, brdfShader};
}

class EncodedIblImage {
    public closed = false;
    public constructor(public readonly blob: Blob) {}
    public close(): void { this.closed = true; }
}
export interface SourceIblImageResolver {
    (json: JsonObject, bin: DataView, index: number, base: string,
        decode: (blob: Blob, options: unknown) => Promise<EncodedIblImage>, fetch: () => never): Promise<EncodedIblImage>;
}
export function resolveRecordedIblImage(source: SourceIblImageResolver, json: JsonObject, bin: DataView, index: number, base: string): Promise<object> {
    return source(json, bin, index, base, async (blob, options) => {
        if (!(blob instanceof Blob) || !sameFields(options, {premultiplyAlpha: "none", colorSpaceConversion: "none"}))
            throw new Error("Unsupported glTF IBL browser image decoding options.");
        return new Proxy(new EncodedIblImage(blob), {get(target, key, receiver) {
            if (key === "then") return undefined;
            if (!Reflect.has(target, key)) throw new Error(`Unrepresented glTF IBL image field '${String(key)}'.`);
            return Reflect.get(target, key, receiver);
        }});
    }, () => { throw new Error("glTF IBL images must be resolved by asset packaging before source execution."); });
}

function scalar(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid glTF IBL scalar.");
    return value;
}
function sameFields(value: unknown, expected: JsonObject): boolean {
    const record = asObject(value);
    return !!record && Object.keys(record).length === Object.keys(expected).length &&
        Object.entries(expected).every(([key, value]) => record[key] === value);
}
function plainView(value: unknown): RecordedTexture {
    if (!(value instanceof RecordedTextureView) || Object.keys(value.descriptor).length)
        throw new Error("Unsupported glTF IBL compute texture view.");
    return value.texture;
}
function computeBindings(dispatch: RecordedComputeDispatch<DescriptorShapes>, shader: string, count: number): RecordedTexture[] {
    const descriptor = dispatch.pipeline.descriptor;
    const group = asObject(dispatch.bindGroups.get(0));
    const entries = asRecords(group?.entries);
    if (descriptor.layout !== "auto" || descriptor.compute.entryPoint !== "main" ||
        asObject(descriptor.compute.module)?.code !== shader || dispatch.bindGroups.size !== 1 ||
        group?.layout !== dispatch.pipeline.getBindGroupLayout(0) || !Array.isArray(group.entries) ||
        group.entries.length !== count || entries.length !== count || entries.some((entry, index) => entry.binding !== index))
        throw new Error("Unsupported glTF IBL compute pipeline or binding layout.");
    return entries.map(entry => plainView(entry.resource));
}
function fullExtent(texture: RecordedTexture, size: RecordedExtent): boolean {
    return texture.width === size.width && texture.height === size.height && size.depthOrArrayLayers === 1;
}
function zeroOrigin(origin: RecordedOrigin): boolean { return origin.x === 0 && origin.y === 0 && origin.z === 0; }

/** Records source scene assignments; unknown reads of prior runtime state refuse. */
export class GltfIblRecording {
    public readonly properties: PropertyDescriptorMap;
    private readonly environments: JsonObject[] = [];
    private readonly setup: GltfIblWrite[] = [];
    private contributors: Array<(data: Float32Array, scene: object) => void> | undefined;
    private readonly disposables: Array<() => void> = [];

    public constructor(private readonly recorder: Recorder<DescriptorShapes>,
        private readonly shaders: {rgbdShader: string; brdfShader: string}) {
        const imageProcessing = new Proxy({}, {get(_target, key) {
            throw new Error(`glTF IBL setup reads existing image processing '${String(key)}'.`);
        }, set: (_target, key, value: unknown) => {
            if (key === "toneMappingEnabled" && typeof value === "boolean") this.setup.push({kind: key, value});
            else if (key === "exposure" || key === "contrast") this.setup.push({kind: key, value: scalar(value)});
            else throw new Error(`Unrepresented glTF IBL image processing field '${String(key)}'.`);
            return true;
        }});
        const unreadable = () => { throw new Error("glTF IBL setup reads prior environment state."); };
        this.properties = {
            _envTextures: {get: unreadable, set: (value: unknown) => {
                const record = asObject(value);
                if (!record) throw new Error("Invalid glTF IBL texture assembly.");
                let index = this.environments.indexOf(record);
                if (index < 0) { index = this.environments.length; this.environments.push(record); }
                this.setup.push({kind: "textures", index});
            }},
            _environmentRotation: {get: unreadable, set: (value: unknown) => this.setup.push({kind: "rotation", value: scalar(value)})},
            _sceneUboContributors: {get: () => this.contributors, set: (value: unknown) => {
                if (!Array.isArray(value) || value.length) throw new Error("Unsupported glTF IBL uniform contributor initialization.");
                this.contributors = value;
            }},
            _disposables: {value: this.disposables},
            imageProcessing: {value: imageProcessing},
        };
    }

    public async package(packer: GltfGeometryPacker): Promise<GltfIblPlan> {
        if (!this.environments.length) return {textures: [], setup: this.setup};
        const images = new Map<RecordedTexture, EncodedIblImage>();
        const faces = new Map<RecordedTexture, Map<number, EncodedIblImage>>();
        const brdfTextures = new Set<RecordedTexture>();
        for (const operation of this.recorder.textureOperations) {
            if (operation.kind === "upload") {
                const upload = operation.upload;
                // Mesh construction also writes unrelated placeholder textures.
                if (upload.kind !== "external") continue;
                const external = asObject(upload.source), destination = asObject(upload.destination);
                if (!(external?.source instanceof EncodedIblImage) || external.flipY !== false ||
                    !sameFields(destination, {texture: operation.texture, premultipliedAlpha: false}) ||
                    !fullExtent(operation.texture, upload.size) || upload.mipLevel !== 0 || !zeroOrigin(upload.origin) ||
                    operation.texture.format !== "rgba8unorm") throw new Error("Unsupported glTF IBL image upload.");
                images.set(operation.texture, external.source);
            } else if (operation.kind === "compute") {
                const dispatch = operation.dispatch;
                if (asObject(dispatch.pipeline.descriptor.compute.module)?.code === this.shaders.brdfShader) {
                    const [texture] = computeBindings(dispatch, this.shaders.brdfShader, 1);
                    if (!texture || texture.width !== 256 || texture.height !== 256 || texture.depthOrArrayLayers !== 1 ||
                        texture.mipLevelCount !== 1 || texture.format !== "rgba16float" ||
                        dispatch.pipeline.descriptor.compute.constants !== undefined ||
                        dispatch.workgroups.length !== 2 || dispatch.workgroups.some(value => value !== 32))
                        throw new Error("Unsupported glTF IBL BRDF bake contract.");
                    brdfTextures.add(texture);
                } else {
                    const [input, output] = computeBindings(dispatch, this.shaders.rgbdShader, 2);
                    const image = input && images.get(input);
                    if (!input || !output || !image || input.format !== "rgba8unorm" || output.format !== "rgba16float" ||
                        !fullExtent(output, input) || output.depthOrArrayLayers !== 1 || input.mipLevelCount !== 1 || output.mipLevelCount !== 1 ||
                        !sameFields(dispatch.pipeline.descriptor.compute.constants, {0: 1}) || dispatch.workgroups.length !== 2 ||
                        dispatch.workgroups[0] !== Math.ceil(input.width / 8) || dispatch.workgroups[1] !== Math.ceil(input.height / 8))
                        throw new Error("Unsupported glTF IBL RGBD decode contract.");
                    images.set(output, image);
                }
            } else {
                const {source, destination, size} = operation.copy;
                const image = images.get(source.texture), cube = destination.texture;
                if (!image || !zeroOrigin(source.origin) || source.mipLevel !== 0 ||
                    !fullExtent(source.texture, size) || cube.depthOrArrayLayers !== 6 || cube.format !== "rgba16float" ||
                    cube.width !== cube.height || destination.origin.x !== 0 || destination.origin.y !== 0 ||
                    asIndex(destination.origin.z) === undefined || destination.origin.z >= 6 ||
                    asIndex(destination.mipLevel) === undefined || destination.mipLevel >= cube.mipLevelCount ||
                    size.width !== Math.max(1, cube.width >> destination.mipLevel) || size.height !== size.width)
                    throw new Error("Unsupported glTF IBL cube copy.");
                let layers = faces.get(cube);
                if (!layers) { layers = new Map(); faces.set(cube, layers); }
                layers.set(destination.mipLevel * 6 + destination.origin.z, image);
            }
        }
        const textures: GltfIblTextures[] = [];
        for (const environment of this.environments) {
            const cube = environment.specularCube, brdf = environment.brdfLut;
            if (!(cube instanceof RecordedTexture) || !(brdf instanceof RecordedTexture) || !brdfTextures.has(brdf) ||
                !(environment.specularCubeView instanceof RecordedTextureView) || environment.specularCubeView.texture !== cube ||
                !sameFields(environment.specularCubeView.descriptor, {dimension: "cube"}) || plainView(environment.brdfLutView) !== brdf ||
                !sameFields(environment.cubeSampler, {magFilter: "linear", minFilter: "linear", mipmapFilter: "linear"}) ||
                !sameFields(environment.brdfSampler, {magFilter: "linear", minFilter: "linear"}) || cube.destroyed || brdf.destroyed)
                throw new Error("Unsupported glTF IBL environment resources.");
            const layers = faces.get(cube);
            if (!layers || layers.size !== cube.mipLevelCount * 6) throw new Error("Incomplete glTF IBL cube faces.");
            const packedFaces: GltfIblTextures["faces"] = [];
            for (let index = 0; index < layers.size; index++) {
                const image = layers.get(index);
                if (!image || !image.closed) throw new Error("Unreleased glTF IBL source image.");
                packedFaces.push({bufferView: packer.bytes(image, new Uint8Array(await image.blob.arrayBuffer())), mimeType: image.blob.type});
            }
            const uniform = new Float32Array(76).fill(NaN);
            let rotationForwarded = false;
            const runtimeRotation = Object.freeze({[Symbol.toPrimitive]() {
                throw new Error("Unsupported arithmetic on the runtime glTF IBL rotation.");
            }});
            // The native uniform writer transports runtime rotation separately.
            // Preserve its identity at that store; source arithmetic on an
            // unknown prior scene value cannot be baked into this asset.
            const sink = new Proxy(uniform, {
                get(target, key) {
                    const value: unknown = Reflect.get(target, key, target);
                    return typeof value === "function" ? value.bind(target) : value;
                },
                set(target, key, value: unknown) {
                    if (value === runtimeRotation) {
                        if (key !== "36") throw new Error("Unsupported glTF IBL rotation storage.");
                        rotationForwarded = true;
                        value = 0;
                    }
                    return Reflect.set(target, key, value, target);
                },
            });
            if (!this.contributors?.length || this.contributors.some(writer => typeof writer !== "function"))
                throw new Error("Missing glTF IBL scene uniform registration.");
            for (const writer of this.contributors) writer(sink, {_envTextures: environment, _environmentRotation: runtimeRotation});
            const harmonics = uniform.slice(40, 76);
            if (!rotationForwarded || harmonics.some((value, index) => !Number.isFinite(value) || (index % 4 === 3 && value !== 0)) || uniform[36] !== 0 ||
                [...uniform.slice(0, 36), ...uniform.slice(37, 40)].some(value => !Number.isNaN(value)))
                throw new Error("Unsupported glTF IBL scene uniform storage.");
            textures.push({width: cube.width, mipCount: cube.mipLevelCount, faces: packedFaces,
                harmonics: packer.float32(harmonics, 4), lodScale: scalar(environment.lodGenerationScale), brdfWidth: brdf.width});
        }
        for (const dispose of this.disposables) {
            if (typeof dispose !== "function") throw new Error("Invalid glTF IBL resource disposal.");
            dispose();
        }
        if (this.environments.some(environment => !(environment.specularCube instanceof RecordedTexture) || !environment.specularCube.destroyed ||
            !(environment.brdfLut instanceof RecordedTexture) || !environment.brdfLut.destroyed)) throw new Error("Unowned glTF IBL environment textures.");
        return {textures, setup: this.setup};
    }
}

export function packagedGltfIbl(document: JsonObject): GltfIblPlan {
    const value = asObject(asObject(document[GLTF_MESH_PLAN])?.ibl);
    if (!value || !Array.isArray(value.textures) || !Array.isArray(value.setup)) throw new Error("Invalid or missing packaged glTF IBL schedule.");
    const accessors = value.textures.length ? asRecords(document.accessors) : [];
    const viewCount = Array.isArray(document.bufferViews) ? document.bufferViews.length : 0;
    const textures = value.textures.map(value => {
        const record = asObject(value), width = asIndex(record?.width), mipCount = asIndex(record?.mipCount), harmonics = asIndex(record?.harmonics);
        const accessor = harmonics === undefined ? undefined : accessors[harmonics];
        if (!record || !width || !mipCount || !Array.isArray(record.faces) || record.faces.length !== mipCount * 6 ||
            accessor?.type !== "VEC4" || accessor.count !== 9 || accessor.componentType !== 5126 || harmonics === undefined || record.brdfWidth !== 256)
            throw new Error("Invalid packaged glTF IBL resources.");
        const faces = record.faces.map(value => {
            const face = asObject(value), bufferView = asIndex(face?.bufferView);
            if (bufferView === undefined || bufferView >= viewCount || typeof face?.mimeType !== "string") throw new Error("Invalid packaged glTF IBL face.");
            return {bufferView, mimeType: face.mimeType};
        });
        return {width, mipCount, harmonics, faces, lodScale: scalar(record.lodScale), brdfWidth: record.brdfWidth};
    });
    const setup = value.setup.map((value): GltfIblWrite => {
        const write = asObject(value), index = asIndex(write?.index);
        if (write?.kind === "textures" && index !== undefined && index < textures.length) return {kind: "textures", index};
        if (write?.kind === "toneMappingEnabled" && typeof write.value === "boolean") return {kind: write.kind, value: write.value};
        if (write?.kind === "rotation" || write?.kind === "exposure" || write?.kind === "contrast") return {kind: write.kind, value: scalar(write.value)};
        throw new Error("Invalid packaged glTF IBL scene write.");
    });
    return {textures, setup};
}
