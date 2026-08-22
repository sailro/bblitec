/**
 * Lowers `stdUvTransformExt`'s own uniform writer to C++.
 *
 * `std-uv-transform-fragment.ts` fills one 8-float channel per Standard
 * texture slot: a 2x2 matrix carrying `uScale`/`vScale` and a rotation by
 * `uAng`, then a translation composed against the material's own
 * `uvScale`/`uvOffset`, then a `invertY` flip that negates the second matrix
 * row and mirrors the V translation. Every one of those is arithmetic, and a
 * second copy of it here would agree with the pin only until the pin edits a
 * sign — so the body comes from the pinned declaration's own AST.
 *
 * Two things are folded rather than lowered, both because their *shape* is
 * the contract and generation already knows the answer:
 *
 * - the `CHANNELS` table, read out of the pinned module and unrolled into
 *   seven calls, because the pin's own loop bound is `CHANNELS.length` and
 *   each entry names a fixed slot;
 * - `legacyFlipV`'s first conjunct (`textureKey === "_lightmapTexture"`),
 *   which is a per-channel constant in that same table.
 *
 * The values stay live: the emitted writer reads the material record every
 * time it runs, so a scene that moves a texture's transform moves the block.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";

/** The module the extension and both its writers live in. */
const MODULE = "src/material/standard/fragments/std-uv-transform-fragment.ts";

/** One row of the pinned `CHANNELS` table. */
interface PinnedChannel {
    /** The WGSL field prefix (`d`, `e`, `b`, ...). */
    name: string;
    /** The material property the pin reads the texture from. */
    textureKey: string;
    /** The material property carrying the UV set, or null. */
    coordIndexKey: string | null;
}

/**
 * Where this port keeps each channel's texture and coordinate index.
 *
 * The Standard record splits the pin's one `Texture2D` per slot into a
 * `TextureData` member, so a channel names the member rather than a
 * property; a slot the generated loader never fills is `null` and its
 * channel writes the untextured identity, which is what the pin's own
 * `texture?.x ?? default` reads produce for an absent texture.
 */
const channelRecordSources: Readonly<
    Record<string, { texture: string | null; coordIndex: string | null }>
> = {
    _diffuseTexture: {
        texture: "material.base_color_texture",
        coordIndex: "material.diffuse_coord_index",
    },
    diffuseTexture: {
        texture: "material.base_color_texture",
        coordIndex: "material.diffuse_coord_index",
    },
    _emissiveTexture: { texture: null, coordIndex: null },
    _bumpTexture: { texture: "material.bump_texture", coordIndex: null },
    _specularTexture: {
        texture: "material.specular_texture",
        coordIndex: "material.specular_coord_index",
    },
    _ambientTexture: {
        texture: "material.ambient_texture",
        coordIndex: "material.ambient_coord_index",
    },
    _lightmapTexture: { texture: null, coordIndex: null },
    _opacityTexture: { texture: "material.opacity_texture", coordIndex: null },
};

/** The pinned `Texture2D` properties, as this port's record spells them. */
const texturePropertySources: Readonly<Record<string, string>> = {
    uScale: "uv_transform.u_scale",
    vScale: "uv_transform.v_scale",
    uOffset: "uv_transform.u_offset",
    vOffset: "uv_transform.v_offset",
    uAng: "uv_transform.u_ang",
    invertY: "uv_invert_y",
};

/** The writer's parameters, as the emitted C++ names them. */
const parameterNames: Readonly<Record<string, string>> = {
    data: "data",
    channel: "channel",
    texture: "texture",
    material: "material",
    materialOffsetX: "material_offset_x",
    materialOffsetY: "material_offset_y",
    usesUv2: "uses_uv2",
    legacyFlipV: "legacy_flip_v",
};

function moduleConstant(
    context: LoweringContext,
    name: string,
): number {
    const initializer = context.variableInitializer(
        context.sourceFile(MODULE).statements.find(
            (statement): statement is ts.VariableStatement =>
                ts.isVariableStatement(statement) &&
                statement.declarationList.declarations.some(
                    (declaration) =>
                        ts.isIdentifier(declaration.name) &&
                        declaration.name.text === name,
                ),
        )!,
        name,
    );
    return context.numericValue(initializer, context.sourceFile(MODULE));
}

