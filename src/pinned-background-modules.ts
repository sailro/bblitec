/**
 * The pin's background renderables as its own factories build and draw them.
 *
 * Each background factory composes its two modules at run time --
 * `SCENE_UBO_WGSL` in front of the vertex stage, the image-processing and
 * dither helpers in front of the fragment -- creates its group-1 layout, its
 * pipeline and its buffers, and returns a renderable whose `draw` binds them.
 * Generation runs every reached factory against the recording device, binds
 * the renderable and records one draw, and reads back what the pin built:
 * the modules (deployed whole, the compaction pass re-homing their groups for
 * SDL_GPU), the vertex layouts, the rasterizer, depth and blend state, the
 * group-1 layout entries, and which of the pin's buffers each vertex slot and
 * the index buffer read. Nothing is rewritten or re-addressed here.
 *
 * The values a factory is handed (sizes, colours, positions) decide only
 * the buffers it uploads, never the modules, layouts or states read back.
 * The uploads a scene needs are the lowered mesh-block writers and geometry
 * builders, run natively over the scene's own values; this module names, per
 * draw slot, the builder result each one reads, by executing the builder
 * beside the factory at the same input and matching the bytes.
 */
import ts from "typescript";
import { javascriptModuleUrl } from "./data-url.js";
import {
    importPinnedModuleFetching,
    importPinnedModuleWithExports,
    readPinnedLibraryModule,
} from "./pinned-shader-composer.js";
import {
    createRecordingDevice,
    RecordedBuffer,
    RecordedTexture,
    type DescriptorShapes,
    type DeviceMethod,
    type RecordedDeviceMethods,
    type RecordedRenderPass,
} from "./recording-device.js";
import {
    reflectWgslBindings,
    reflectWgslModule,
    wgslEntryPoints,
} from "./shader-ir.js";
import { pinnedSceneLayout } from "./pinned-scene-layout.js";

/** One attribute of a pinned vertex buffer layout. */
export interface PinnedVertexAttribute {
    shaderLocation: number;
    offset: number;
    format: string;
}

/** One pinned vertex buffer layout. */
export interface PinnedVertexBufferLayout {
    arrayStride: number;
    attributes: readonly PinnedVertexAttribute[];
}

/** One deployed stage: the stem it compiles under and the pin's module. */
export interface PinnedBackgroundStage {
    stem: string;
    wgsl: string;
}

/** A group-1 layout entry, as the pin's `createBindGroupLayout` states it. */
export interface PinnedBackgroundBinding {
    binding: number;
    /** The module variable at this binding, for diagnostics. */
    name: string;
    kind: "uniformBuffer" | "texture2d" | "textureCube" | "sampler";
    vertex: boolean;
    fragment: boolean;
}

/** One of `BlendFactor`'s names, the blend factors the pin's arms use. */
export type PinnedBlendFactor = "one" | "src_alpha" | "one_minus_src_alpha";

/** The pipeline state the pin's descriptor sets, beyond modules and layouts. */
export interface PinnedBackgroundPipelineState {
    cullMode: "none" | "back";
    clockwiseFrontFace: boolean;
    depthWrite: boolean;
    blend?: {
        srcColor: PinnedBlendFactor;
        dstColor: PinnedBlendFactor;
        srcAlpha: PinnedBlendFactor;
        dstAlpha: PinnedBlendFactor;
    };
}

/**
 * What the pin's `draw` binds, as keys into its geometry builder's result:
 * `posBuffer`, `0`, `positions` -- a property of the object the builder
 * returns, or an element of its tuple.
 */
export interface PinnedBackgroundDraw {
    vertexSlots: readonly string[];
    index: string;
    indexFormat: "uint16" | "uint32";
}

export type PinnedBackgroundArmName =
    | "ground"
    | "groundDither"
    | "ddsSkybox"
    | "ddsSkyboxNoDither"
    | "hdrSkybox"
    | "solidSkybox"
    | "imageSkybox";

