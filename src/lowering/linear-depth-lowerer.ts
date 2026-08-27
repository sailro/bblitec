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
 * rather than the product, so both joined `shaderSystemMatrixTable` and the
 * PALs build each from the same camera the pass's view-projection came
 * from.
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

export class LinearDepthLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /** The `createShaderMaterial({ ... })` argument the factory passes. */
    private materialCall(): ts.ObjectLiteralExpression {
        return this.context.callObjectArgument(
            this.context.functionDeclaration(
                linearDepthModule,
                "createLinearDepthMaterial",
            ).declaration,
            "createShaderMaterial",
        );
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
        const file = this.context.sourceFile(linearDepthModule);
        const call = this.materialCall();
        this.assertMaterialState(call);
        const stageConstant = (property: string): string => {
            const reference = this.context.propertyInitializer(
                call,
                property,
            );
            if (!ts.isIdentifier(reference)) {
                this.context.contractError(
                    reference,
                    `Expected the linear-depth ${property} to name a module ` +
                        "constant.",
                );
            }
            return this.context.stringValue(
                this.context.variableInitializer(file, reference.text),
                file,
            );
        };
        return {
            name: linearDepthVariantName(options),
            vertexSource: stageConstant("vertexSource"),
            fragmentSource: stageConstant("fragmentSource"),
            attributes: this.stringArray(
                this.context.propertyInitializer(call, "attributes"),
            ),
            uniforms: this.assertUniforms(call),
            uniformDefaults: [
                { name: this.customUniformName(call), values: [options.near, options.far] },
            ],
            samplers: [],
            defines: [],
            needAlphaBlending: false,
            needAlphaTesting: false,
            backFaceCulling: true,
            depthWrite: true,
        };
    }

    /**
     * The pinned material state this port folds, each read from the
     * property that states it: a depth material culls back faces, writes
     * depth, and renders under the pin's own reverse-Z compare — which is
     * this port's convention, so the fold is legitimate only while the two
     * agree, and this is where that is checked.
     */
    private assertMaterialState(call: ts.ObjectLiteralExpression): void {
        for (const [property, expected] of [
            ["backFaceCulling", true],
            ["depthWrite", true],
        ] as const) {
            const value = this.context.propertyInitializer(call, property);
            const literal = value.kind === ts.SyntaxKind.TrueKeyword;
            if (literal !== expected) {
                this.context.contractError(
                    value,
                    `Expected a linear-depth material to set ${property} ` +
                        `to ${expected}.`,
                );
            }
        }
        const compare = this.context.propertyInitializer(
            call,
            "depthCompare",
        );
        const named = this.context.stringValue(
            compare,
            this.context.sourceFile(linearDepthModule),
        );
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

    /** The one custom uniform's name, read from the declaration it rides. */
    private customUniformName(call: ts.ObjectLiteralExpression): string {
        return this.uniformDeclaration(call).name;
    }

    /**
     * `uniforms`, in the pin's own order: the system matrices the stages
     * read as bare names, then the one typed declaration carrying the
     * planes.
     */
    private assertUniforms(call: ts.ObjectLiteralExpression): string[] {
        const uniforms = this.context.propertyInitializer(call, "uniforms");
        if (!ts.isArrayLiteralExpression(uniforms)) {
            this.context.contractError(
                uniforms,
                "Expected a linear-depth material's uniforms to be an array literal.",
            );
        }
        const file = this.context.sourceFile(linearDepthModule);
        const declaration = this.uniformDeclaration(call);
        return uniforms.elements.map((element) => {
            if (ts.isObjectLiteralExpression(element)) {
                return `${declaration.name}:${declaration.type}`;
            }
            return this.context.stringValue(element, file);
        });
    }

    /** The `{ name, type, defaultValue }` entry in that list. */
    private uniformDeclaration(
        call: ts.ObjectLiteralExpression,
    ): { name: string; type: string } {
        const uniforms = this.context.propertyInitializer(call, "uniforms");
        if (!ts.isArrayLiteralExpression(uniforms)) {
            this.context.contractError(
                uniforms,
                "Expected a linear-depth material's uniforms to be an array literal.",
            );
        }
        const file = this.context.sourceFile(linearDepthModule);
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
        return {
            name: this.context.stringValue(
                this.context.propertyInitializer(declaration, "name"),
                file,
            ),
            type: this.context.stringValue(
                this.context.propertyInitializer(declaration, "type"),
                file,
            ),
        };
    }

    private stringArray(expression: ts.Expression): string[] {
        if (!ts.isArrayLiteralExpression(expression)) {
            this.context.contractError(
                expression,
                "Expected a string array literal.",
            );
        }
        const file = this.context.sourceFile(linearDepthModule);
        return expression.elements.map((element) =>
            this.context.stringValue(element, file),
        );
    }
}
