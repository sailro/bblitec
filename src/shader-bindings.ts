/** SDL binding adaptation of Tint's HLSL; Babylon shader expressions stay intact. */
interface Register {
    kind: string;
    index: number;
    space: number;
}

function registerKey(register: Register): string {
    return `${register.kind}:${register.space}:${register.index}`;
}

/** Integer and multisampled textures use SDL storage-texture slots for Load(). */
function storageTextureRegisters(source: string): Set<string> {
    return new Set([...source.matchAll(/(Texture\w*)<\s*([^>]+)>\s+\w+\s*:\s*register\(t(\d+)(?:, space(\d+))?/g)]
        .filter(match => /MS(?:Array)?$/.test(match[1]!) || /^(?:uint|int)\d?$/.test(match[2]!.trim()))
        .map(match => registerKey({ kind: "t", index: Number(match[3]), space: Number(match[4] ?? 0) })));
}

function compactRegisters(source: string, vertex?: boolean): string {
    const pattern = vertex === undefined
        ? /register\(([tsbu])(\d+), space(\d+)\)/g
        : /register\(([tsbu])(\d+)(?:, space(\d+))?\)/g;
    const registers = new Map<string, Register>();
    for (const match of source.matchAll(pattern)) {
        const register = { kind: match[1]!, index: Number(match[2]), space: Number(match[3] ?? 0) };
        registers.set(registerKey(register), register);
    }
    const storage = new Set<string>();
    for (const match of source.matchAll(/(?:RW)?(?:ByteAddress|Structured)Buffer(?:<[^>]+>)?\s+\w+\s*:\s*register\(t(\d+)(?:, space(\d+))?\)/g)) {
        storage.add(registerKey({ kind: "t", index: Number(match[1]), space: Number(match[2] ?? 0) }));
    }
    const mapping = new Map<string, number>();
    const storageTextures = storageTextureRegisters(source);
    const resourceOrder = (register: Register): number => storage.has(registerKey(register)) ? 2
        : storageTextures.has(registerKey(register)) ? 1 : 0;
    for (const kind of ["b", "t", "s", "u"]) {
        const ordered = [...registers.values()].filter(register => register.kind === kind);
        ordered.sort((left, right) => {
            const storageOrder = kind === "t" ? resourceOrder(left) - resourceOrder(right) : 0;
            return (vertex === undefined ? left.space - right.space : 0) || storageOrder ||
                left.space - right.space || left.index - right.index;
        });
        let previousSpace: number | undefined;
        let index = 0;
        for (const register of ordered) {
            if (vertex === undefined && register.space !== previousSpace) index = 0;
            mapping.set(registerKey(register), index++);
            previousSpace = register.space;
        }
    }
    return source.replace(pattern, (_match, kind: string, index: string, space: string | undefined) => {
        const original = { kind, index: Number(index), space: Number(space ?? 0) };
        const mapped = mapping.get(registerKey(original));
        if (mapped === undefined) throw new Error(`Unmapped HLSL register ${registerKey(original)}.`);
        const target = vertex === undefined ? original.space : kind === "b" ? (vertex ? 1 : 3) : (vertex ? 0 : 2);
        return `register(${kind}${mapped}, space${target})`;
    });
}

export function remapPinnedVariantRegisters(source: string, vertex: boolean): string {
    return compactRegisters(source, vertex);
}

function mapSampledTextureUses(
    source: string,
    samplers: readonly string[],
    pair: (call: string, prefix: string, texture: string, sampler: string) => string,
): string {
    source = source.replace(/(\b(\w+)\.(?:Sample\w*|Gather\w*|CalculateLevelOfDetail\w*)\(\s*)(\w+)/g, pair);
    // Tint can pass a texture/sampler pair through an HLSL helper. Match
    // only sampler arguments so earlier arguments do not consume a texture.
    if (samplers.length) source = source.replace(new RegExp(`(\\b(\\w+)\\s*,\\s*)(${samplers.join("|")})\\b`, "g"), pair);
    return source;
}

/** SDL Vulkan binds texture/sampler pairs as combined image samplers at tN/sN.
 * Integer and multisampled Load textures use SDL's storage-texture descriptors.
 * DXC maps register spaces directly onto Vulkan descriptor sets. */
export function sdlSpirvSource(source: string, vertex: boolean): string {
    source = remapPinnedVariantRegisters(source, vertex);
    // Tint encodes WGSL locations in TEXCOORD indices. DXC otherwise assigns
    // consecutive Vulkan locations, breaking sparse vertex layouts and varyings.
    source = source.replace(
        /^(\s*)([^\r\n;{}]+:\s*TEXCOORD(\d+)\s*;)/gm,
        "$1[[vk::location($3)]] $2",
    );
    const storageTextures = storageTextureRegisters(source);
    const samplers = new Map([...source.matchAll(/(Sampler\w*State)\s+(\w+)\s*:\s*register\(s\d+, space\d+\)/g)]
        .map(match => [match[2]!, match[1]!]));
    const textures = new Map<string, { index: number; space: number; paired: string; used: Set<string> }>();
    // Float textureLoad paths still occupy SDL sampler-pair descriptors, even
    // when Tint eliminates the unused sampler. DXC requires both declarations
    // to form the combined type; the added sampler is never sampled.
    for (const match of source.matchAll(/Texture\w*(?:<[^>]+>)?\s+(\w+)\s*:\s*register\(t(\d+), space(\d+)\)/g)) {
        const texture = match[1]!, index = Number(match[2]), space = Number(match[3]);
        if (storageTextures.has(registerKey({ kind: "t", index, space }))) continue;
        textures.set(texture, { index, space, paired: `bblite_spirv_sampler_${space}_${index}`, used: new Set() });
    }
    const pair = (call: string, prefix: string, texture: string, sampler: string): string => {
        const binding = textures.get(texture);
        if (!binding) return call;
        binding.used.add(sampler);
        return `${prefix}${binding.paired}`;
    };
    // One HLSL sampler can serve several textures. Vulkan's combined
    // descriptors need a declaration and matching use for each texture.
    source = mapSampledTextureUses(source, [...samplers.keys()], pair);
    const pairedSamplers: string[] = [];
    for (const [texture, { index, space, paired, used }] of textures) {
        if (used.size > 1) throw new Error(`SDL Vulkan cannot bind multiple samplers for texture ${texture}.`);
        const sampler = [...used][0];
        if (sampler !== undefined && !samplers.has(sampler)) throw new Error(`Unknown HLSL sampler ${sampler} for texture ${texture}.`);
        pairedSamplers.push(`${sampler === undefined ? "SamplerState" : samplers.get(sampler)} ${paired} : register(s${index}, space${space});`);
    }
    source = pairedSamplers.join("\n") + "\n" + source.replace(/Sampler\w*State\s+\w+\s*:\s*register\(s\d+, space\d+\)\s*;/g, "");
    return source.replace(
        /(?:Texture\w*(?:<[^>]+>)?|Sampler\w*State)\s+\w+\s*:\s*register\(([ts])(\d+)(?:, space(\d+))?\)\s*;/g,
        (declaration: string, kind: string, index: string, space: string | undefined) => {
            if (kind === "t" && storageTextures.has(registerKey({ kind, index: Number(index), space: Number(space ?? 0) }))) {
                return declaration;
            }
            return `[[vk::combinedImageSampler]] ${declaration}`;
        },
    );
}

/** Position declarations and their aggregate values move together. */
export function normalizeTintHlslBindings(source: string): string {
    const positionIndices = new Map<string, number>();
    const normalized = compactRegisters(source).replace(
        /struct (\w+_(?:inputs|outputs)) \{\r?\n([\s\S]*?)\r?\n\};/g,
        (_match, name: string, body: string) => {
            const lines = body.split(/\r?\n/).filter(line => line.trim().length > 0);
            const position = (line: string): boolean => /:\s*SV_Position/.test(line);
            const system = (line: string): boolean => /:\s*SV_/.test(line);
            const index = lines.findIndex(position);
            if (index >= 0) positionIndices.set(name, index);
            const ordered = [
                ...lines.filter(position),
                ...lines.filter(line => !system(line)),
                ...lines.filter(line => system(line) && !position(line)),
            ];
            return `struct ${name} {\n${ordered.join("\n")}\n};`;
        },
    ).replace(
        /(\w+_outputs)(\s+\w+\s*=\s*\{)([^{}]*)(\};)/g,
        (match: string, name: string, lead: string, values: string, suffix: string) => {
            const index = positionIndices.get(name);
            const parts = values.split(",").map(value => value.trim());
            if (index === undefined || index >= parts.length) return match;
            return `${name}${lead}${[parts[index], ...parts.filter((_part, other) => other !== index)].join(", ")}${suffix}`;
        },
    );
    return normalized.replace(/\bdiscard;/g, "clip(-1.0f);");
}

export interface ShaderSlot {
    kind: string;
    index: number;
    name: string;
}

/** Storage slots follow the sampled-texture prefix within each register space. */
export function shaderStageSlots(hlsl: string): ShaderSlot[] {
    const sampledBySpace = new Map<number, number>();
    const texturesBySpace = new Map<number, number>();
    const storageTextures = storageTextureRegisters(hlsl);
    for (const match of hlsl.matchAll(/Texture\w*(?:<[^>]+>)?\s+\w+\s*:\s*register\(t(\d+)(?:, space(\d+))?/g)) {
        const space = Number(match[2] ?? 0);
        texturesBySpace.set(space, 1 + (texturesBySpace.get(space) ?? 0));
        if (!storageTextures.has(registerKey({ kind: "t", index: Number(match[1]), space }))) {
            sampledBySpace.set(space, 1 + (sampledBySpace.get(space) ?? 0));
        }
    }
    const slots: ShaderSlot[] = [];
    for (const match of hlsl.matchAll(/(?:cbuffer\s+cbuffer_(\w+)|(?:Texture\w*(?:<[^>]+>)?|Sampler\w*State)\s+(\w+)|(?:RW)?(?:ByteAddress|Structured)Buffer(?:<[^>]+>)?\s+(\w+))\s*:\s*register\(([tsb])(\d+)(?:, space(\d+))?/g)) {
        const storage = match[3] !== undefined;
        const space = Number(match[6] ?? 0);
        const storageTexture = match[4] === "t" && storageTextures.has(registerKey({ kind: "t", index: Number(match[5]), space }));
        slots.push({
            kind: storage ? "r" : storageTexture ? "i" : match[4]!,
            index: Number(match[5]) - (storage ? (texturesBySpace.get(space) ?? 0)
                : storageTexture ? (sampledBySpace.get(space) ?? 0) : 0),
            name: (match[1] ?? match[3] ?? match[2])!,
        });
    }
    return slots.sort((left, right) => left.kind.localeCompare(right.kind) || left.index - right.index);
}

/** Tint flattens Metal resources in use order. SDL requires the same dense
 * slots as our HLSL sidecar, with uniforms before storage in the buffer space. */
export function sdlMslSource(msl: string, hlsl: string, slots: readonly ShaderSlot[]): string {
    // Metal reserves `main`; Tint may rename it to a generated identifier.
    // Each artifact contains one stage, so give its exported function the
    // stable name used by the SDL loader, independently of WGSL naming.
    const entries = [...msl.matchAll(/^(vertex|fragment)\s+\w+\s+(\w+)\(/gm)];
    if (entries.length !== 1) throw new Error("Expected one Tint Metal render entry point.");
    if (entries[0]![2] !== "main0" && /\bmain0\b/.test(msl)) {
        throw new Error("Tint Metal source already uses the SDL entry-point name main0.");
    }
    msl = msl.replace(/^(vertex|fragment)(\s+\w+\s+)\w+\(/m, "$1$2main0(");
    const uniforms = slots.filter(slot => slot.kind === "b").length;
    const textures = slots.filter(slot => slot.kind === "t").length;
    const byName = new Map(slots.map(slot => [slot.name, slot]));
    // SDL binds samplers alongside textures. Tint may remove the sampler of
    // an earlier textureLoad, so independently compacted sampler slots drift.
    // A WGSL sampler shared by several textures needs only one Metal binding;
    // use its first texture slot, retaining the shared sampler in the shader.
    const samplerSlots = new Map<string, number>();
    mapSampledTextureUses(hlsl, slots.filter(slot => slot.kind === "s").map(slot => slot.name),
        (call, _prefix, texture, sampler) => {
            const slot = byName.get(texture);
            if (slot?.kind === "t" && byName.get(sampler)?.kind === "s") {
                samplerSlots.set(sampler, Math.min(samplerSlots.get(sampler) ?? slot.index, slot.index));
            }
            return call;
        });
    if (/\btint_storage_buffer_sizes\s*\[\[buffer\(30\)\]\]/.test(msl)) {
        // The pin tests the pointer's footprint, so even fixed-size storage
        // buffers occupy array-length entries, in resource-reference order
        // (also used by its original flattened Metal buffer indices).
        // The SDL Metal patch publishes lengths at buffer(30) in SDL slot order.
        const storage = [...msl.matchAll(/\b(\w+)\s*\[\[buffer\((\d+)\)\]\]/g)]
            .map(match => ({ name: match[1]!, index: Number(match[2]) }))
            .filter(binding => byName.get(binding.name)?.kind === "r")
            .sort((a, b) => a.index - b.index);
        let lengths = 0;
        msl = msl.replace(/(\(\*\w+\.tint_storage_buffer_sizes\))\[(\d+)u\]\.([xyzw])/g,
            (_load, pointer: string, vector: string, lane: string) => {
                const buffer = storage[Number(vector) * 4 + "xyzw".indexOf(lane)];
                if (!buffer) throw new Error("Metal array length has no reflected storage buffer.");
                const slot = byName.get(buffer.name)!.index;
                lengths++;
                return `${pointer}[${Math.floor(slot / 4)}u].${"xyzw"[slot % 4]}`;
            });
        if (!lengths) throw new Error("Unrecognized Tint Metal array-length expression.");
        const vectors = Math.ceil(slots.filter(slot => slot.kind === "r").length / 4);
        msl = msl.replace(/const constant tint_array<uint4, \d+>\* tint_storage_buffer_sizes/g,
            `const constant tint_array<uint4, ${vectors}>* tint_storage_buffer_sizes`);
    }
    return msl.replace(/\b(\w+)\s*\[\[(buffer|texture|sampler)\(\d+\)\]\]/g,
        (_declaration, name: string, kind: string) => {
            if (name === "tint_storage_buffer_sizes" && kind === "buffer") return `${name} [[buffer(30)]]`;
            const slot = byName.get(name);
            if (!slot) throw new Error(`Metal resource ${name} is absent from the SDL shader bindings.`);
            const expectedKind = slot.kind === "b" || slot.kind === "r" ? "buffer" : slot.kind === "s" ? "sampler" : "texture";
            if (kind !== expectedKind) throw new Error(`Metal resource ${name} has unexpected kind ${kind}.`);
            const index = slot.kind === "s" ? samplerSlots.get(name)
                : slot.index + (slot.kind === "r" ? uniforms : slot.kind === "i" ? textures : 0);
            if (index === undefined) throw new Error(`Metal sampler ${name} has no reflected texture pair.`);
            return `${name} [[${kind}(${index})]]`;
        });
}

export function hlslUniformBufferNames(hlsl: string): string[] {
    return [...hlsl.matchAll(/cbuffer\s+(\w+)\s*:\s*register\(b/g)].map(match => match[1]!);
}

export function assertUniformBufferCap(hlsl: string, stage: string): void {
    const names = hlslUniformBufferNames(hlsl);
    if (names.length > 4) {
        throw new Error(`${stage} binds ${names.length} uniform buffers (${names.join(", ")}); SDL_GPU caps a stage at 4.`);
    }
}

/** These read-only blocks retain their layout when moved from uniform to storage. */
export function demotableUniformBlocks(wgsl: string): string[] {
    const names = ["localProbeData", "gp", "nmeShadowParams"].filter(name =>
        new RegExp(`var\\s*<\\s*uniform\\s*>\\s*${name}\\s*:`).test(wgsl));
    for (const match of wgsl.matchAll(/var\s*<\s*uniform\s*>\s*((?:shadow|csm)Info_\d+)\s*:/g)) names.push(match[1]!);
    return names;
}

export function demoteUniformBlocks(wgsl: string, blocks: readonly string[]): string {
    return blocks.reduce((source, name) => source.replace(
        new RegExp(`var\\s*<\\s*uniform\\s*>\\s*${name}\\s*:`, "g"),
        `var<storage, read> ${name}:`,
    ), wgsl);
}

export interface SdlUniformAdaptation {
    source: string;
    required: boolean;
}

/** The local-probe block exceeds SDL's push limit independently of slot count. */
export function prepareSdlUniformAdaptation(wgsl: string): SdlUniformAdaptation | undefined {
    const blocks = demotableUniformBlocks(wgsl);
    return blocks.length === 0 ? undefined : {
        source: demoteUniformBlocks(wgsl, blocks),
        required: blocks.includes("localProbeData"),
    };
}

export function sdlUniformSource(plan: SdlUniformAdaptation | undefined, hlsl: string, stage: string): string | undefined {
    if (hlslUniformBufferNames(hlsl).length <= 4 && !plan?.required) return undefined;
    if (plan) return plan.source;
    assertUniformBufferCap(hlsl, stage);
    return undefined;
}

export function assertReflectedBindings(wgsl: string, reflection: string, source: string): void {
    const declared = new Set([...wgsl.matchAll(/@group\((\d+)u?\)\s*@binding\((\d+)u?\)/g)]
        .map(match => `${match[1]}:${match[2]}`));
    const undeclared = [...new Set([...reflection.matchAll(/\[(\d+)\]\[(\d+)\]/g)]
        .map(match => `${match[1]}:${match[2]}`))].filter(binding => !declared.has(binding));
    if (undeclared.length) throw new Error(`Tint reports binding(s) ${undeclared.join(", ")} that ${source} does not declare.`);
}