/** The pinned `CHANNELS` table, read out of its own declaration. */
function pinnedChannels(context: LoweringContext): PinnedChannel[] {
    const file = context.sourceFile(MODULE);
    const statement = file.statements.find(
        (candidate): candidate is ts.VariableStatement =>
            ts.isVariableStatement(candidate) &&
            candidate.declarationList.declarations.some(
                (declaration) =>
                    ts.isIdentifier(declaration.name) &&
                    declaration.name.text === "CHANNELS",
            ),
    );
    if (!statement) {
        throw new Error(`Pinned ${MODULE} no longer declares CHANNELS.`);
    }
    const initializer = context.unwrapExpression(
        context.variableInitializer(statement, "CHANNELS"),
    );
    if (!ts.isArrayLiteralExpression(initializer)) {
        throw new Error(
            `Pinned CHANNELS is no longer an array literal.`,
        );
    }
    return initializer.elements.map((element) => {
        const row = context.unwrapExpression(element);
        if (!ts.isArrayLiteralExpression(row) || row.elements.length !== 5) {
            throw new Error(
                "Pinned CHANNELS rows are no longer " +
                    "[name, feature, uv2, textureKey, coordIndexKey].",
            );
        }
        const literal = (index: number): string | null => {
            const value = context.unwrapExpression(row.elements[index]!);
            if (ts.isStringLiteral(value)) return value.text;
            if (value.kind === ts.SyntaxKind.NullKeyword) return null;
            throw new Error(
                `Pinned CHANNELS element ${index} is neither a string nor ` +
                    "null.",
            );
        };
        const name = literal(0);
        const textureKey = literal(3);
        if (name === null || textureKey === null) {
            throw new Error("Pinned CHANNELS row has no name or slot.");
        }
        return { name, textureKey, coordIndexKey: literal(4) };
    });
}

/** Per-channel constants the unrolled call sites need. */
interface ChannelEmit {
    /** `const TextureData*` expression, or `nullptr`. */
    texture: string;
    /** The `usesUv2` argument. */
    usesUv2: string;
    /** The `legacyFlipV` argument. */
    legacyFlipV: string;
}

function channelArguments(
    channel: PinnedChannel,
    lightmapKey: string,
): ChannelEmit {
    const sources = channelRecordSources[channel.textureKey];
    if (!sources) {
        throw new Error(
            `Pinned CHANNELS names slot '${channel.textureKey}', which has ` +
                "no record source in this port.",
        );
    }
    const texture = sources.texture === null
        ? "nullptr"
        : `${sources.texture}.bytes.empty() ? nullptr : &${sources.texture}`;
    // `coordIndexKey !== null && material[coordIndexKey] === 1`: the first
    // conjunct is the table's own answer, so a channel with no coordinate
    // index folds to false exactly as the pin's `&&` does.
    const usesUv2 = channel.coordIndexKey === null || !sources.coordIndex
        ? "false"
        : `${sources.coordIndex} == 1`;
    // `textureKey === "_lightmapTexture" && texture?.uAng === Math.PI`: the
    // generated loader fills no lightmap slot, so the whole conjunction is
    // the table's constant false. A port that grows the slot has to grow
    // this with it, which is why the key is compared rather than assumed.
    const legacyFlipV = channel.textureKey === lightmapKey &&
            sources.texture !== null
        ? `${sources.texture}.uv_transform.u_ang == ` +
            "static_cast<float>(3.141592653589793)"
        : "false";
    return { texture, usesUv2, legacyFlipV };
}

interface EmitState {
    file: ts.SourceFile;
    context: LoweringContext;
    /** Locals bound in the pinned body, by their C++ name. */
    locals: Map<string, string>;
    constants: Readonly<Record<string, number>>;
}

/**
 * One `texture?.<property>` read, with the value an absent texture produces.
 *
 * The pin reads through an optional chain and resolves the `undefined` with
 * either a `??` arm or a coercion; this port's record has no absent state, so
 * the null test is spelled and the pin's own resolution is the else arm.
 */
