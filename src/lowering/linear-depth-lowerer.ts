/**
 * `createLinearDepthMaterial`, folded from the pinned factory that builds it.
 *
 * The pin's own `render/linear-depth-material.ts` is one
 * `createShaderMaterial` call over two module-scope WGSL constants, so this
 * port reaches it the way it reaches `createLineMaterial`: the stages, the
 * attribute and uniform lists and the fixed-function state all come out of
 * that call, and the material is registered as an ordinary scene-local
 * shader variant. Nothing about the depth arithmetic is written here.
 *
 * Two of its uniforms are the reason this needed anything new. The pin lets
 * a caller name nine system uniforms and this port served three; the
 * linear-depth stage reads `view` and `projection` as their own matrices
 * rather than the product, so both joined `shaderSystemMatrixTable` and each
 * pass hands the block writer the two factors of the product it renders
 * with.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { pinnedReverseDepthCompare } from "./pinned-depth-state.js";
import type { CompiledShaderProgram } from "../compiler/types.js";

export const linearDepthModule = "src/render/linear-depth-material.ts";

/** What a reached `createLinearDepthMaterial` call settled. */
export interface LinearDepthMaterialOptions {
    /** The camera near plane, already resolved through the pin's default. */
    readonly near: number;
    /** The camera far plane, likewise. */
    readonly far: number;
}

/**
 * The variant's name.
 *
 * The pin names every one of these materials `"linearDepth"` while giving
 * each its own `nearFar` slot, and this port carries a uniform default on
 * the VARIANT rather than on the material — so the planes are part of the
 * identity here and two differently-ranged materials compose two variants.
 */
export function linearDepthVariantName(
    options: LinearDepthMaterialOptions,
): string {
    const slug = (value: number): string =>
        String(value).replace(/[^0-9a-zA-Z]+/g, "-");
    return `linear-depth-${slug(options.near)}-${slug(options.far)}`;
}

/** The `uniforms` list the pinned call declares, in its own order. */
interface PinnedUniformList {
    /** Each entry in this port's signature spelling. */
    readonly signatures: string[];
    /** The one typed declaration, which carries the planes. */
    readonly custom: { readonly name: string; readonly type: string };
}

export class LinearDepthLowerer {
    public constructor(private readonly context: LoweringContext) {}

    private get file(): ts.SourceFile {
        return this.context.sourceFile(linearDepthModule);
    }

    /**
     * The pin's own `options.<name> ?? <literal>` fallback for one plane.
     *
     * Read rather than restated for the reason every default here is: a
     * scene that names neither plane has to land on the pin's numbers, and
     * a bump that retunes one has to move this port with it.
     */
    public defaultPlane(name: "near" | "far"): number {
        const { file, declaration } = this.context.functionDeclaration(
            linearDepthModule,
            "createLinearDepthMaterial",
        );
        const initializer = this.context.variableInitializer(
            declaration,
            name,
        );
        if (
            !ts.isBinaryExpression(initializer) ||
            initializer.operatorToken.kind !==
                ts.SyntaxKind.QuestionQuestionToken
        ) {
            this.context.contractError(
                initializer,
                `Expected createLinearDepthMaterial to default its ${name} ` +
                    "plane through `options.x ?? <literal>`.",
            );
        }
        return this.context.numericValue(initializer.right, file);
    }

    /**
     * The program the pinned factory composes, as this port's own variant.
     *
     * Every part of it is read out of that factory: the two stages from the
     * module constants it references, the attribute and uniform lists from
     * the `createShaderMaterial` call, and the fixed-function state from the
     * properties beside them.
     */
    public materialProgram(
        options: LinearDepthMaterialOptions,
    ): CompiledShaderProgram {
        const call = this.context.pinnedShaderMaterialCall(
            linearDepthModule,
            "createLinearDepthMaterial",
        );
        this.assertMaterialState(call);
        const { signatures, custom } = this.uniformList(call);
        return {
            name: linearDepthVariantName(options),
            vertexSource: this.stageConstant(call, "vertexSource"),
            fragmentSource: this.stageConstant(call, "fragmentSource"),
            attributes: this.context.stringArrayValue(
                this.context.propertyInitializer(call, "attributes"),
                this.file,
            ),
            uniforms: signatures,
            uniformDefaults: [
                { name: custom.name, values: [options.near, options.far] },
            ],
            samplers: [],
            defines: [],
            needAlphaBlending: false,
            needAlphaTesting: false,
            backFaceCulling: true,
            depthWrite: true,
        };
    }