/** A background arm as its factory built and drew it. */
export interface PinnedBackgroundArm {
    name: PinnedBackgroundArmName;
    vertex: PinnedBackgroundStage;
    fragment: PinnedBackgroundStage;
    vertexBuffers: readonly PinnedVertexBufferLayout[];
    pipeline: PinnedBackgroundPipelineState;
    /** Group 1, in binding order. Group 0 is the scene group every arm shares. */
    bindings: readonly PinnedBackgroundBinding[];
    draw: PinnedBackgroundDraw;
    /** The byte size of the mesh block group 1 binds at binding 0. */
    meshBlockBytes: number;
    /**
     * A mesh block the pin writes from constants alone, as it wrote it: the
     * image skybox's identity world. Absent where a lowered writer builds
     * the block from the scene's values.
     */
    constantMeshBlock?: readonly number[];
    /** The factory that built it, for provenance. */
    modulePath: string;
    symbolName: string;
}

interface BackgroundShapes extends DescriptorShapes {
    shaderModule: { code: string };
    bindGroupLayout: {
        entries: readonly {
            binding: number;
            visibility: number;
            buffer?: { type?: string };
            texture?: { sampleType?: string; viewDimension?: string };
            sampler?: { type?: string };
        }[];
    };
    pipelineLayout: {
        bindGroupLayouts: readonly BackgroundShapes["bindGroupLayout"][];
    };
    renderPipeline: {
        layout: BackgroundShapes["pipelineLayout"] | "auto";
        vertex: {
            module: { code: string };
            buffers?: readonly PinnedVertexBufferLayout[];
        };
        fragment?: {
            module: { code: string };
            targets: readonly {
                blend?: Record<
                    "color" | "alpha",
                    {
                        srcFactor?: string;
                        dstFactor?: string;
                        operation?: string;
                    }
                >;
            }[];
        };
        primitive?: {
            topology?: string;
            cullMode?: string;
            frontFace?: string;
        };
        depthStencil?: { depthWriteEnabled?: boolean };
    };
    bindGroup: {
        entries: readonly { binding: number; resource: unknown }[];
    };
}

const recordedMethods: readonly DeviceMethod[] = [
    "createBuffer",
    "createTexture",
    "createSampler",
    "createShaderModule",
    "createBindGroupLayout",
    "createPipelineLayout",
    "createRenderPipeline",
    "createBindGroup",
];

/**
 * The target signature a factory keys its pipeline on. Its depth compare and
 * sample count are the pass's, not the arm's: a backend draws each arm under
 * its own pass state, so neither is read back.
 */
const signature = {
    _colorFormat: "rgba8unorm",
    _depthStencilFormat: "depth24plus-stencil8",
    _depthCompare: "greater-equal",
    _sampleCount: 4,
};

/** WebGPU's `GPUShaderStage` bits. */
const vertexStage = 1;
const fragmentStage = 2;

function refuse(symbol: string, what: string): never {
    throw new Error(`Pinned ${symbol} ${what}.`);
}

/**
 * The extra exports a packaged module needs for each of `symbols` to be
 * importable by its own name: none for one the package already exports so,
 * the name itself for one the bundler left module-local (exported, if at
 * all, under a mangled alias). Read off the packaged module's export clauses.
 */
function exportsFor(
    relativePath: string,
    symbols: readonly string[],
): string[] {
    const file = ts.createSourceFile(
        relativePath,
        readPinnedLibraryModule(relativePath),
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.JS,
    );
    const exported = new Set<string>();
    for (const statement of file.statements) {
        if (
            ts.isExportDeclaration(statement) &&
            statement.exportClause !== undefined &&
            ts.isNamedExports(statement.exportClause)
        ) {
            for (const element of statement.exportClause.elements) {
                exported.add(element.name.text);
            }
        }
    }
    return symbols.filter((symbol) => !exported.has(symbol));
}

type PinnedFunction = (...args: unknown[]) => unknown;

function exportedFunction(
    module: Record<string, unknown>,
    relativePath: string,
    symbol: string,
): PinnedFunction {
    const value = module[symbol];
    if (typeof value !== "function") {
        refuse(relativePath, `no longer defines ${symbol}`);
    }
    return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, undefined, args);
        return result;
    };
}