function emitOptionalTextureRead(
    state: EmitState,
    access: ts.PropertyAccessExpression,
    absent: string,
): string {
    const property = access.name.text;
    const source = texturePropertySources[property];
    if (!source) {
        throw new Error(
            `Pinned UV transform writer reads texture.${property}, which ` +
                "has no record source.",
        );
    }
    void state;
    return `(texture ? texture->${source} : ${absent})`;
}

function emitExpression(state: EmitState, node: ts.Expression): string {
    const expression = state.context.unwrapExpression(node);
    if (ts.isNumericLiteral(expression)) {
        return state.context.doubleLiteral(Number(expression.text));
    }
    if (ts.isIdentifier(expression)) {
        const local = state.locals.get(expression.text);
        if (local) return local;
        const parameter = parameterNames[expression.text];
        if (parameter) return parameter;
        const constant = state.constants[expression.text];
        if (constant !== undefined) {
            return state.context.doubleLiteral(constant);
        }
        throw new Error(
            `Pinned UV transform writer reads unknown '${expression.text}'.`,
        );
    }
    if (ts.isPrefixUnaryExpression(expression)) {
        const operand = emitExpression(state, expression.operand);
        if (expression.operator === ts.SyntaxKind.MinusToken) {
            return `-(${operand})`;
        }
        if (expression.operator === ts.SyntaxKind.ExclamationToken) {
            return `!(${operand})`;
        }
        throw new Error(
            "Pinned UV transform writer uses an unsupported unary operator.",
        );
    }
    if (ts.isConditionalExpression(expression)) {
        return `(${emitExpression(state, expression.condition)} ? ` +
            `${emitExpression(state, expression.whenTrue)} : ` +
            `${emitExpression(state, expression.whenFalse)})`;
    }
    if (ts.isCallExpression(expression)) {
        const callee = state.context.unwrapExpression(expression.expression);
        if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "Math"
        ) {
            const name = callee.name.text;
            if (name !== "cos" && name !== "sin") {
                throw new Error(
                    `Pinned UV transform writer calls Math.${name}, which ` +
                        "is not lowered.",
                );
            }
            return `std::${name}(${
                emitExpression(state, expression.arguments[0]!)
            })`;
        }
        throw new Error("Pinned UV transform writer makes an unknown call.");
    }
    if (ts.isElementAccessExpression(expression)) {
        // `data[offset + n]` and `material.uvScale[0]`. A literal index is
        // already an integer; a computed one rides the float `offset` the
        // pin binds, whose values are small and exact.
        const target = emitExpression(state, expression.expression);
        const argument = state.context.unwrapExpression(
            expression.argumentExpression,
        );
        if (ts.isNumericLiteral(argument)) {
            return `${target}[${Number(argument.text)}]`;
        }
        const index = emitExpression(state, argument);
        return `${target}[static_cast<std::size_t>(${index})]`;
    }
    if (ts.isPropertyAccessExpression(expression)) {
        const target = state.context.unwrapExpression(expression.expression);
        const property = expression.name.text;
        if (ts.isIdentifier(target) && target.text === "material") {
            if (property === "uvScale") return "material.uv_scale";
            throw new Error(
                `Pinned UV transform writer reads material.${property}, ` +
                    "which has no record source.",
            );
        }
        if (ts.isIdentifier(target) && target.text === "texture") {
            // `texture?.x` with no `??` beside it: JavaScript reads
            // `undefined`, which the pin then coerces (`!!texture?.invertY`).
            // The record has no absent state, so the fallback is spelled.
            return emitOptionalTextureRead(
                state,
                expression,
                property === "invertY" ? "false" : "0.0",
            );
        }
        if (
            ts.isIdentifier(target) &&
            target.text === "Math" &&
            property === "PI"
        ) {
            return "static_cast<float>(3.141592653589793)";
        }
        throw new Error(
            `Pinned UV transform writer reads an unmapped property ` +
                `'${expression.getText(state.file)}'.`,
        );
    }
    if (ts.isBinaryExpression(expression)) {
        const operator = expression.operatorToken.kind;
        // `texture?.uScale ?? 1` — the record always carries a value, so the
        // fallback is what an absent texture produces, exactly as upstream.
        if (operator === ts.SyntaxKind.QuestionQuestionToken) {
            const left = state.context.unwrapExpression(expression.left);
            if (
                !ts.isPropertyAccessExpression(left) ||
                !left.questionDotToken ||
                !ts.isIdentifier(left.expression) ||
                left.expression.text !== "texture"
            ) {
                throw new Error(
                    "Pinned UV transform writer coalesces something other " +
                        "than an optional texture property.",
                );
            }
            return emitOptionalTextureRead(
                state,
                left,
                emitExpression(state, expression.right),
            );
        }
        const spelled: Partial<Record<ts.SyntaxKind, string>> = {
            [ts.SyntaxKind.PlusToken]: "+",
            [ts.SyntaxKind.MinusToken]: "-",
            [ts.SyntaxKind.AsteriskToken]: "*",
            [ts.SyntaxKind.SlashToken]: "/",
            [ts.SyntaxKind.EqualsEqualsEqualsToken]: "==",
            [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!=",
        };
        const symbol = spelled[operator];
        if (!symbol) {
            throw new Error(
                "Pinned UV transform writer uses an unsupported operator " +
                    `'${expression.operatorToken.getText(state.file)}'.`,
            );
        }
        // `!!texture?.invertY !== legacyFlipV` — the double negation is
        // JavaScript coercing an optional read to a boolean, which the
        // record's own bool already is.
        return `(${emitExpression(state, expression.left)} ${symbol} ` +
            `${emitExpression(state, expression.right)})`;
    }
    throw new Error(
        `Pinned UV transform writer has an unsupported expression ` +
            `'${expression.getText(state.file)}'.`,
    );
}