    /** One stage, from the module constant the call names for it. */
    private stageConstant(
        call: ts.ObjectLiteralExpression,
        property: string,
    ): string {
        const reference = this.context.propertyInitializer(call, property);
        if (!ts.isIdentifier(reference)) {
            this.context.contractError(
                reference,
                `Expected the linear-depth ${property} to name a module ` +
                    "constant.",
            );
        }
        return this.context.stringValue(
            this.context.variableInitializer(this.file, reference.text),
            this.file,
        );
    }

    /**
     * The pinned material state this port folds.
     *
     * The three properties it restates are read from the call; the rest is
     * the closed set, because a property the pin adds later would otherwise
     * be silently dropped — the same contract the effect wrapper's pass
     * state takes.
     */
    private assertMaterialState(call: ts.ObjectLiteralExpression): void {
        const declared = new Set(
            call.properties
                .map((property) =>
                    ts.isPropertyAssignment(property)
                        ? this.context.propertyName(property.name)
                        : undefined,
                )
                .filter((name): name is string => name !== undefined),
        );
        const expected = [
            "name",
            "vertexSource",
            "fragmentSource",
            "attributes",
            "uniforms",
            "backFaceCulling",
            "depthWrite",
            "depthCompare",
        ];
        if (
            declared.size !== call.properties.length ||
            expected.some((name) => !declared.has(name)) ||
            declared.size !== expected.length
        ) {
            this.context.contractError(
                call,
                "Expected createLinearDepthMaterial to declare exactly " +
                    `${expected.join(", ")}.`,
            );
        }
        // A depth material culls back faces and writes depth.
        for (const property of ["backFaceCulling", "depthWrite"] as const) {
            const value = this.context.propertyInitializer(call, property);
            if (value.kind !== ts.SyntaxKind.TrueKeyword) {
                this.context.contractError(
                    value,
                    `Expected a linear-depth material to set ${property} ` +
                        "to true.",
                );
            }
        }
        // And renders under the pin's own reverse-Z compare, which is this
        // port's convention -- the fold is legitimate only while the two
        // agree, and a ShaderMaterial's own compare is not carried through
        // lowering, so this is where that is checked.
        const compare = this.context.propertyInitializer(
            call,
            "depthCompare",
        );
        const named = this.context.stringValue(compare, this.file);
        const convention = pinnedReverseDepthCompare(this.context);
        if (named !== convention) {
            this.context.contractError(
                compare,
                `A linear-depth material renders at depthCompare ` +
                    `'${named}', which is not this port's own ` +
                    `'${convention}' convention; a ShaderMaterial's own ` +
                    "compare is not carried through lowering.",
            );
        }
    }

    /**
     * `uniforms`, in the pin's own order: the system matrices the stages
     * read as bare names, then the one typed declaration carrying the
     * planes.
     */
    private uniformList(
        call: ts.ObjectLiteralExpression,
    ): PinnedUniformList {
        const uniforms = this.context.propertyInitializer(call, "uniforms");
        if (!ts.isArrayLiteralExpression(uniforms)) {
            this.context.contractError(
                uniforms,
                "Expected a linear-depth material's uniforms to be an " +
                    "array literal.",
            );
        }
        const declarations = uniforms.elements.filter(
            (element): element is ts.ObjectLiteralExpression =>
                ts.isObjectLiteralExpression(element),
        );
        if (declarations.length !== 1) {
            this.context.contractError(
                uniforms,
                "Expected a linear-depth material to declare exactly one " +
                    "typed uniform.",
            );
        }
        const declaration = declarations[0]!;
        // Which plane lands in which lane is the pin's, not an assumption:
        // the default is written as the two locals this port reads its own
        // fallbacks from, in that order.
        this.context.assertExpressionShape(
            this.context.propertyInitializer(declaration, "defaultValue"),
            "[near, far]",
            "Pinned linear-depth uniform default",
        );
        const custom = {
            name: this.context.stringValue(
                this.context.propertyInitializer(declaration, "name"),
                this.file,
            ),
            type: this.context.stringValue(
                this.context.propertyInitializer(declaration, "type"),
                this.file,
            ),
        };
        return {
            signatures: uniforms.elements.map((element) =>
                ts.isObjectLiteralExpression(element)
                    ? `${custom.name}:${custom.type}`
                    : this.context.stringValue(element, this.file),
            ),
            custom,
        };
    }
}
