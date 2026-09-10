import ts from "typescript";
import {isAssignmentExpression, isUpdateExpression} from "./compiler/syntax.js";
import {LoweringContext} from "./lowering/context.js";
import {pinnedModuleTextUrl} from "./pinned-shader-composer.js";
import {javascriptModuleUrl} from "./data-url.js";
import {transpileForBrowser} from "./typescript-transpile.js";
import {GltfGeometryPacker} from "./gltf-mesh-geometry.js";
import {asIndex, asObject, asRecords, areGltfIndices, type JsonObject} from "./gltf-document.js";
import type {RecordedMeshDeformation} from "./gltf-mesh-deformation.js";
import type {SourceAnimationBindings} from "./gltf-animation-bindings.js";
import {recordAnimationMaterialState, readAnimationMaterialState, type GltfAnimationMaterialState} from "./gltf-animation-material-state.js";

const pointerBridgeSource = `
const writers = new WeakMap();
const parsed = new WeakMap();
const terminals = new WeakMap();
let lookups = null;
export function recordWriter(site, fn, readCaptures, kind) {
    writers.set(fn, {site, readCaptures, kind});
    return fn;
}
export function writerCapture(fn) {
    const capture = writers.get(fn);
    if (!capture) throw new Error("Unrepresented source animation writer closure.");
    let lightLookups;
    if (capture.kind === "lookup") {
        const previous = lookups;
        lookups = [];
        try { fn(); lightLookups = lookups; } finally { lookups = previous; }
    }
    return {site: capture.site, values: capture.readCaptures(), lightLookups};
}
export function recordLightLookup(get, document, index) {
    lookups?.push({document, index});
    return get(document, index);
}
export function recordParser(fn) {
    return (...args) => {
        const result = fn(...args);
        const document = args[3];
        let events = parsed.get(document);
        if (!events) parsed.set(document, events = []);
        events.push({pointer: args[0], channel: args[1], result});
        return result;
    };
}
export function recordTerminalInputs(document, inputs) { terminals.set(document, inputs); }
export function consumeRecording(document) {
    const result = {events: parsed.get(document) ?? [], terminal: terminals.get(document)};
    parsed.delete(document);
    terminals.delete(document);
    return result;
}
`;

/** Value names declared by an enclosing callable, excluding names owned by this closure. */
function closureCaptures(arrow: ts.ArrowFunction): string[] {
    const declared = new Set<string>();
    const referenced = new Set<string>();
    const bindingNames = (name: ts.BindingName, into: Set<string>): void => {
        if (ts.isIdentifier(name)) into.add(name.text);
        else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, into);
    };
    arrow.parameters.forEach(parameter => bindingNames(parameter.name, declared));
    const scan = (node: ts.Node): void => {
        if (ts.isTypeNode(node)) return;
        if (ts.isVariableDeclaration(node)) {
            bindingNames(node.name, declared);
            if (node.initializer) scan(node.initializer);
            return;
        }
        if (ts.isPropertyAccessExpression(node)) { scan(node.expression); return; }
        if (ts.isPropertyAssignment(node)) {
            if (ts.isComputedPropertyName(node.name)) scan(node.name.expression);
            scan(node.initializer);
            return;
        }
        if (ts.isIdentifier(node)) { referenced.add(node.text); return; }
        ts.forEachChild(node, scan);
    };
    scan(arrow.body);
    const outer = new Set<string>();
    for (let scope: ts.Node | undefined = arrow.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) {
        if (!ts.isArrowFunction(scope) && !ts.isFunctionExpression(scope) && !ts.isFunctionDeclaration(scope)) continue;
        scope.parameters.forEach(parameter => bindingNames(parameter.name, outer));
        const local = (node: ts.Node): void => {
            if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) return;
            if (ts.isVariableDeclaration(node)) bindingNames(node.name, outer);
            ts.forEachChild(node, local);
        };
        if (scope.body) local(scope.body);
    }
    return [...referenced].filter(name => outer.has(name) && !declared.has(name)).sort();
}

export interface GltfPointerClosure {
    declaration: ts.ArrowFunction;
    site: string;
    captures: string[];
    kind: "lookup" | "writer";
}