/** A pinned module's functions, each importable by its own name. */
async function pinnedFunctions(
    relativePath: string,
    symbols: readonly string[],
    redirects: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, PinnedFunction>> {
    const module = await importPinnedModuleWithExports<Record<string, unknown>>(
        relativePath,
        exportsFor(relativePath, symbols),
        redirects,
    );
    return new Map(
        symbols.map((symbol) => [
            symbol,
            exportedFunction(module, relativePath, symbol),
        ]),
    );
}

function pinnedFunction(
    functions: ReadonlyMap<string, PinnedFunction>,
    symbol: string,
): PinnedFunction {
    const found = functions.get(symbol);
    if (!found) refuse(symbol, "was not imported");
    return found;
}

type BackgroundDevice = RecordedDeviceMethods<BackgroundShapes>;

/** An engine record over a device that records only buffer creation. */
function bufferEngine(producer: string): object {
    return {
        _device: createRecordingDevice({ producer, device: ["createBuffer"] })
            .device,
    };
}

interface BoundDraw {
    pipeline: unknown;
    draw(pass: unknown): unknown;
}

interface BindableRenderable {
    bind(engine: unknown, sig: unknown): unknown;
}

function isBindable(value: unknown): value is BindableRenderable {
    return (
        typeof value === "object" &&
        value !== null &&
        "bind" in value &&
        typeof value.bind === "function"
    );
}

function isBoundDraw(value: unknown): value is BoundDraw {
    return (
        typeof value === "object" &&
        value !== null &&
        "pipeline" in value &&
        "draw" in value &&
        typeof value.draw === "function"
    );
}

function objectMember(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null
        ? Reflect.get(value, key)
        : undefined;
}

/**
 * Whether a bound renderable's pipeline is one a recording device made: a
 * copy of the descriptor the pin passed, with a vertex module's code and a
 * layout of bind group layouts.
 */
function isRecordedPipeline(
    value: unknown,
): value is BackgroundShapes["renderPipeline"] {
    const layout = objectMember(value, "layout");
    const code = objectMember(
        objectMember(objectMember(value, "vertex"), "module"),
        "code",
    );
    return (
        typeof code === "string" &&
        (layout === "auto" ||
            Array.isArray(objectMember(layout, "bindGroupLayouts")))
    );
}

/** The bytes a recorded buffer or a typed array holds. */
function leafBytes(value: unknown): Uint8Array | undefined {
    if (value instanceof RecordedBuffer) return new Uint8Array(value.bytes);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return undefined;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength &&
        left.every((byte, index) => byte === right[index])
    );
}

/**
 * The key, into a geometry builder's result, of the one buffer or array
 * holding exactly `bytes`. The builder ran at the factory's own input, so
 * the draw's buffer is byte-identical to the result it was made from.
 */
function builderKey(
    result: unknown,
    bytes: Uint8Array,
    symbolName: string,
    what: string,
): string {
    if (typeof result !== "object" || result === null) {
        refuse(symbolName, "no longer returns its buffers");
    }
    const matches = Object.entries(result).filter(([, value]) => {
        const leaf = leafBytes(value);
        return leaf !== undefined && sameBytes(leaf, bytes);
    });
    if (matches.length !== 1) {
        refuse(
            symbolName,
            `returns ${matches.length} results matching the ${what} its ` +
                "renderable draws; one was expected",
        );
    }
    return matches[0]![0];
}

function blendFactor(
    value: string | undefined,
    symbol: string,
): PinnedBlendFactor {
    switch (value) {
        case "one":
            return "one";
        case "src-alpha":
            return "src_alpha";
        case "one-minus-src-alpha":
            return "one_minus_src_alpha";
        default:
            refuse(symbol, `blends with factor '${String(value)}'`);
    }
}

