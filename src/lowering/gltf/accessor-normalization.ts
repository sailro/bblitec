import ts from "typescript";
import { floatLiteral } from "../../cpp-literals.js";
import {
    collectLaneStores,
    identifierParameters,
    pinnedDoubleLiteral,
    refuseNode,
    signedNumericValue,
    singleBinding,
    topLevelFunction,
    unwrapPin,
} from "./shared.js";

/*
 * ──────────────────── round-2 loader leaves ────────────────────
 *
 * Same contract as above: the emitters own the translation, never the
 * formula. The specific rules they carry, documented once here:
 *   - A pinned `Math.max(x / N, L)` clamp emits `std::max(Lf, x / Nf)` —
 *     C++ names the clamp bound first; `max` is symmetric over the finite
 *     inputs an int8/int16 divide can produce.
 *   - The pinned color path multiplies by a precomputed reciprocal
 *     (`c * (1 / N)`) in JavaScript doubles where the C++ record path
 *     divides by `N` in float. The results are bit-identical for every
 *     representable input: N is 2^k - 1, so no quotient sits within the
 *     reciprocal's double error of a float rounding boundary. The
 *     equivalence is conditional on N matching between the two pinned
 *     modules, which `lowerVertexColorCpp` proves on every generation.
 *   - `refuseModule` refusals fire where the anchor is a whole module
 *     rather than one node (a missing assignment, a count that changed).
 */


/**
 * DataView getter → the C++ read `read_component` performs for it. Only
 * the widths the pinned accessor normalization reads are named; a new
 * getter upstream misses the map and refuses.
 */
const accessorReadsByGetter: Readonly<
    Record<string, { cppType: string; littleEndian: boolean }>
> = {
    getInt8: { cppType: "std::int8_t", littleEndian: false },
    getUint8: { cppType: "std::uint8_t", littleEndian: false },
    getInt16: { cppType: "std::int16_t", littleEndian: true },
    getUint16: { cppType: "std::uint16_t", littleEndian: true },
    getFloat32: { cppType: "float", littleEndian: true },
};

interface PinnedAccessorClause {
    componentType: number;
    cppType: string;
    getter: string;
    divisor: number;
    /** The lower clamp bound of the signed arms; unsigned arms carry none. */
    clamp?: number;
}

/**
 * The componentType switch of the pinned `readComponent`
 * (`gltf-ext-quantization.ts`): four integer clauses that read one
 * component and normalize it behind the accessor's flag, then the raw
 * float clause, then a throwing default. Exactly that shape — a clause
 * added or removed on either side refuses generation.
 */
