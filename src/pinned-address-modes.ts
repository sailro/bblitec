import ts from "typescript";
import { floatLiteral } from "./cpp-literals.js";
import { LoweringContext } from "./lowering/context.js";
import { sharedUpstreamStore } from "./upstream-source.js";

const texture2DModule = "src/texture/texture-2d.ts";

/**
 * The pin's WebGPU address-mode spellings, as this runtime's enumerators.
 *
 * Shared because every loader that reads a sampler needs the same three
 * rows: the glTF sampler wrap modes, the `.babylon` loader's, and the
 * `textureOptions` a sprite atlas spreads over its defaults. A mode the pin
 * starts using that has no row here fails generation naming it, rather than
 * silently picking a neighbour.
 */
export const addressModeByPin: Readonly<Record<string, string>> = {
    "clamp-to-edge": "TextureAddressMode::clamp",
    "mirror-repeat": "TextureAddressMode::mirror",
    repeat: "TextureAddressMode::repeat",
};

/**
 * The pin's filter names, as the runtime enumerators. Same rule as the
 * address modes: a filter the pin starts using that has no row here fails
 * generation naming it.
 */
export const textureFilterByPin: Readonly<Record<string, string>> = {
    nearest: "TextureFilter::nearest",
    linear: "TextureFilter::linear",
};

export const pixelsTexture2DOptionFields: readonly string[] = [
    "addressModeU",
    "addressModeV",
    "magFilter",
    "minFilter",
    "srgb",
];

/**
 * The `PixelsTextureOptions` a `createTexture2DFromPixels` call named, as
 * the native aggregate.
 *
 * Two places write it — the call site, and the generated node-particle atlas
 * builder that rebuilds the same call against its own engine parameter — so
 * the mapping from the pin's own literals to this runtime's enumerators
 * lives here once. A literal with no row fails naming it, rather than
 * silently picking a neighbour.
 */
export function pixelsTextureOptionsCpp(
    named: Readonly<Record<string, string>>,
    fail: (message: string) => never,
): string {
    if (Object.keys(named).length === 0) return "";
    const field = (
        name: string,
        table: Readonly<Record<string, string>>,
    ): string => {
        const literal = named[name];
        if (literal === undefined) return "{}, false";
        const mapped = table[literal];
        if (!mapped) {
            fail(
                `createTexture2DFromPixels ${name} '${literal}' is not one ` +
                    `of the pinned literals: ${Object.keys(table).join(", ")}.`,
            );
        }
        return `bbl::${mapped}, true`;
    };
    const srgb = named.srgb ?? "false";
    if (srgb !== "true" && srgb !== "false") {
        fail(
            `createTexture2DFromPixels srgb '${srgb}' is not a boolean literal.`,
        );
    }
    return (
        `bbl::PixelsTextureOptions{${field("minFilter", textureFilterByPin)}, ` +
        `${field("magFilter", textureFilterByPin)}, ` +
        `${field("addressModeU", addressModeByPin)}, ` +
        `${field("addressModeV", addressModeByPin)}, ${srgb}}`
    );
}

export const mipmapModeByPin: Readonly<Record<string, string>> = {
    nearest: "TextureMipmapMode::nearest",
    linear: "TextureMipmapMode::linear",
};

/** `Texture2DOptions`' own defaults, keyed by the option's pinned name. */
export interface LoadTexture2DDefaults {
    minFilter: string;
    magFilter: string;
    mipMaps: boolean;
    invertY: boolean;
    srgb: boolean;
    premultiplyAlpha: boolean;
    addressModeU: string;
    addressModeV: string;
}

/** The option names, as a call site's own property names are tested against them. */
export const loadTexture2DOptionFields: readonly string[] = [
    "minFilter",
    "magFilter",
    "mipMaps",
    "invertY",
    "srgb",
    "premultiplyAlpha",
    "addressModeU",
    "addressModeV",
] satisfies readonly (keyof LoadTexture2DDefaults)[];