function pipelineState(
    pipeline: BackgroundShapes["renderPipeline"],
    symbol: string,
): PinnedBackgroundPipelineState {
    const primitive = pipeline.primitive ?? {};
    if ((primitive.topology ?? "triangle-list") !== "triangle-list") {
        refuse(symbol, `draws ${String(primitive.topology)}`);
    }
    const cullMode = primitive.cullMode ?? "none";
    if (cullMode !== "none" && cullMode !== "back") {
        refuse(symbol, `culls '${cullMode}'`);
    }
    const frontFace = primitive.frontFace ?? "ccw";
    if (frontFace !== "ccw" && frontFace !== "cw") {
        refuse(symbol, `names front face '${frontFace}'`);
    }
    const targets = pipeline.fragment?.targets ?? [];
    if (targets.length !== 1) {
        refuse(symbol, `writes ${targets.length} colour targets`);
    }
    const blend = targets[0]!.blend;
    if (blend) {
        for (const lane of [blend.color, blend.alpha]) {
            if ((lane.operation ?? "add") !== "add") {
                refuse(
                    symbol,
                    `blends with operation '${String(lane.operation)}'`,
                );
            }
        }
    }
    return {
        cullMode,
        clockwiseFrontFace: frontFace === "cw",
        depthWrite: pipeline.depthStencil?.depthWriteEnabled === true,
        ...(blend
            ? {
                  blend: {
                      srcColor: blendFactor(
                          blend.color.srcFactor ?? "one",
                          symbol,
                      ),
                      dstColor: blendFactor(
                          blend.color.dstFactor ?? "zero",
                          symbol,
                      ),
                      srcAlpha: blendFactor(
                          blend.alpha.srcFactor ?? "one",
                          symbol,
                      ),
                      dstAlpha: blendFactor(
                          blend.alpha.dstFactor ?? "zero",
                          symbol,
                      ),
                  },
              }
            : {}),
    };
}

/** The module variable at `group`/`binding`, across both stages. */
function bindingName(
    modules: readonly string[],
    group: number,
    binding: number,
    symbol: string,
): string {
    for (const code of modules) {
        const variable = reflectWgslBindings(code).find(
            (candidate) =>
                candidate.group === group && candidate.binding === binding,
        );
        if (variable) return variable.name;
    }
    refuse(
        symbol,
        `lays out @group(${group}) @binding(${binding}), which neither ` +
            "stage declares",
    );
}

type LayoutEntry = BackgroundShapes["bindGroupLayout"]["entries"][number];

function bindingKind(
    entry: LayoutEntry,
    symbol: string,
): PinnedBackgroundBinding["kind"] {
    if (entry.buffer) {
        if ((entry.buffer.type ?? "uniform") !== "uniform") {
            refuse(symbol, `binds a '${String(entry.buffer.type)}' buffer`);
        }
        return "uniformBuffer";
    }
    if (entry.texture) {
        if ((entry.texture.sampleType ?? "float") !== "float") {
            refuse(
                symbol,
                `binds a '${String(entry.texture.sampleType)}' texture`,
            );
        }
        switch (entry.texture.viewDimension ?? "2d") {
            case "cube":
                return "textureCube";
            case "2d":
                return "texture2d";
            default:
                refuse(
                    symbol,
                    `binds a '${String(entry.texture.viewDimension)}' texture`,
                );
        }
    }
    if (entry.sampler) {
        if ((entry.sampler.type ?? "filtering") !== "filtering") {
            refuse(symbol, `binds a '${String(entry.sampler.type)}' sampler`);
        }
        return "sampler";
    }
    refuse(
        symbol,
        `lays out binding ${entry.binding} as neither buffer, texture nor ` +
            "sampler",
    );
}

function groupRows(
    layout: BackgroundShapes["bindGroupLayout"],
    modules: readonly string[],
    symbol: string,
): PinnedBackgroundBinding[] {
    return [...layout.entries]
        .sort((left, right) => left.binding - right.binding)
        .map((entry) => ({
            binding: entry.binding,
            name: bindingName(modules, 1, entry.binding, symbol),
            kind: bindingKind(entry, symbol),
            vertex: (entry.visibility & vertexStage) !== 0,
            fragment: (entry.visibility & fragmentStage) !== 0,
        }));
}

/**
 * Group 0 is the pin's scene group (`getSceneBindGroupLayout`), which every
 * backend binds from its per-pass frame state and lays out from the rows
 * recorded off that same call. An arm laying out anything else there is
 * outside that contract.
 */
function assertSceneGroup(
    layout: BackgroundShapes["bindGroupLayout"],
    symbol: string,
): void {
    const rows = layout.entries
        .map((entry) => ({
            binding: entry.binding,
            uniform:
                entry.buffer !== undefined &&
                (entry.buffer.type ?? "uniform") === "uniform",
            vertex: (entry.visibility & vertexStage) !== 0,
            fragment: (entry.visibility & fragmentStage) !== 0,
        }))
        .sort((left, right) => left.binding - right.binding);
    const scene = pinnedSceneLayout();
    if (
        rows.length !== scene.length ||
        rows.some(
            (row, index) =>
                !row.uniform ||
                row.binding !== scene[index]!.binding ||
                row.vertex !== scene[index]!.vertex ||
                row.fragment !== scene[index]!.fragment,
        )
    ) {
        refuse(symbol, "no longer lays out group 0 as the pin's scene layout");
    }
}