function pinnedAccessorClauses(
    file: ts.SourceFile,
): PinnedAccessorClause[] {
    const symbol = "readComponent";
    const declaration = topLevelFunction(file, symbol);
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 4) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (view, offset, componentType, normalized)",
        );
    }
    const viewName = parameters[0]!;
    const offsetName = parameters[1]!;
    const componentTypeName = parameters[2]!;
    const normalizedName = parameters[3]!;
    const only = declaration.body.statements.length === 1
        ? declaration.body.statements[0]
        : undefined;
    if (!only || !ts.isSwitchStatement(only)) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer dispatches through a single componentType switch",
        );
    }
    const dispatch = unwrapPin(only.expression);
    if (
        !ts.isIdentifier(dispatch) ||
        dispatch.text !== componentTypeName
    ) {
        refuseNode(
            symbol,
            file,
            only,
            "no longer switches on the component type",
        );
    }
    const caseConstant = (clause: ts.CaseClause): number => {
        const label = unwrapPin(clause.expression);
        if (ts.isNumericLiteral(label)) {
            return Number(label.text);
        }
        if (ts.isIdentifier(label)) {
            for (const statement of file.statements) {
                if (!ts.isVariableStatement(statement)) continue;
                for (const binding of
                    statement.declarationList.declarations) {
                    if (
                        ts.isIdentifier(binding.name) &&
                        binding.name.text === label.text &&
                        binding.initializer
                    ) {
                        const value = unwrapPin(binding.initializer);
                        if (ts.isNumericLiteral(value)) {
                            return Number(value.text);
                        }
                    }
                }
            }
        }
        refuseNode(
            symbol,
            file,
            clause,
            "labels a case this lowering cannot resolve to a component type",
        );
    };
    /** `view.getX(offset)` / `view.getX(offset, true)` → the getter. */
    const readGetter = (expression: ts.Expression): string => {
        const call = unwrapPin(expression);
        const getter = ts.isCallExpression(call) &&
                ts.isPropertyAccessExpression(call.expression) &&
                ts.isIdentifier(call.expression.expression) &&
                call.expression.expression.text === viewName
            ? call.expression.name.text
            : undefined;
        const config = getter !== undefined
            ? accessorReadsByGetter[getter]
            : undefined;
        if (getter === undefined || !ts.isCallExpression(call)) {
            refuseNode(
                symbol,
                file,
                expression,
                "no longer reads the component through the DataView",
            );
        }
        if (!config) {
            refuseNode(
                symbol,
                file,
                expression,
                `reads through DataView.${getter}, which has no ` +
                    "lowering entry",
            );
        }
        const first = call.arguments[0]
            ? unwrapPin(call.arguments[0])
            : undefined;
        const offsetOk = first !== undefined &&
            ts.isIdentifier(first) &&
            first.text === offsetName;
        const endianOk = config.littleEndian
            ? call.arguments.length === 2 &&
                call.arguments[1]!.kind === ts.SyntaxKind.TrueKeyword
            : call.arguments.length === 1;
        if (!offsetOk || !endianOk) {
            refuseNode(
                symbol,
                file,
                call,
                "no longer reads the little-endian component at the offset",
            );
        }
        return getter;
    };
    const clauses: PinnedAccessorClause[] = [];
    const caseList = only.caseBlock.clauses;
    let index = 0;
    while (index < caseList.length) {
        const clause = caseList[index]!;
        const body = ts.isCaseClause(clause) &&
                clause.statements.length === 1 &&
                ts.isBlock(clause.statements[0]!)
            ? (clause.statements[0] as ts.Block).statements
            : undefined;
        if (!ts.isCaseClause(clause) || !body) break;
        index += 1;
        const componentType = caseConstant(clause);
        const binding = singleBinding(symbol, file, body[0], clause);
        const getter = readGetter(binding.initializer);
        const config = accessorReadsByGetter[getter]!;
        const trailing = body[1];
        const conditional = body.length === 2 &&
                trailing !== undefined &&
                ts.isReturnStatement(trailing) &&
                trailing.expression
            ? unwrapPin(trailing.expression)
            : undefined;
        if (!conditional || !ts.isConditionalExpression(conditional)) {
            refuseNode(
                symbol,
                file,
                clause,
                "no longer normalizes behind the accessor's flag",
            );
        }
        const condition = unwrapPin(conditional.condition);
        const raw = unwrapPin(conditional.whenFalse);
        if (
            !ts.isIdentifier(condition) ||
            condition.text !== normalizedName ||
            !ts.isIdentifier(raw) ||
            raw.text !== binding.name
        ) {
            refuseNode(
                symbol,
                file,
                conditional,
                "no longer keeps the raw component when unnormalized",
            );
        }
        let scaled = unwrapPin(conditional.whenTrue);
        let clamp: number | undefined;
        if (ts.isCallExpression(scaled)) {
            const callee = scaled.expression;
            const isMathMax = ts.isPropertyAccessExpression(callee) &&
                ts.isIdentifier(callee.expression) &&
                callee.expression.text === "Math" &&
                callee.name.text === "max";
            if (!isMathMax || scaled.arguments.length !== 2) {
                refuseNode(
                    symbol,
                    file,
                    scaled,
                    "clamps through a call this lowering cannot carry",
                );
            }
            clamp = signedNumericValue(
                symbol,
                file,
                scaled.arguments[1]!,
            );
            scaled = unwrapPin(scaled.arguments[0]!);
        }
        const divisor = ts.isBinaryExpression(scaled) &&
                scaled.operatorToken.kind === ts.SyntaxKind.SlashToken &&
                ts.isIdentifier(unwrapPin(scaled.left)) &&
                (unwrapPin(scaled.left) as ts.Identifier).text ===
                    binding.name &&
                ts.isNumericLiteral(unwrapPin(scaled.right))
            ? Number((unwrapPin(scaled.right) as ts.NumericLiteral).text)
            : undefined;
        if (divisor === undefined) {
            refuseNode(
                symbol,
                file,
                conditional.whenTrue,
                "no longer normalizes by dividing the component",
            );
        }
        clauses.push({
            componentType,
            cppType: config.cppType,
            getter,
            divisor,
            ...(clamp === undefined ? {} : { clamp }),
        });
    }
    if (clauses.length !== 4) {
        refuseNode(
            symbol,
            file,
            only,
            "no longer carries exactly four integer component types",
        );
    }
    // The tail: the raw float clause the template's own 5126 case
    // mirrors, then the throwing default. Anything else — a fifth
    // integer width, a clause between them — refuses.
    const floatClause = caseList[index];
    index += 1;
    const floatReturn = floatClause !== undefined &&
            ts.isCaseClause(floatClause) &&
            floatClause.statements.length === 1 &&
            ts.isReturnStatement(floatClause.statements[0]!) &&
            (floatClause.statements[0] as ts.ReturnStatement).expression
        ? (floatClause.statements[0] as ts.ReturnStatement).expression
        : undefined;
    if (
        !floatClause ||
        !ts.isCaseClause(floatClause) ||
        caseConstant(floatClause) !== 5126 ||
        !floatReturn ||
        readGetter(floatReturn) !== "getFloat32"
    ) {
        refuseNode(
            symbol,
            file,
            floatClause ?? only,
            "no longer returns the raw float component for type 5126",
        );
    }
    const defaultClause = caseList[index];
    index += 1;
    const defaultThrows = defaultClause !== undefined &&
        ts.isDefaultClause(defaultClause) &&
        defaultClause.statements.length === 1 &&
        ts.isThrowStatement(defaultClause.statements[0]!);
    if (!defaultThrows || index !== caseList.length) {
        refuseNode(
            symbol,
            file,
            defaultClause ?? only,
            "no longer rejects every other component type",
        );
    }
    return clauses;
}