/**
 * What `loadTexture2DImpl` (src/texture/texture-2d.ts) decides about a
 * sampler, read off its own body: every option's `??` default, the mip
 * filter each `mipMaps` arm names, and the anisotropy each `allLinear` arm
 * names.
 */
interface PinnedTexture2DRules {
    defaults: LoadTexture2DDefaults;
    /** `const mipF = mipMaps ? "linear" : "nearest"`, both arms. */
    mipFilter: { withMips: string; withoutMips: string };
    /** `maxAnisotropy: allLinear ? 4 : 1`, both arms. */
    anisotropy: { allLinear: number; otherwise: number };
}

let pinnedRules: PinnedTexture2DRules | undefined;

/** The rules, read once per process from the shared pinned source. */
function pinnedTexture2DRules(): PinnedTexture2DRules {
    pinnedRules ??= readPinnedTexture2DRules(
        new LoweringContext(sharedUpstreamStore()),
    );
    return pinnedRules;
}

/**
 * The defaults and the two sampler rules, from the pinned declarations.
 *
 * `loadTexture2D` states each default twice -- in the cache key it builds
 * and in `loadTexture2DImpl`'s own reads -- as `opts.<name> ?? <literal>`.
 * Every occurrence of a name is read and they must agree, so a pin that
 * moves one default without the other fails here rather than leaving this
 * port resolving calls against half of it. The mip filter and the
 * anisotropy are conditionals over `mipMaps` and `allLinear`; the arms
 * are read, and the `allLinear` test itself is asserted to be the pin's
 * three-way `"linear"` comparison, which is what `loadTexture2DSamplerCpp`
 * restates.
 */