type RecordedArmFields = Omit<PinnedBackgroundArm, "draw" | "name">;

interface RecordedArm {
    fields: RecordedArmFields;
    pass: RecordedRenderPass<BackgroundShapes>;
    meshBlock: Uint8Array;
}

/**
 * Runs one factory against a fresh recording device, binds the renderable it
 * produced to the target signature, draws it once, and reads back the one
 * pipeline and the one draw.
 */
async function recordArm(
    stems: { vertex: string; fragment: string },
    modulePath: string,
    symbolName: string,
    run: (engine: { _device: BackgroundDevice }) => Promise<unknown>,
): Promise<RecordedArm> {
    const { device, encoder, recorder } =
        createRecordingDevice<BackgroundShapes>({
            producer: `${modulePath}#${symbolName}`,
            device: recordedMethods,
            queue: ["writeBuffer", "writeTexture"],
            encoder: ["beginRenderPass"],
            renderPass: [
                "setPipeline",
                "setBindGroup",
                "setVertexBuffer",
                "setIndexBuffer",
                "drawIndexed",
            ],
        });
    const engine = { _device: device };
    const renderable = await run(engine);
    if (!isBindable(renderable)) {
        refuse(symbolName, "no longer returns a renderable");
    }
    const bound = renderable.bind(engine, signature);
    if (!isBoundDraw(bound)) {
        refuse(symbolName, "no longer binds to a drawable");
    }
    const target = new RecordedTexture({
        size: [1, 1],
        format: signature._colorFormat,
        usage: 0,
    });
    const beginRenderPass: unknown = Reflect.get(encoder, "beginRenderPass");
    if (typeof beginRenderPass !== "function") {
        refuse(symbolName, "is recorded without a render pass");
    }
    const pass: unknown = Reflect.apply(beginRenderPass, encoder, [
        { colorAttachments: [{ view: target.createView(), loadOp: "load" }] },
    ]);
    bound.draw(pass);
    const recordedPass = recorder.renderPasses[0]!;

    // The pipeline the renderable binds, not the device's last creation:
    // the pin caches a factory's pipelines in module state across the
    // devices it is handed, so a second composition in one process is
    // answered from that cache and creates none.
    const pipeline = bound.pipeline;
    if (!isRecordedPipeline(pipeline)) {
        refuse(symbolName, "no longer binds a recorded render pipeline");
    }
    const vertex = pipeline.vertex.module.code;
    const fragment = pipeline.fragment?.module.code;
    if (fragment === undefined) {
        refuse(symbolName, "built a pipeline without a fragment stage");
    }
    for (const [code, stage] of [
        [vertex, "vertex"],
        [fragment, "fragment"],
    ] as const) {
        if (wgslEntryPoints(reflectWgslModule(code), stage).length !== 1) {
            refuse(symbolName, `no longer declares one ${stage} entry point`);
        }
    }
    if (
        pipeline.layout === "auto" ||
        pipeline.layout.bindGroupLayouts.length !== 2
    ) {
        refuse(
            symbolName,
            "no longer lays out the scene group and one mesh group",
        );
    }
    const [sceneGroup, meshGroup] = pipeline.layout.bindGroupLayouts;
    assertSceneGroup(sceneGroup!, symbolName);

    const groups = recordedPass.bindGroups;
    if (groups.length !== 1 || groups[0]!.index !== 1) {
        refuse(symbolName, "no longer binds exactly its group 1 when it draws");
    }
    const meshResource: unknown = groups[0]!.group.entries.find(
        (entry) => entry.binding === 0,
    )?.resource;
    const meshBuffer: unknown =
        typeof meshResource === "object" &&
        meshResource !== null &&
        "buffer" in meshResource
            ? meshResource.buffer
            : undefined;
    if (!(meshBuffer instanceof RecordedBuffer)) {
        refuse(
            symbolName,
            "no longer binds its mesh block at group 1 binding 0",
        );
    }
    return {
        fields: {
            vertex: { stem: stems.vertex, wgsl: vertex },
            fragment: { stem: stems.fragment, wgsl: fragment },
            vertexBuffers: (pipeline.vertex.buffers ?? []).map((buffer) => ({
                arrayStride: buffer.arrayStride,
                attributes: buffer.attributes.map((attribute) => ({
                    shaderLocation: attribute.shaderLocation,
                    offset: attribute.offset,
                    format: attribute.format,
                })),
            })),
            pipeline: pipelineState(pipeline, symbolName),
            bindings: groupRows(meshGroup!, [vertex, fragment], symbolName),
            meshBlockBytes: meshBuffer.size,
            modulePath,
            symbolName,
        },
        pass: recordedPass,
        meshBlock: new Uint8Array(meshBuffer.bytes),
    };
}