/**
 * The four integer componentType clauses of the loader's
 * `read_component`, emitted from the pinned `readComponent`
 * (`gltf-ext-quantization.ts`): each scale constant, each signed clamp,
 * and each read width comes from the pin.
 */
export function lowerAccessorNormalizationCpp(
    file: ts.SourceFile,
): string {
    const lines: string[] = [];
    for (const clause of pinnedAccessorClauses(file)) {
        const scaled = "static_cast<float>(value) / " +
            floatLiteral(clause.divisor);
        const normalized = clause.clamp === undefined
            ? scaled
            : `std::max(${floatLiteral(clause.clamp)}, ${scaled})`;
        lines.push(
            `        case ${clause.componentType}: {`,
            `            const ${clause.cppType} value = ` +
                `read_value<${clause.cppType}>(data);`,
            `            return accessor.normalized ? ${normalized} : value;`,
            "        }",
        );
    }
    return lines.join("\n");
}

interface PinnedColorBuild {
    /** Vec4 lane → the pin's source component, for the three colors. */
    components: [number, number, number];
    alphaComponent: number;
    alphaFallback: number;
    /** Typed-array constructor name → the branch's divisor. */
    divisors: ReadonlyMap<string, number>;
}

/** The integer branches `normalizeColorToVec4` carries, by array type. */
const colorDivisorGetters: Readonly<Record<string, string>> = {
    Uint8Array: "getUint8",
    Uint16Array: "getUint16",
};

/**
 * `normalizeColorToVec4` (`gltf-color-normalize.ts`): a float branch and
 * one branch per integer width, each storing the same four lanes. All
 * branches must agree on the lane order and the absent-alpha fallback —
 * a branch that drifts refuses rather than picking one.
 */
