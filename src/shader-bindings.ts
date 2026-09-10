/** SDL binding adaptation of Tint's HLSL; Babylon shader expressions stay intact. */
interface Register {
    kind: string;
    index: number;
    space: number;
}

function registerKey(register: Register): string {
    return `${register.kind}:${register.space}:${register.index}`;
}

/** Integer textures cannot be sampled; SDL binds their Load() SRVs separately. */
function integerTextureRegisters(source: string): Set<string> {
    return new Set([...source.matchAll(/Texture\w*<\s*(?:uint|int)\d?\s*>\s+\w+\s*:\s*register\(t(\d+)(?:, space(\d+))?/g)]
        .map(match => registerKey({ kind: "t", index: Number(match[1]), space: Number(match[2] ?? 0) })));
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
    const integerTextures = integerTextureRegisters(source);
    const resourceOrder = (register: Register): number => storage.has(registerKey(register)) ? 2
        : integerTextures.has(registerKey(register)) ? 1 : 0;
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
    const integerTextures = integerTextureRegisters(hlsl);
    for (const match of hlsl.matchAll(/Texture\w*(?:<[^>]+>)?\s+\w+\s*:\s*register\(t(\d+)(?:, space(\d+))?/g)) {
        const space = Number(match[2] ?? 0);
        texturesBySpace.set(space, 1 + (texturesBySpace.get(space) ?? 0));
        if (!integerTextures.has(registerKey({ kind: "t", index: Number(match[1]), space }))) {
            sampledBySpace.set(space, 1 + (sampledBySpace.get(space) ?? 0));
        }
    }
    const slots: ShaderSlot[] = [];
    for (const match of hlsl.matchAll(/(?:cbuffer\s+cbuffer_(\w+)|(?:Texture\w*(?:<[^>]+>)?|Sampler\w*State)\s+(\w+)|(?:RW)?(?:ByteAddress|Structured)Buffer(?:<[^>]+>)?\s+(\w+))\s*:\s*register\(([tsb])(\d+)(?:, space(\d+))?/g)) {
        const storage = match[3] !== undefined;
        const space = Number(match[6] ?? 0);
        const integer = match[4] === "t" && integerTextures.has(registerKey({ kind: "t", index: Number(match[5]), space }));
        slots.push({
            kind: storage ? "r" : integer ? "i" : match[4]!,
            index: Number(match[5]) - (storage ? (texturesBySpace.get(space) ?? 0)
                : integer ? (sampledBySpace.get(space) ?? 0) : 0),
            name: (match[1] ?? match[3] ?? match[2])!,
        });
    }
    return slots.sort((left, right) => left.kind.localeCompare(right.kind) || left.index - right.index);
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