/**
 * The draw a recorded arm made, as keys into its geometry builder's result
 * at the same input. The pin draws the whole index buffer; that is asserted
 * here, so a backend drawing the builder's index count is the pin's draw.
 */
function drawKeys(
    recorded: RecordedArm,
    builderResult: unknown,
    builder: string,
): PinnedBackgroundDraw {
    const { pass } = recorded;
    const { symbolName, vertexBuffers } = recorded.fields;
    const slots = [...pass.vertexBuffers.keys()].sort((a, b) => a - b);
    if (
        slots.length !== vertexBuffers.length ||
        slots.some((slot, index) => slot !== index)
    ) {
        refuse(
            symbolName,
            "no longer sets one buffer per declared vertex layout",
        );
    }
    const index = pass.indexBuffer;
    if (!index || (index.format !== "uint16" && index.format !== "uint32")) {
        refuse(
            symbolName,
            "no longer draws through a uint16 or uint32 index buffer",
        );
    }
    const elementBytes = index.format === "uint16" ? 2 : 4;
    const draws = pass.indexedDraws;
    const [count, instances = 1, ...offsets] = draws[0] ?? [];
    if (
        draws.length !== 1 ||
        count !== index.buffer.size / elementBytes ||
        instances !== 1 ||
        offsets.some((offset) => offset !== 0)
    ) {
        refuse(symbolName, "no longer draws its whole index buffer once");
    }
    return {
        vertexSlots: slots.map((slot) =>
            builderKey(
                builderResult,
                new Uint8Array(pass.vertexBuffers.get(slot)!.bytes),
                builder,
                `vertex slot ${slot}`,
            ),
        ),
        index: builderKey(
            builderResult,
            new Uint8Array(index.buffer.bytes),
            builder,
            "index buffer",
        ),
        indexFormat: index.format,
    };
}

function finishArm(
    name: PinnedBackgroundArmName,
    recorded: RecordedArm,
    builderResult: unknown,
    builder: string,
): PinnedBackgroundArm {
    return {
        name,
        ...recorded.fields,
        draw: drawKeys(recorded, builderResult, builder),
    };
}

/** A cube texture view and sampler, standing in for a loaded environment. */
function environmentTextures(device: BackgroundDevice): {
    specularCubeView: unknown;
    cubeSampler: unknown;
} {
    const texture = new RecordedTexture({
        size: [1, 1, 6],
        format: "rgba16float",
        usage: 0,
    });
    return {
        specularCubeView: texture.createView({ dimension: "cube" }),
        cubeSampler: device.createSampler({}),
    };
}

/** The scene record a background factory reads. */
function sceneFor(engine: object): Record<string, unknown> {
    return {
        surface: { engine },
        clearColor: { r: 0.25, g: 0.5, b: 0.75, a: 1 },
        imageProcessing: { exposure: 1, contrast: 1, toneMappingEnabled: true },
        _renderables: [],
    };
}

/**
 * The smallest DDS cube container `loadDdsCube` reads: a one-texel,
 * one-level `DX10` cube. The skybox factory fetches its texture before it
 * composes, and generation answers that fetch rather than the network; the
 * texture is never part of what is read back.
 */
function unitDdsCube(): Uint8Array {
    const header = new Int32Array(37);
    header[3] = 1; // width
    header[7] = 1; // mip count
    header[21] = 0x30315844; // 'DX10'
    const bytes = new Uint8Array(header.byteLength + 6 * 8);
    bytes.set(new Uint8Array(header.buffer));
    return bytes;
}