/** One source closure inventory shared by execution receipts and native body lowering. */
export function gltfPointerClosures(context: LoweringContext, module: string): GltfPointerClosure[] {
    const file = context.sourceFile(module);
    return context.findNodes(file, (node): node is ts.ArrowFunction => ts.isArrowFunction(node)).flatMap(node => {
        const isWriter = ts.isPropertyAssignment(node.parent) && context.propertyName(node.parent.name) === "writer";
        const calls = context.findNodes(node.body, (child): child is ts.CallExpression => ts.isCallExpression(child));
        const isLookup = ts.isVariableDeclaration(node.parent) && calls.length === 1 &&
            context.expressionMatchesShape(calls[0]!.expression, "getGltfPunctualLight");
        if (!isWriter && !isLookup) return [];
        if (isLookup) {
            const effects = context.findNodes(node.body, (child): child is ts.Node => ts.isNewExpression(child) ||
                ts.isAwaitExpression(child) || isUpdateExpression(child) || isAssignmentExpression(child));
            if (effects.length) context.contractError(node, "The source light lookup helper must remain read-only.");
        }
        return [{declaration: node, site: `${module}:${node.getStart(file)}`, captures: closureCaptures(node), kind: isLookup ? "lookup" : "writer"}];
    });
}

function instrumentPointerWriters(context: LoweringContext, module: string, bridge: string,
    redirects: ReadonlyMap<string, string>): string {
    const file = context.sourceFile(module);
    const closures = new Map(gltfPointerClosures(context, module).map(closure => [closure.declaration, closure]));
    const transform = ts.transform(file, [visitorContext => root => {
        const visit: ts.Visitor = node => {
            const visited = ts.visitEachChild(node, visit, visitorContext);
            if (ts.isCallExpression(node) && ts.isCallExpression(visited) &&
                context.expressionMatchesShape(node.expression, "getGltfPunctualLight"))
                return ts.factory.createCallExpression(ts.factory.createIdentifier("__recordLightLookup"), undefined,
                    [visited.expression, ...visited.arguments]);
            if (!ts.isArrowFunction(node) || !ts.isArrowFunction(visited)) return visited;
            const closure = closures.get(node);
            if (!closure) return visited;
            const readCaptures = ts.factory.createArrowFunction(undefined, undefined, [], undefined,
                ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                ts.factory.createParenthesizedExpression(ts.factory.createObjectLiteralExpression(
                    closure.captures.map(name => ts.factory.createShorthandPropertyAssignment(name)))));
            return ts.factory.createCallExpression(ts.factory.createIdentifier("__recordWriter"), undefined,
                [ts.factory.createStringLiteral(closure.site), visited, readCaptures, ts.factory.createStringLiteral(closure.kind)]);
        };
        return ts.visitNode(root, visit, ts.isSourceFile)!;
    }]);
    const text = ts.createPrinter().printFile(transform.transformed[0]!);
    transform.dispose();
    return pinnedModuleTextUrl(module.replace(/^src\//, "").replace(/\.ts$/, ".js"),
        transpileForBrowser(`import {recordWriter as __recordWriter, recordLightLookup as __recordLightLookup} from ${JSON.stringify(bridge)};\n${text}`, module), [], redirects);
}

export interface GltfPointerSourceUrls {feature: string; converter: string; bridge: string}

/** Share this URL with the instrumented parse module before creating the pointer registry. */
export function gltfPointerBridgeUrl(): string { return javascriptModuleUrl(pointerBridgeSource); }

interface WriterCapture {site: string; values: Record<string, unknown>; lightLookups?: Array<{document: object; index: number}>}
interface WriterCaptureReader {writerCapture(writer: object): WriterCapture}
export type CaptureValue =
    | {kind: "undefined"}
    | {kind: "literal"; value: null | boolean | number | string}
    | {kind: "node"; index: number}
    | {kind: "material"; index: number; path: string[]}
    | {kind: "document"}
    | {kind: "context"}
    | {kind: "array"; values: CaptureValue[]}
    | {kind: "closure"; site: string; values: Record<string, CaptureValue>; lightLookups?: number[]};

interface SourceChannel {samplerIdx: number; nodeIdx: number; path: number; pointerArity?: number; pointerQuaternion?: boolean; pointerWriter?: object}
interface SourceClip {
    name: string; duration: number; channels: SourceChannel[];
    samplers: Array<{input: Float32Array; output: Float32Array; interpolation: number}>;
}
interface SourceNodeRest {parentIdx: number}
interface SourceTerminal extends ReturnType<SourceAnimationBindings["__animationBindings"]> {
    clips: SourceClip[]; nodes: SourceNodeRest[]; pointerChannelCount: number;
}
export interface SourceParse {
    parseAnimationData(document: JsonObject, bin: DataView, meshes: RecordedMeshDeformation[], parents: Map<number, number>,
        worlds: Map<number, Float32Array>, nodes: readonly (object | undefined)[]): {nodeNames: readonly (string | undefined)[]} | null;
}
export interface PointerBridge extends WriterCaptureReader {
    consumeRecording(document: object): {events: Array<{pointer: string; channel: object; result: SourceChannel | null}>; terminal?: SourceTerminal};
}
export interface SourceController {
    __controllerBindings(clip: SourceClip, nodes: SourceNodeRest[], skeletons: object[], morphBindings: object[],
        nodeTargets: readonly (object | undefined)[], excludedNodeIndices: Set<number>): {
            clipSkeletons: object[]; nodeTrsBindings: Array<{target: object; off: number; mask: number}>; requiresEngine: boolean;
            topoOrder: Int32Array; morphBindingsByNode: Array<object[] | undefined>;
            currentTRS: Float32Array; localMat: Float32Array; worldMat: Float32Array; pointerScratch: Float32Array;
        };
    __targetedAnimations(clip: SourceClip, nodeTargets: readonly (object | undefined)[], nodeNames: readonly (string | undefined)[]):
        Array<{target: object | undefined; targetName: string | undefined; nodeIndex: number | undefined; path: string}>;
}
export interface GltfAnimationReceipt {
    accepted: boolean;
    materialState: GltfAnimationMaterialState[];
    nodeNames: Array<string | null>;
    clips: Array<{
        name: string; duration: number;
        samplers: Array<{input: number; output: number; interpolation: number}>;
        channels: Array<{samplerIdx: number; nodeIdx: number; path: number; pointerArity?: number; pointerQuaternion?: boolean; writer?: CaptureValue}>;
        targetedAnimations: Array<{target?: number; targetName?: string; nodeIndex?: number; path: string}>;
        controller: {clipSkeletons: number[]; nodeTrsBindings: Array<{target: number; off: number; mask: number}>;
            requiresEngine: boolean; topoOrder: number[]; morphBindingsByNode: Array<number[] | null>;
            scratch: {trs: number; localMat: number; worldMat: number; pointer: number}};
    }>;
}

/** Reuse the source construction prefix; tick/mask/cached-engine closures are outside this boundary. */
export function gltfControllerBindingsSourceUrl(context: LoweringContext): string {
    const module = "src/skeleton/skeleton-updater.ts";
    const {file, declaration} = context.functionDeclaration(module, "createAnimationController");
    const statements = declaration.body!.statements;
    const end = statements.findIndex(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(
        value => ts.isIdentifier(value.name) && value.name.text === "cachedEngine"));
    if (end < 0) context.contractError(declaration, "Expected the source controller construction boundary before cachedEngine.");
    const groupsModule = "src/animation/animation-group.ts";
    const groups = context.functionDeclaration(groupsModule, "createAnimationGroups");
    const targets = context.findNodes(groups.declaration, (node): node is ts.PropertyAssignment =>
        ts.isPropertyAssignment(node) && context.propertyName(node.name) === "targetedAnimations");
    if (targets.length !== 1) context.contractError(groups.declaration, "Expected the source group's targeted animation construction.");
    const groupsSource = `${groups.file.text}\nexport function __targetedAnimations(clip, nodeTargets, nodeNames) {
        return ${targets[0]!.initializer.getText(groups.file)};
    }`;
    const groupsUrl = pinnedModuleTextUrl("animation/animation-group.js", transpileForBrowser(groupsSource, groupsModule));
    const source = `export {__targetedAnimations} from ${JSON.stringify(groupsUrl)};\n${file.text}\nexport function __controllerBindings(clip, nodes, skeletons, morphBindings, nodeTargets, excludedNodeIndices) {
        ${statements.slice(0, end).map(statement => statement.getText(file)).join("\n")}
        return {clipSkeletons, nodeTrsBindings, requiresEngine, topoOrder, morphBindingsByNode, currentTRS, localMat, worldMat, pointerScratch};
    }`;
    return pinnedModuleTextUrl("skeleton/skeleton-updater.js", transpileForBrowser(source, module));
}

/** Preserve the source clip/channel sequence and its per-controller binding identities. */
export function packageAnimationReceipt(source: SourceParse, bridge: PointerBridge, controller: SourceController,
    document: JsonObject, bin: DataView, meshes: Array<RecordedMeshDeformation & {material: object}>,
    parents: Map<number, number>, worlds: Map<number, Float32Array>, nodes: readonly (object | undefined)[],
    materialInputs: readonly object[], materialSlots: readonly number[], packer: GltfGeometryPacker,
    clearMaterialMap: (meshes: object[]) => void): {receipt: GltfAnimationReceipt; terminal: SourceTerminal | undefined} {
    // Source parse reads original resource owners while its materialMap sees the
    // constructed material input for the exact uploaded mesh's physical slot.
    const views = meshes.map((mesh, index) => new Proxy(mesh, {get(target, key, receiver) {
        if (key !== "material") return Reflect.get(target, key, receiver);
        const slot = materialSlots[index];
        if (slot === undefined || !materialInputs[slot]) throw new Error("Animation pointer lost its source material slot.");
        return materialInputs[slot];
    }}));
    const materialState = recordAnimationMaterialState(materialInputs);
    try {
        const result = source.parseAnimationData(document, bin, views, parents, worlds, nodes);
        const initializedMaterials = materialState();
        const {events, terminal} = bridge.consumeRecording(document);
        const sourceChannels = new Set(asRecords(document.animations).flatMap(clip => asRecords(clip.channels)));
        const pointerResults = new Set<SourceChannel>();
        for (const event of events) {
            if (!sourceChannels.has(event.channel as JsonObject)) throw new Error("Animation pointer lost its original source channel identity.");
            if (event.result) pointerResults.add(event.result);
        }
        if (!terminal) {
            if (result !== null) throw new Error("Source animation returned data before recording its terminal inputs.");
            return {receipt: {accepted: false, materialState: initializedMaterials, nodeNames: [], clips: []}, terminal};
        }
        if (result === null) return {receipt: {accepted: false, materialState: initializedMaterials, nodeNames: [], clips: []}, terminal};
        const encode = pointerCaptureEncoder(document, nodes, materialInputs, bridge);
        const nodeIndices = new Map(nodes.flatMap((node, index) => node ? [[node, index] as const] : []));
        const skeletonIndices = new Map(terminal.skeletons.map((binding, index) => [binding, index]));
        const morphIndices = new Map(terminal.morphBindings.map((binding, index) => [binding, index]));
        const requireIndex = (owners: ReadonlyMap<object, number>, owner: object, label: string): number => {
            const index = owners.get(owner);
            if (index === undefined) throw new Error(`Unrepresented source animation ${label} identity.`);
            return index;
        };
        const clips = terminal.clips.map(clip => {
            const construction = controller.__controllerBindings(clip, terminal.nodes, terminal.skeletons, terminal.morphBindings,
                terminal.nodeTargets, terminal.excludedNodeIndices);
            return {
                name: clip.name, duration: clip.duration,
                samplers: clip.samplers.map(sampler => ({input: packer.float32(sampler.input, 1),
                    output: packer.float32(sampler.output, 1), interpolation: sampler.interpolation})),
                channels: clip.channels.map(channel => {
                    if (channel.pointerWriter && !pointerResults.has(channel))
                        throw new Error("Unrepresented source pointer writer construction.");
                    return {samplerIdx: channel.samplerIdx, nodeIdx: channel.nodeIdx, path: channel.path,
                        ...(channel.pointerArity !== undefined ? {pointerArity: channel.pointerArity} : {}),
                        ...(channel.pointerQuaternion !== undefined ? {pointerQuaternion: channel.pointerQuaternion} : {}),
                        ...(channel.pointerWriter ? {writer: encode(channel.pointerWriter)} : {})};
                }),
                targetedAnimations: controller.__targetedAnimations(clip, terminal.nodeTargets, result.nodeNames).map(target => ({
                    ...(target.target !== undefined ? {target: requireIndex(nodeIndices, target.target, "group target")} : {}),
                    ...(target.targetName !== undefined ? {targetName: target.targetName} : {}),
                    ...(target.nodeIndex !== undefined ? {nodeIndex: target.nodeIndex} : {}),
                    path: target.path,
                })),
                controller: {
                    clipSkeletons: construction.clipSkeletons.map(binding => requireIndex(skeletonIndices, binding, "clip skeleton")),
                    nodeTrsBindings: construction.nodeTrsBindings.map(binding => ({target: requireIndex(nodeIndices, binding.target, "node TRS"),
                        off: binding.off, mask: binding.mask})),
                    requiresEngine: construction.requiresEngine,
                    topoOrder: [...construction.topoOrder],
                    morphBindingsByNode: Array.from(construction.morphBindingsByNode,
                        bindings => bindings ? bindings.map(binding => requireIndex(morphIndices, binding, "morph")) : null),
                    scratch: {trs: construction.currentTRS.length, localMat: construction.localMat.length,
                        worldMat: construction.worldMat.length, pointer: construction.pointerScratch.length},
                },
            };
        });
        return {receipt: {accepted: true, materialState: initializedMaterials, nodeNames: Array.from(result.nodeNames, name => name ?? null), clips}, terminal};
    } finally {
        bridge.consumeRecording(document);
        clearMaterialMap(views);
    }
}

/** Capture paths are found from the source objects after privateTexture has replaced wrappers. */
export function pointerCaptureEncoder(document: object, nodes: readonly (object | undefined)[],
    materials: readonly object[], reader: WriterCaptureReader): (writer: object) => CaptureValue {
    const nodeIndices = new Map(nodes.flatMap((node, index) => node ? [[node, index] as const] : []));
    const materialPaths = new Map<object, Array<{index: number; path: string[]}>>();
    const walk = (value: object, index: number, path: string[], ancestors: ReadonlySet<object>): void => {
        if (ancestors.has(value)) return;
        const paths = materialPaths.get(value) ?? [];
        paths.push({index, path}); materialPaths.set(value, paths);
        const next = new Set(ancestors); next.add(value);
        for (const [key, child] of Object.entries(value)) {
            if (child !== null && typeof child === "object") walk(child, index, [...path, key], next);
        }
    };
    materials.forEach((material, index) => walk(material, index, [], new Set()));
    const encode = (value: unknown): CaptureValue => {
        if (value === undefined) return {kind: "undefined"};
        if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
            return {kind: "literal", value};
        if (value === document) return {kind: "document"};
        if (typeof value === "function") {
            const capture = reader.writerCapture(value);
            const lightLookups = capture.lightLookups?.map(lookup => {
                if (lookup.document !== document || !Number.isSafeInteger(lookup.index) || lookup.index < 0)
                    throw new Error("Unrepresented source light lookup owner.");
                return lookup.index;
            });
            return {kind: "closure", site: capture.site,
                values: Object.fromEntries(Object.entries(capture.values).map(([key, item]) => [key, encode(item)])),
                ...(lightLookups ? {lightLookups} : {})};
        }
        if (typeof value !== "object") throw new Error("Unrepresented source pointer capture value.");
        const node = nodeIndices.get(value);
        if (node !== undefined) return {kind: "node", index: node};
        const owners = materialPaths.get(value);
        if (owners) {
            if (owners.length !== 1) throw new Error("Unrepresented shared source pointer material capture.");
            return {kind: "material", index: owners[0]!.index, path: owners[0]!.path};
        }
        if (Array.isArray(value)) return {kind: "array", values: Array.from(value, encode)};
        const context = value as Record<string, unknown>;
        if (context._json === document && context.nodes === nodes && Array.isArray(context.materials)) return {kind: "context"};
        throw new Error("Unrepresented source pointer capture identity.");
    };
    return writer => {
        if (typeof writer !== "function") throw new Error("Source pointer returned no writer function.");
        return encode(writer);
    };
}

/** Validate storage references without repeating source target selection or terminal gating. */
export function readAnimationReceipt(value: unknown, counts: {nodes: number; materials: number; accessors: number;
    skeletons: number; morphs: number}): GltfAnimationReceipt {
    const fail = (): never => { throw new Error("Invalid packaged glTF animation receipt."); };
    const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
    const ordinal = (value: unknown, count: number): value is number => asIndex(value) !== undefined && (value as number) < count;
    const capture = (value: unknown): CaptureValue => {
        const item = asObject(value);
        if (!item) return fail();
        if (item.kind === "undefined" || item.kind === "document" || item.kind === "context") return {kind: item.kind};
        if (item.kind === "literal" && (item.value === null || typeof item.value === "boolean" || typeof item.value === "string" ||
            (typeof item.value === "number" && Number.isFinite(item.value)))) return {kind: "literal", value: item.value};
        if (item.kind === "node" && ordinal(item.index, counts.nodes)) return {kind: "node", index: item.index};
        if (item.kind === "material" && ordinal(item.index, counts.materials) && Array.isArray(item.path) &&
            item.path.every((part): part is string => typeof part === "string")) return {kind: "material", index: item.index, path: item.path};
        if (item.kind === "array" && Array.isArray(item.values)) return {kind: "array", values: item.values.map(capture)};
        if (item.kind === "closure" && typeof item.site === "string" &&
            /^src\/loader-gltf\/animation-pointer(?:-ext|-lights)?\.ts:\d+$/.test(item.site)) {
            const values = asObject(item.values);
            if (!values || (item.lightLookups !== undefined && !areGltfIndices(item.lightLookups, Number.MAX_SAFE_INTEGER))) return fail();
            return {kind: "closure", site: item.site, values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, capture(value)])),
                ...(item.lightLookups !== undefined ? {lightLookups: item.lightLookups as number[]} : {})};
        }
        return fail();
    };
    const plan = asObject(value);
    if (!plan || typeof plan.accepted !== "boolean" || !Array.isArray(plan.clips) || !Array.isArray(plan.nodeNames) ||
        !plan.nodeNames.every(name => name === null || typeof name === "string") ||
        (!plan.accepted && (plan.clips.length !== 0 || plan.nodeNames.length !== 0))) return fail();
    const clips = plan.clips.map(value => {
        const clip = asObject(value), controller = asObject(clip?.controller), scratch = asObject(controller?.scratch);
        if (!clip || typeof clip.name !== "string" || typeof clip.duration !== "number" || !Number.isFinite(clip.duration) ||
            !Array.isArray(clip.samplers) || !Array.isArray(clip.channels) || !Array.isArray(clip.targetedAnimations) ||
            clip.targetedAnimations.length !== clip.channels.length || !controller || !scratch ||
            !areGltfIndices(controller.clipSkeletons, counts.skeletons) || !Array.isArray(controller.nodeTrsBindings) ||
            typeof controller.requiresEngine !== "boolean" || !areGltfIndices(controller.topoOrder, counts.nodes) ||
            !Array.isArray(controller.morphBindingsByNode) || !controller.morphBindingsByNode.every(bindings =>
                bindings === null || areGltfIndices(bindings, counts.morphs)) ||
            [scratch.trs, scratch.localMat, scratch.worldMat, scratch.pointer].some(value => asIndex(value) === undefined)) return fail();
        const samplers = clip.samplers.map(value => {
            const sampler = asObject(value);
            if (!sampler || !ordinal(sampler.input, counts.accessors) || !ordinal(sampler.output, counts.accessors) || !integer(sampler.interpolation)) return fail();
            return {input: sampler.input, output: sampler.output, interpolation: sampler.interpolation};
        });
        const channels = clip.channels.map(value => {
            const channel = asObject(value);
            if (!channel || !ordinal(channel.samplerIdx, samplers.length) || !integer(channel.nodeIdx) || !integer(channel.path) ||
                (channel.pointerArity !== undefined && asIndex(channel.pointerArity) === undefined) ||
                (channel.pointerQuaternion !== undefined && typeof channel.pointerQuaternion !== "boolean")) return fail();
            return {samplerIdx: channel.samplerIdx, nodeIdx: channel.nodeIdx, path: channel.path,
                ...(channel.pointerArity !== undefined ? {pointerArity: channel.pointerArity as number} : {}),
                ...(channel.pointerQuaternion !== undefined ? {pointerQuaternion: channel.pointerQuaternion} : {}),
                ...(channel.writer !== undefined ? {writer: capture(channel.writer)} : {})};
        });
        const targetedAnimations = clip.targetedAnimations.map(value => {
            const target = asObject(value);
            if (!target || typeof target.path !== "string" || (target.target !== undefined && !ordinal(target.target, counts.nodes)) ||
                (target.targetName !== undefined && typeof target.targetName !== "string") ||
                (target.nodeIndex !== undefined && asIndex(target.nodeIndex) === undefined)) return fail();
            return {path: target.path, ...(target.target !== undefined ? {target: target.target as number} : {}),
                ...(target.targetName !== undefined ? {targetName: target.targetName} : {}),
                ...(target.nodeIndex !== undefined ? {nodeIndex: target.nodeIndex as number} : {})};
        });
        const nodeTrsBindings = controller.nodeTrsBindings.map(value => {
            const binding = asObject(value);
            if (!binding || !ordinal(binding.target, counts.nodes) || asIndex(binding.off) === undefined || !integer(binding.mask)) return fail();
            return {target: binding.target, off: binding.off as number, mask: binding.mask};
        });
        return {name: clip.name, duration: clip.duration, samplers, channels, targetedAnimations,
            controller: {clipSkeletons: controller.clipSkeletons, nodeTrsBindings, requiresEngine: controller.requiresEngine,
                topoOrder: controller.topoOrder, morphBindingsByNode: controller.morphBindingsByNode as Array<number[] | null>,
                scratch: {trs: scratch.trs as number, localMat: scratch.localMat as number, worldMat: scratch.worldMat as number, pointer: scratch.pointer as number}}};
    });
    return {accepted: plan.accepted, materialState: readAnimationMaterialState(plan.materialState, counts.materials),
        nodeNames: plan.nodeNames as Array<string | null>, clips};
}