function emitStatements(
    state: EmitState,
    statements: readonly ts.Statement[],
    indent: string,
): string[] {
    const lines: string[] = [];
    for (const statement of statements) {
        if (ts.isVariableStatement(statement)) {
            for (const binding of statement.declarationList.declarations) {
                if (!ts.isIdentifier(binding.name) || !binding.initializer) {
                    throw new Error(
                        "Pinned UV transform writer binds something other " +
                            "than a named local.",
                    );
                }
                const name = binding.name.text;
                const cpp = `local_${name}`;
                const value = emitExpression(state, binding.initializer);
                lines.push(`${indent}const double ${cpp} = ${value};`);
                state.locals.set(name, cpp);
            }
            continue;
        }
        if (ts.isExpressionStatement(statement)) {
            const expression = state.context.unwrapExpression(
                statement.expression,
            );
            if (
                !ts.isBinaryExpression(expression) ||
                expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
            ) {
                throw new Error(
                    "Pinned UV transform writer has a statement that is " +
                        "not a store.",
                );
            }
            // The pin computes in JavaScript doubles and rounds once, at
            // the `Float32Array` store -- so the store is where this port
            // rounds too. Rounding each intermediate instead moved one
            // pixel of scene 282's nearest-filtered checkerboard, which is
            // what a texel boundary looks like when a lane lands a bit low.
            lines.push(
                `${indent}${emitExpression(state, expression.left)} = ` +
                    `static_cast<float>(` +
                    `${emitExpression(state, expression.right)});`,
            );
            continue;
        }
        if (ts.isIfStatement(statement) && !statement.elseStatement) {
            const body = ts.isBlock(statement.thenStatement)
                ? statement.thenStatement.statements
                : [statement.thenStatement];
            lines.push(
                `${indent}if (${
                    emitExpression(state, statement.expression)
                }) {`,
                ...emitStatements(state, body, `${indent}    `),
                `${indent}}`,
            );
            continue;
        }
        throw new Error(
            "Pinned UV transform writer has an unsupported statement " +
                `'${statement.getText(state.file).split("\n")[0]}'.`,
        );
    }
    return lines;
}