/**
 * `loadCubeTexture`'s stand-in for the image skybox: the loader fetches and
 * decodes six faces before it builds anything, and generation reads back
 * neither. The stand-in answers with a cube on the caller's own device.
 */
const cubeTextureShim = javascriptModuleUrl(
    "export async function loadCubeTexture(engine) {\n" +
        '    const texture = engine._device.createTexture({ size: [1, 1, 6], format: "rgba8unorm", usage: 0 });\n' +
        '    return { _view: texture.createView({ dimension: "cube" }), _sampler: engine._device.createSampler({}) };\n' +
        "}\n",
);

const groundModule = "material/pbr/background-ground.js";
const ddsModule = "material/pbr/background-dds-skybox.js";
const hdrModule = "material/pbr/background-hdr-skybox.js";
const solidModule = "material/pbr/background-solid-skybox.js";
const imageLoaderModule = "loader-skybox/load-skybox.js";
const boxModule = "mesh/create-box.js";

/**
 * The inputs each factory runs at. Distinct values, so every buffer a
 * builder returns holds bytes no other one does and the draw's slots match
 * one result each.
 */
const groundSize = 3.25;
const skyHalfSize = 7.5;
const imageSkyboxSizes = [11, 13] as const;
const rootPosition = [0.5, -1.25, 2];
const primaryColor = [0.125, 0.375, 0.625];

/** Which arms a scene reached. */
export interface PinnedBackgroundReach {
    ground: boolean;
    skybox: boolean;
    ddsEnvironment: boolean;
    solidSkybox: boolean;
    imageSkybox: boolean;
}

async function groundArms(): Promise<PinnedBackgroundArm[]> {
    const pinned = await pinnedFunctions(groundModule, [
        "buildGroundRenderable",
        "createGroundBuffers",
    ]);
    const build = pinnedFunction(pinned, "buildGroundRenderable");
    const buffers = pinnedFunction(pinned, "createGroundBuffers")(
        bufferEngine("createGroundBuffers"),
        groundSize,
    );
    const arms: PinnedBackgroundArm[] = [];
    for (const [name, enableNoise, stem] of [
        ["ground", false, "background-ground.frag"],
        ["groundDither", true, "background-ground-dither.frag"],
    ] as const) {
        const recorded = await recordArm(
            { vertex: "background-ground.vert", fragment: stem },
            "src/material/pbr/background-ground.ts",
            "buildGroundRenderable",
            async (engine) =>
                await build(
                    engine,
                    groundSize,
                    rootPosition,
                    primaryColor,
                    undefined,
                    undefined,
                    enableNoise,
                ),
        );
        arms.push(finishArm(name, recorded, buffers, "createGroundBuffers"));
    }
    return arms;
}

async function skyboxArms(
    ddsEnvironment: boolean,
): Promise<PinnedBackgroundArm[]> {
    const hdr = await pinnedFunctions(hdrModule, [
        "buildHdrSkyboxRenderable",
        "createSkyboxBuffers",
    ]);
    const buildHdr = pinnedFunction(hdr, "buildHdrSkyboxRenderable");
    const arms = [
        finishArm(
            "hdrSkybox",
            await recordArm(
                {
                    vertex: "background-skybox.vert",
                    fragment: "background-skybox.frag",
                },
                "src/material/pbr/background-hdr-skybox.ts",
                "buildHdrSkyboxRenderable",
                async (engine) =>
                    await buildHdr(
                        sceneFor(engine),
                        environmentTextures(engine._device),
                        skyHalfSize,
                        rootPosition,
                        primaryColor,
                    ),
            ),
            pinnedFunction(hdr, "createSkyboxBuffers")(
                bufferEngine("createSkyboxBuffers"),
                skyHalfSize,
            ),
            "createSkyboxBuffers",
        ),
    ];
    const ddsArms: Array<readonly [PinnedBackgroundArmName, boolean, string]> =
        [["ddsSkybox", true, "background-skybox-dither.frag"]];
    if (ddsEnvironment) {
        ddsArms.push([
            "ddsSkyboxNoDither",
            false,
            "background-skybox-dds.frag",
        ]);
    }
    const symbols = ["buildDdsSkyboxRenderable", "createSkyboxBuffers"];
    for (const [name, enableNoise, stem] of ddsArms) {
        const { module, release } = await importPinnedModuleFetching<
            Record<string, unknown>
        >(ddsModule, unitDdsCube, new Map(), exportsFor(ddsModule, symbols));
        try {
            const build = exportedFunction(module, ddsModule, symbols[0]!);
            const recorded = await recordArm(
                { vertex: "background-skybox-dds.vert", fragment: stem },
                "src/material/pbr/background-dds-skybox.ts",
                "buildDdsSkyboxRenderable",
                async (engine) =>
                    await build(
                        sceneFor(engine),
                        skyHalfSize,
                        rootPosition,
                        primaryColor,
                        "unit.dds",
                        enableNoise,
                    ),
            );
            arms.push(
                finishArm(
                    name,
                    recorded,
                    exportedFunction(
                        module,
                        ddsModule,
                        symbols[1]!,
                    )(bufferEngine("createSkyboxBuffers"), skyHalfSize),
                    "createSkyboxBuffers",
                ),
            );
        } finally {
            release();
        }
    }
    return arms;
}