/** One isolated handler registry, with the recording loader's real animation and light owners. */
export function gltfPointerSourceUrls(context: LoweringContext, animation: string, lightState: string,
    bridge = gltfPointerBridgeUrl()): GltfPointerSourceUrls {
    const baseColorModule = "src/loader-gltf/animation-pointer-basecolor.ts";
    const baseColorFile = context.sourceFile(baseColorModule);
    context.variableInitializer(baseColorFile, "_animBaseColorDefs");
    const baseColor = pinnedModuleTextUrl("loader-gltf/animation-pointer-basecolor.js",
        transpileForBrowser(`${baseColorFile.text}\nexport function __baseColorDefinitions() { return _animBaseColorDefs; }`, baseColorModule));
    const base = instrumentPointerWriters(context, "src/loader-gltf/animation-pointer.ts", bridge, new Map());
    const ext = instrumentPointerWriters(context, "src/loader-gltf/animation-pointer-ext.ts", bridge,
        new Map([["./animation-pointer.js", base]]));
    const lights = instrumentPointerWriters(context, "src/loader-gltf/animation-pointer-lights.ts", bridge,
        new Map([["./animation-pointer.js", base], ["./gltf-light-pointer-state.js", lightState]]));
    const converterModule = "src/loader-gltf/gltf-sampler-denorm.ts";
    const converter = pinnedModuleTextUrl("loader-gltf/gltf-sampler-denorm.js",
        transpileForBrowser(context.sourceFile(converterModule).text, converterModule), [],
        new Map([["./gltf-animation.js", animation]]));
    const module = "src/loader-gltf/gltf-feature-animation-pointer.ts";
    const file = context.sourceFile(module);
    const installs = context.findNodes(file, (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "_installPointerHandlers"));
    if (installs.length !== 1 || installs[0]!.arguments.length !== 1 || !ts.isArrowFunction(installs[0]!.arguments[0]!))
        context.contractError(file, "Expected the source animation pointer parser installation.");
    const install = installs[0]!;
    const transform = ts.transform(file, [visitorContext => root => {
        const visit: ts.Visitor = node => node === install
            ? ts.factory.updateCallExpression(install, install.expression, install.typeArguments,
                [ts.factory.createCallExpression(ts.factory.createIdentifier("__recordParser"), undefined, [install.arguments[0]!])])
            : ts.visitEachChild(node, visit, visitorContext);
        return ts.visitNode(root, visit, ts.isSourceFile)!;
    }]);
    const text = ts.createPrinter().printFile(transform.transformed[0]!);
    transform.dispose();
    const cleanup = `function __clearPointerMaterialMap(meshes) {
        if (_matMapKey === meshes) { _matMapKey = null; _matMap = []; }
    }
    function __baseColorDefinitions() { return _baseColorMod?.__baseColorDefinitions(); }`;
    const feature = pinnedModuleTextUrl("loader-gltf/gltf-feature-animation-pointer.js",
        transpileForBrowser(`import {recordParser as __recordParser} from ${JSON.stringify(bridge)};\n${text}\n${cleanup}`, module),
        ["__clearPointerMaterialMap", "__baseColorDefinitions"], new Map([
            ["./gltf-animation.js", animation], ["./animation-pointer.js", base],
            ["./animation-pointer-ext.js", ext], ["./animation-pointer-lights.js", lights], ["./gltf-sampler-denorm.js", converter],
            ["./animation-pointer-basecolor.js", baseColor],
        ]));
    return {feature, converter, bridge};
}