function pinnedColorBuild(file: ts.SourceFile): PinnedColorBuild {
    const symbol = "normalizeColorToVec4";
    const declaration = topLevelFunction(file, symbol);
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 3) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (data, count, comps)",
        );
    }
    const dataName = parameters[0]!;
    const countName = parameters[1]!;
    const compsName = parameters[2]!;
    const statements = declaration.body.statements;
    // `const out = new Float32Array(count * 4);` — the four-lane record.
    const outBinding = singleBinding(
        symbol,
        file,
        statements[0],
        declaration,
    );
    const outNew = unwrapPin(outBinding.initializer);
    const outStride = ts.isNewExpression(outNew) &&
            ts.isIdentifier(outNew.expression) &&
            outNew.expression.text === "Float32Array" &&
            outNew.arguments?.length === 1 &&
            ts.isBinaryExpression(unwrapPin(outNew.arguments[0]!)) &&
            (unwrapPin(outNew.arguments[0]!) as ts.BinaryExpression)
                    .operatorToken.kind === ts.SyntaxKind.AsteriskToken
        ? unwrapPin(
            (unwrapPin(outNew.arguments[0]!) as ts.BinaryExpression)
                .right,
        )
        : undefined;
    if (
        outStride === undefined ||
        !ts.isNumericLiteral(outStride) ||
        Number(outStride.text) !== 4
    ) {
        refuseNode(
            symbol,
            file,
            outBinding.statement,
            "no longer builds a four-lane color",
        );
    }
    // `const hasAlpha = comps >= 4;` — what makes the record's fixed
    // `colors->type == "VEC4"` test the pin's own predicate: among the
    // VEC3/VEC4 layouts glTF admits for COLOR_0, `comps >= 4` holds
    // exactly for VEC4.
    const alphaBinding = singleBinding(
        symbol,
        file,
        statements[1],
        declaration,
    );
    const alphaShape = unwrapPin(alphaBinding.initializer);
    const alphaShapeOk = ts.isBinaryExpression(alphaShape) &&
        alphaShape.operatorToken.kind ===
            ts.SyntaxKind.GreaterThanEqualsToken &&
        ts.isIdentifier(unwrapPin(alphaShape.left)) &&
        (unwrapPin(alphaShape.left) as ts.Identifier).text ===
            compsName &&
        ts.isNumericLiteral(unwrapPin(alphaShape.right)) &&
        Number(
            (unwrapPin(alphaShape.right) as ts.NumericLiteral).text,
        ) === 4;
    if (!alphaShapeOk) {
        refuseNode(
            symbol,
            file,
            alphaBinding.statement,
            "no longer keys the alpha lane on a four-component source",
        );
    }
    const hasAlphaName = alphaBinding.name;
    interface BranchBuild {
        components: [number, number, number];
        alphaComponent: number;
        alphaFallback: number;
        divisor?: number;
    }
    /** `data[v * comps]` / `data[v * comps + k]` → component k. */
    const componentOf = (
        expression: ts.Expression,
        loopName: string,
        scaleName: string | undefined,
    ): number => {
        let read = unwrapPin(expression);
        if (scaleName !== undefined) {
            const product = read;
            const scaledRead = ts.isBinaryExpression(product) &&
                    product.operatorToken.kind ===
                        ts.SyntaxKind.AsteriskToken &&
                    ts.isIdentifier(unwrapPin(product.right)) &&
                    (unwrapPin(product.right) as ts.Identifier).text ===
                        scaleName
                ? unwrapPin(product.left)
                : undefined;
            if (scaledRead === undefined) {
                refuseNode(
                    symbol,
                    file,
                    expression,
                    "no longer scales the lane by the branch inverse",
                );
            }
            read = scaledRead;
        }
        if (
            !ts.isElementAccessExpression(read) ||
            !ts.isIdentifier(read.expression) ||
            read.expression.text !== dataName
        ) {
            refuseNode(
                symbol,
                file,
                expression,
                "no longer reads the source component the lowered way",
            );
        }
        const index = unwrapPin(read.argumentExpression);
        const base = (node: ts.Expression): boolean => {
            const product = unwrapPin(node);
            return ts.isBinaryExpression(product) &&
                product.operatorToken.kind ===
                    ts.SyntaxKind.AsteriskToken &&
                ts.isIdentifier(unwrapPin(product.left)) &&
                (unwrapPin(product.left) as ts.Identifier).text ===
                    loopName &&
                ts.isIdentifier(unwrapPin(product.right)) &&
                (unwrapPin(product.right) as ts.Identifier).text ===
                    compsName;
        };
        if (base(index)) return 0;
        if (
            ts.isBinaryExpression(index) &&
            index.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            base(index.left) &&
            ts.isNumericLiteral(unwrapPin(index.right))
        ) {
            return Number(
                (unwrapPin(index.right) as ts.NumericLiteral).text,
            );
        }
        refuseNode(
            symbol,
            file,
            read,
            "no longer offsets the component read from the vertex base",
        );
    };
    const analyzeBranch = (
        block: ts.Block,
        scaled: boolean,
        anchor: ts.Node,
    ): BranchBuild => {
        const branch = block.statements;
        let cursor = 0;
        let divisor: number | undefined;
        let scaleName: string | undefined;
        if (scaled) {
            const invBinding = singleBinding(
                symbol,
                file,
                branch[cursor],
                anchor,
            );
            cursor += 1;
            const inverse = unwrapPin(invBinding.initializer);
            const inverseDivisor = ts.isBinaryExpression(inverse) &&
                    inverse.operatorToken.kind ===
                        ts.SyntaxKind.SlashToken &&
                    ts.isNumericLiteral(unwrapPin(inverse.left)) &&
                    Number(
                        (unwrapPin(inverse.left) as ts.NumericLiteral)
                            .text,
                    ) === 1 &&
                    ts.isNumericLiteral(unwrapPin(inverse.right))
                ? Number(
                    (unwrapPin(inverse.right) as ts.NumericLiteral).text,
                )
                : undefined;
            if (inverseDivisor === undefined) {
                refuseNode(
                    symbol,
                    file,
                    invBinding.statement,
                    "no longer derives the inverse from one over the divisor",
                );
            }
            divisor = inverseDivisor;
            scaleName = invBinding.name;
        }
        const loop = branch[cursor];
        cursor += 1;
        if (
            !loop ||
            !ts.isForStatement(loop) ||
            !loop.initializer ||
            !ts.isVariableDeclarationList(loop.initializer) ||
            loop.initializer.declarations.length !== 1 ||
            !ts.isIdentifier(loop.initializer.declarations[0]!.name) ||
            !loop.condition ||
            !ts.isBinaryExpression(loop.condition) ||
            loop.condition.operatorToken.kind !==
                ts.SyntaxKind.LessThanToken ||
            !ts.isIdentifier(unwrapPin(loop.condition.right)) ||
            (unwrapPin(loop.condition.right) as ts.Identifier).text !==
                countName ||
            !ts.isBlock(loop.statement) ||
            cursor !== branch.length
        ) {
            refuseNode(
                symbol,
                file,
                loop ?? anchor,
                "no longer loops once over the vertices",
            );
        }
        const loopName = (
            loop.initializer.declarations[0]!.name as ts.Identifier
        ).text;
        const laneOf = (
            target: ts.ElementAccessExpression,
        ): number | undefined => {
            if (
                !ts.isIdentifier(target.expression) ||
                target.expression.text !== outBinding.name
            ) {
                return undefined;
            }
            const index = unwrapPin(target.argumentExpression);
            const stride = (node: ts.Expression): boolean => {
                const product = unwrapPin(node);
                return ts.isBinaryExpression(product) &&
                    product.operatorToken.kind ===
                        ts.SyntaxKind.AsteriskToken &&
                    ts.isIdentifier(unwrapPin(product.left)) &&
                    (unwrapPin(product.left) as ts.Identifier).text ===
                        loopName &&
                    ts.isNumericLiteral(unwrapPin(product.right)) &&
                    Number(
                        (unwrapPin(product.right) as ts.NumericLiteral)
                            .text,
                    ) === 4;
            };
            if (stride(index)) return 0;
            if (
                ts.isBinaryExpression(index) &&
                index.operatorToken.kind === ts.SyntaxKind.PlusToken &&
                stride(index.left) &&
                ts.isNumericLiteral(unwrapPin(index.right))
            ) {
                return Number(
                    (unwrapPin(index.right) as ts.NumericLiteral).text,
                );
            }
            return undefined;
        };
        const stores = collectLaneStores(
            { symbol, file, names: new Map(), numeric: pinnedDoubleLiteral },
            loop.statement.statements,
            0,
            4,
            laneOf,
        );
        if (stores.next !== loop.statement.statements.length) {
            refuseNode(
                symbol,
                file,
                loop,
                "carries statements after the lane stores",
            );
        }
        const components = stores.expressions
            .slice(0, 3)
            .map((expression) =>
                componentOf(expression, loopName, scaleName)
            ) as [number, number, number];
        const alpha = unwrapPin(stores.expressions[3]!);
        const fallback = ts.isConditionalExpression(alpha) &&
                ts.isIdentifier(unwrapPin(alpha.condition)) &&
                (unwrapPin(alpha.condition) as ts.Identifier).text ===
                    hasAlphaName &&
                ts.isNumericLiteral(unwrapPin(alpha.whenFalse))
            ? Number(
                (unwrapPin(alpha.whenFalse) as ts.NumericLiteral).text,
            )
            : undefined;
        if (!ts.isConditionalExpression(alpha) || fallback === undefined) {
            refuseNode(
                symbol,
                file,
                stores.expressions[3]!,
                "no longer defaults the alpha lane behind the alpha test",
            );
        }
        return {
            components,
            alphaComponent: componentOf(
                alpha.whenTrue,
                loopName,
                scaleName,
            ),
            alphaFallback: fallback,
            ...(divisor === undefined ? {} : { divisor }),
        };
    };
    // The instanceof chain: Float32Array first, then the integer widths.
    const branches: { typeName: string; build: BranchBuild }[] = [];
    let chain: ts.Statement | undefined = statements[2];
    while (chain !== undefined) {
        if (!ts.isIfStatement(chain) || !ts.isBlock(chain.thenStatement)) {
            refuseNode(
                symbol,
                file,
                chain,
                "no longer selects the source layout by instanceof",
            );
        }
        const condition = unwrapPin(chain.expression);
        const typeName = ts.isBinaryExpression(condition) &&
                condition.operatorToken.kind ===
                    ts.SyntaxKind.InstanceOfKeyword &&
                ts.isIdentifier(unwrapPin(condition.left)) &&
                (unwrapPin(condition.left) as ts.Identifier).text ===
                    dataName &&
                ts.isIdentifier(unwrapPin(condition.right))
            ? (unwrapPin(condition.right) as ts.Identifier).text
            : undefined;
        if (typeName === undefined) {
            refuseNode(
                symbol,
                file,
                chain.expression,
                "no longer tests the source array type",
            );
        }
        const scaled = typeName !== "Float32Array";
        if (scaled && colorDivisorGetters[typeName] === undefined) {
            refuseNode(
                symbol,
                file,
                chain.expression,
                `normalizes ${typeName}, which has no lowering entry`,
            );
        }
        branches.push({
            typeName,
            build: analyzeBranch(chain.thenStatement, scaled, chain),
        });
        chain = chain.elseStatement;
    }
    const trailing = statements[3];
    if (
        branches.length !== 3 ||
        branches[0]!.typeName !== "Float32Array" ||
        statements.length !== 4 ||
        !trailing ||
        !ts.isReturnStatement(trailing) ||
        !trailing.expression ||
        !ts.isIdentifier(unwrapPin(trailing.expression)) ||
        (unwrapPin(trailing.expression) as ts.Identifier).text !==
            outBinding.name
    ) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer carries the float and two integer branches",
        );
    }
    const first = branches[0]!.build;
    const divisors = new Map<string, number>();
    for (const { typeName, build } of branches) {
        if (
            build.components.join(",") !== first.components.join(",") ||
            build.alphaComponent !== first.alphaComponent ||
            build.alphaFallback !== first.alphaFallback
        ) {
            refuseNode(
                symbol,
                file,
                declaration,
                `no longer stores the same lanes in the ${typeName} branch`,
            );
        }
        if (build.divisor !== undefined) {
            divisors.set(typeName, build.divisor);
        }
    }
    return {
        components: first.components,
        alphaComponent: first.alphaComponent,
        alphaFallback: first.alphaFallback,
        divisors,
    };
}