export interface LoweredStandardUvTransform {
    floatsPerChannel: number;
    channelCount: number;
    /** The two emitted C++ functions. */
    source: string;
}

/**
 * The pinned channel writer plus the unrolled data writer, as C++.
 */
export function lowerStandardUvTransformWriter(
    context: LoweringContext,
): LoweredStandardUvTransform {
    const floatsPerChannel = moduleConstant(context, "FLOATS_PER_CHANNEL");
    const channelCount = moduleConstant(context, "CHANNEL_COUNT");
    const channels = pinnedChannels(context);
    if (channels.length !== channelCount) {
        throw new Error(
            `Pinned CHANNEL_COUNT is ${channelCount} but CHANNELS holds ` +
                `${channels.length} rows.`,
        );
    }
    const file = context.sourceFile(MODULE);
    const { declaration: channelWriter } = context.functionDeclaration(
        MODULE,
        "writeChannel",
    );
    if (!channelWriter.body) {
        throw new Error("Pinned writeChannel has no body.");
    }
    const state: EmitState = {
        file,
        context,
        locals: new Map(),
        constants: { FLOATS_PER_CHANNEL: floatsPerChannel },
    };
    const channelBody = emitStatements(
        state,
        channelWriter.body.statements,
        "    ",
    ).join("\n");

    // The data writer's own two reads, and the shape of the loop this
    // unrolls. Asserting them is what makes a changed pin fail here rather
    // than emit a stale unroll.
    const { declaration: dataWriter } = context.functionDeclaration(
        MODULE,
        "writeUvTransformData",
    );
    const dataSource = dataWriter.getText(file);
    for (
        const marker of [
            "const materialOffsetX = material.uvOffset?.[0] ?? 0;",
            "const materialOffsetY = material.uvOffset?.[1] ?? 0;",
            "for (let i = 0; i < CHANNELS.length; i++) {",
            "coordIndexKey !== null && material[coordIndexKey] === 1,",
        ]
    ) {
        if (!dataSource.includes(marker)) {
            throw new Error(
                `Pinned writeUvTransformData no longer contains '${marker}'.`,
            );
        }
    }
    const lightmapKey = "_lightmapTexture";
    if (!dataSource.includes(`textureKey === "${lightmapKey}"`)) {
        throw new Error(
            "Pinned writeUvTransformData no longer folds its legacy flip on " +
                `'${lightmapKey}'.`,
        );
    }
    const calls = channels.map((channel, index) => {
        const emit = channelArguments(channel, lightmapKey);
        return `    // channel ${index}: ${channel.name} (${channel.textureKey})
    write_std_uv_transform_channel(
        out.data,
        ${index}.0,
        ${emit.texture},
        props,
        material_offset_x,
        material_offset_y,
        ${emit.usesUv2},
        ${emit.legacyFlipV});`;
    });
    const source = `
// ${context.provenance(MODULE, "writeChannel")}
inline void write_std_uv_transform_channel(
    std::array<float, ${floatsPerChannel * channelCount}>& data,
    double channel,
    const bbl::TextureData* texture,
    [[maybe_unused]] const StandardMaterialProps& material,
    [[maybe_unused]] double material_offset_x,
    [[maybe_unused]] double material_offset_y,
    [[maybe_unused]] bool uses_uv2,
    [[maybe_unused]] bool legacy_flip_v) {
${channelBody}
}

// ${context.provenance(MODULE, "writeUvTransformData")}
//
// The pin's loop runs over its own CHANNELS table, whose rows are fixed, so
// generation unrolls it and folds the two per-row constants each call site
// carries. \`material.uvOffset\` is the pin's optional per-material offset,
// which \`enableStandardUvOffset()\` installs and no reached scene calls, so
// both components read their \`?? 0\` arm here exactly as they do upstream.
inline void write_std_uv_transform_data(
    const bbl::MaterialRecord& material,
    const StandardMaterialProps& props,
    StandardUvTxUniforms& out) {
    const double material_offset_x = 0.0;
    const double material_offset_y = 0.0;
${calls.join("\n")}
}
`;
    return { floatsPerChannel, channelCount, source };
}