async function solidSkyboxArm(): Promise<PinnedBackgroundArm> {
    const solid = await pinnedFunctions(solidModule, [
        "buildSolidSkyboxRenderable",
        "createSkyboxBuffers",
    ]);
    const build = pinnedFunction(solid, "buildSolidSkyboxRenderable");
    const recorded = await recordArm(
        { vertex: "solid-skybox.vert", fragment: "solid-skybox.frag" },
        "src/material/pbr/background-solid-skybox.ts",
        "buildSolidSkyboxRenderable",
        async (engine) =>
            await build(
                sceneFor(engine),
                environmentTextures(engine._device),
                skyHalfSize,
                rootPosition,
                primaryColor,
            ),
    );
    return finishArm(
        "solidSkybox",
        recorded,
        pinnedFunction(solid, "createSkyboxBuffers")(
            bufferEngine("createSkyboxBuffers"),
            skyHalfSize,
        ),
        "createSkyboxBuffers",
    );
}

async function imageSkyboxArm(): Promise<PinnedBackgroundArm> {
    const loader = pinnedFunction(
        await pinnedFunctions(
            imageLoaderModule,
            ["loadSkybox"],
            new Map([["../texture/cube-texture.js", cubeTextureShim]]),
        ),
        "loadSkybox",
    );
    const createBoxData = pinnedFunction(
        await pinnedFunctions(boxModule, ["createBoxData"]),
        "createBoxData",
    );
    const recordings: RecordedArm[] = [];
    for (const size of imageSkyboxSizes) {
        recordings.push(
            await recordArm(
                {
                    vertex: "skybox-cubemap.vert",
                    fragment: "skybox-cubemap.frag",
                },
                "src/loader-skybox/load-skybox.ts",
                "loadSkybox",
                async (engine) => {
                    const scene = sceneFor(engine);
                    await loader(scene, "unit", ".png", size);
                    const renderables = scene._renderables;
                    if (
                        !Array.isArray(renderables) ||
                        renderables.length !== 1
                    ) {
                        refuse(
                            "loadSkybox",
                            "no longer registers one renderable",
                        );
                    }
                    const renderable: unknown = renderables[0];
                    return renderable;
                },
            ),
        );
    }
    // The loader writes its world block from constants: the same bytes at
    // every size, which is what lets the block ship as the pin wrote it.
    const [first, second] = recordings;
    if (!sameBytes(first!.meshBlock, second!.meshBlock)) {
        refuse("loadSkybox", "writes a world block that depends on its size");
    }
    const floats = new Float32Array(
        first!.meshBlock.buffer,
        first!.meshBlock.byteOffset,
        first!.meshBlock.byteLength / 4,
    );
    return {
        ...finishArm(
            "imageSkybox",
            first!,
            createBoxData(imageSkyboxSizes[0]),
            "createBoxData",
        ),
        constantMeshBlock: [...floats],
    };
}

export async function composePinnedBackgroundModules(
    reach: PinnedBackgroundReach,
): Promise<PinnedBackgroundArm[]> {
    return [
        ...(reach.ground ? await groundArms() : []),
        ...(reach.skybox ? await skyboxArms(reach.ddsEnvironment) : []),
        ...(reach.solidSkybox ? [await solidSkyboxArm()] : []),
        ...(reach.imageSkybox ? [await imageSkyboxArm()] : []),
    ];
}