/**
 * The COLOR_0 → Vec4 build of the loader's vertex loop, emitted from the
 * pinned `normalizeColorToVec4`: the channel order and the VEC3 alpha
 * default come from the pin. The record path normalizes integer colors
 * inside `read_component` rather than here, so generation also proves
 * that the pin's per-width divisors are exactly the divisors the pinned
 * accessor normalization applies — a divergence between the two modules
 * refuses instead of shipping either.
 */
export function lowerVertexColorCpp(
    file: ts.SourceFile,
    quantizationFile: ts.SourceFile,
): string {
    const build = pinnedColorBuild(file);
    const clauses = pinnedAccessorClauses(quantizationFile);
    for (const [typeName, getter] of Object.entries(colorDivisorGetters)) {
        const colorDivisor = build.divisors.get(typeName);
        const accessor = clauses.find(
            (clause) => clause.getter === getter,
        );
        if (
            colorDivisor === undefined ||
            accessor === undefined ||
            accessor.divisor !== colorDivisor ||
            accessor.clamp !== undefined
        ) {
            throw new Error(
                `Pinned normalizeColorToVec4 scales ${typeName} by a ` +
                    "rule the pinned readComponent does not apply, so " +
                    "routing COLOR_0 through read_component would no " +
                    "longer reproduce the pin.",
            );
        }
    }
    const read = (component: number): string =>
        "read_component(buffer, container, views, *colors, index, " +
        `${component})`;
    return [
        "                if (colors) {",
        "                    vertex.color = Vec4{",
        `                        ${read(build.components[0])},`,
        `                        ${read(build.components[1])},`,
        `                        ${read(build.components[2])},`,
        '                        colors->type == "VEC4"',
        `                            ? ${read(build.alphaComponent)}`,
        `                            : ${floatLiteral(build.alphaFallback)},`,
        "                    };",
        "                }",
    ].join("\n");
}