function readPinnedTexture2DRules(
    context: LoweringContext,
): PinnedTexture2DRules {
    const file = context.sourceFile(texture2DModule);
    const { declaration: impl } = context.functionDeclaration(
        texture2DModule,
        "loadTexture2DImpl",
    );
    const coalesced = context.findNodes(
        file,
        (node): node is ts.BinaryExpression & {
            left: ts.PropertyAccessExpression;
        } =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
            ts.isPropertyAccessExpression(node.left) &&
            ts.isIdentifier(node.left.expression) &&
            node.left.expression.text === "opts",
    );
    const literalOf = (expression: ts.Expression): string | boolean => {
        const node = context.unwrapExpression(expression);
        if (ts.isStringLiteral(node)) return node.text;
        if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
        return context.contractError(
            node,
            "Expected a literal Texture2DOptions default.",
        );
    };
    const defaultOf = (field: keyof LoadTexture2DDefaults): string | boolean => {
        const values = coalesced
            .filter((node) => node.left.name.text === field)
            .map((node) => literalOf(node.right));
        const first = values[0];
        if (first === undefined || values.some((value) => value !== first)) {
            return context.contractError(
                impl,
                `Expected loadTexture2D to default '${field}' to one literal.`,
            );
        }
        return first;
    };
    const stringDefault = (field: keyof LoadTexture2DDefaults): string => {
        const value = defaultOf(field);
        return typeof value === "string"
            ? value
            : context.contractError(
                  impl,
                  `Expected loadTexture2D to default '${field}' to a string.`,
              );
    };
    const booleanDefault = (field: keyof LoadTexture2DDefaults): boolean => {
        const value = defaultOf(field);
        return typeof value === "boolean"
            ? value
            : context.contractError(
                  impl,
                  `Expected loadTexture2D to default '${field}' to a boolean.`,
              );
    };
    const local = (name: string): ts.Expression => {
        const declarations = context.findNodes(
            impl,
            (node): node is ts.VariableDeclaration & {
                initializer: ts.Expression;
            } =>
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === name &&
                node.initializer !== undefined,
        );
        const found = declarations[0];
        return declarations.length === 1 && found
            ? found.initializer
            : context.contractError(
                  impl,
                  `Expected loadTexture2DImpl to bind '${name}' once.`,
              );
    };
    const arms = (
        expression: ts.Expression,
        condition: string,
        label: string,
    ): { whenTrue: ts.Expression; whenFalse: ts.Expression } => {
        const node = context.unwrapExpression(expression);
        if (
            !ts.isConditionalExpression(node) ||
            context.unwrapExpression(node.condition).getText(file) !==
                condition
        ) {
            return context.contractError(
                node,
                `Expected ${label} to select on '${condition}'.`,
            );
        }
        return { whenTrue: node.whenTrue, whenFalse: node.whenFalse };
    };
    const stringArm = (expression: ts.Expression): string => {
        const value = literalOf(expression);
        return typeof value === "string"
            ? value
            : context.contractError(expression, "Expected a filter name.");
    };
    const mipFilter = arms(local("mipF"), "mipMaps", "the mip filter");
    context.assertExpressionShape(
        local("allLinear"),
        'minF === "linear" && magF === "linear" && mipF === "linear"',
        "loadTexture2D's allLinear test",
    );
    const anisotropies = context.findNodes(
        impl,
        (node): node is ts.PropertyAssignment =>
            ts.isPropertyAssignment(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "maxAnisotropy",
    );
    const anisotropy = anisotropies[0];
    if (anisotropies.length !== 1 || !anisotropy) {
        return context.contractError(
            impl,
            "Expected loadTexture2DImpl to set maxAnisotropy once.",
        );
    }
    const anisotropyArms = arms(
        anisotropy.initializer,
        "allLinear",
        "the anisotropy",
    );
    return {
        defaults: {
            minFilter: stringDefault("minFilter"),
            magFilter: stringDefault("magFilter"),
            mipMaps: booleanDefault("mipMaps"),
            invertY: booleanDefault("invertY"),
            srgb: booleanDefault("srgb"),
            premultiplyAlpha: booleanDefault("premultiplyAlpha"),
            addressModeU: stringDefault("addressModeU"),
            addressModeV: stringDefault("addressModeV"),
        },
        mipFilter: {
            withMips: stringArm(mipFilter.whenTrue),
            withoutMips: stringArm(mipFilter.whenFalse),
        },
        anisotropy: {
            allLinear: context.numericValue(anisotropyArms.whenTrue, file),
            otherwise: context.numericValue(anisotropyArms.whenFalse, file),
        },
    };
}

/**
 * `Texture2DOptions`' own defaults (src/texture/texture-2d.ts), read off
 * the pinned reads on first use.
 *
 * Two producers resolve a `loadTexture2D` call against them — the call site,
 * reading an AST, and the generation-time browser texture bake, reading the
 * literals a recorded call passed — so the defaults are read once rather
 * than restated per reader.
 */
export const loadTexture2DDefaults: LoadTexture2DDefaults = {
    get minFilter(): string {
        return pinnedTexture2DRules().defaults.minFilter;
    },
    get magFilter(): string {
        return pinnedTexture2DRules().defaults.magFilter;
    },
    get mipMaps(): boolean {
        return pinnedTexture2DRules().defaults.mipMaps;
    },
    get invertY(): boolean {
        return pinnedTexture2DRules().defaults.invertY;
    },
    get srgb(): boolean {
        return pinnedTexture2DRules().defaults.srgb;
    },
    get premultiplyAlpha(): boolean {
        return pinnedTexture2DRules().defaults.premultiplyAlpha;
    },
    get addressModeU(): string {
        return pinnedTexture2DRules().defaults.addressModeU;
    },
    get addressModeV(): string {
        return pinnedTexture2DRules().defaults.addressModeV;
    },
};

/**
 * The `Texture2DOptions` a `loadTexture2D` call resolved, as the native
 * sampler aggregate.
 *
 * Two producers write it — the call site, and the generation-time browser
 * texture bake that replays a call the scene made against an object URL —
 * so the pin's own rules live here once. The one that is easy to restate
 * wrongly is the anisotropy: `maxAnisotropy: allLinear ? 4 : 1` folds the
 * mip filter (`mipMaps ? "linear" : "nearest"`) into its test, so turning
 * mips off turns anisotropy off with them; both arms of both conditionals
 * are the pin's, read by `readPinnedTexture2DRules`.
 *
 * The address modes arrive already spelled as native expressions because a
 * call site may name one conditionally; the filters arrive as the pin's own
 * literals so the anisotropy test can read them. The LOD clamp is the
 * native sampler's, not the pin's: WebGPU samples the whole chain a
 * `mipMaps` texture generated, and a texture without mips has one level,
 * which a zero clamp selects.
 */
export function loadTexture2DSamplerCpp(sampler: {
    minFilter: string;
    magFilter: string;
    mipMaps: boolean;
    addressModeUCpp: string;
    addressModeVCpp: string;
}): string {
    const { mipFilter, anisotropy } = pinnedTexture2DRules();
    const mipF = sampler.mipMaps ? mipFilter.withMips : mipFilter.withoutMips;
    const allLinear =
        sampler.minFilter === "linear" &&
        sampler.magFilter === "linear" &&
        mipF === "linear";
    const mipmapMode = mipmapModeByPin[mipF];
    if (!mipmapMode) {
        throw new Error(
            `loadTexture2D mip filter '${mipF}' is not one of the pinned ` +
                `literals: ${Object.keys(mipmapModeByPin).join(", ")}.`,
        );
    }
    return (
        `bbl::TextureSamplerState{` +
        `bbl::TextureFilter::${sampler.minFilter}, ` +
        `bbl::TextureFilter::${sampler.magFilter}, ` +
        `bbl::${mipmapMode}, ` +
        `${sampler.addressModeUCpp}, ` +
        `${sampler.addressModeVCpp}, ` +
        `${floatLiteral(allLinear ? anisotropy.allLinear : anisotropy.otherwise)}, ` +
        `${sampler.mipMaps ? "1000.0f" : "0.0f"}}`
    );
}

/** Everything `bbl::load_file_texture` takes past the path. */
export interface LoadTexture2DUpload {
    sampler: string;
    invertY: boolean;
    srgb: boolean;
    premultiplyAlpha: boolean;
}

/**
 * A `loadTexture2D` call whose every option is a settled literal, resolved
 * against the pin's defaults.
 *
 * This is the browser bake's reader: it holds what the call actually passed
 * rather than an AST, so unlike the call-site path it has no conditional
 * spelling to preserve and can map every field through the tables above. A
 * literal with no row fails naming it, the way every other sampler reader
 * here does.
 */
export function loadTexture2DUploadCpp(
    named: Readonly<Record<string, string>>,
    fail: (message: string) => never,
): LoadTexture2DUpload {
    const literal = (field: keyof typeof loadTexture2DDefaults): string =>
        named[field] ?? String(loadTexture2DDefaults[field]);
    const mapped = (
        field: "minFilter" | "magFilter" | "addressModeU" | "addressModeV",
        table: Readonly<Record<string, string>>,
    ): string => {
        const name = literal(field);
        if (!table[name]) {
            fail(
                `loadTexture2D ${field} '${name}' is not one of the pinned ` +
                    `literals: ${Object.keys(table).join(", ")}.`,
            );
        }
        return name;
    };
    const flag = (
        field: "mipMaps" | "invertY" | "srgb" | "premultiplyAlpha",
    ): boolean => {
        const name = literal(field);
        if (name !== "true" && name !== "false") {
            fail(`loadTexture2D ${field} '${name}' is not a boolean literal.`);
        }
        return name === "true";
    };
    const mipMaps = flag("mipMaps");
    return {
        sampler: loadTexture2DSamplerCpp({
            minFilter: mapped("minFilter", textureFilterByPin),
            magFilter: mapped("magFilter", textureFilterByPin),
            mipMaps,
            addressModeUCpp: `bbl::${
                addressModeByPin[mapped("addressModeU", addressModeByPin)]
            }`,
            addressModeVCpp: `bbl::${
                addressModeByPin[mapped("addressModeV", addressModeByPin)]
            }`,
        }),
        invertY: flag("invertY"),
        srgb: flag("srgb"),
        premultiplyAlpha: flag("premultiplyAlpha"),
    };
}
