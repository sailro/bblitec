import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import type { DataType } from "./data-types/model.js";
import { EmissionMap } from "./emission-transaction.js";
import { pinnedHandleTypeNames } from "./data-types.js";
import { hasPropertyRule } from "./properties.js";
import {
    addedPropertyStorage,
    unknownPropertyValue,
} from "./added-properties.js";
import { declaredIn, pinnedInterfaceType } from "./symbols.js";
import { optionalPresentCpp, optionalValueCpp } from "./values/model.js";

type Context = Pick<
    LoweringServices,
    | "program"
    | "checker"
    | "unwrap"
    | "compileValue"
    | "probeEmission"
    | "bindings"
    | "dataLowerer"
    | "dataTypes"
    | "nativeEmission"
    | "allocateTemporaryCppName"
    | "emit"
    | "increaseIndent"
    | "decreaseIndent"
    | "enterRuntimeControlFlow"
    | "leaveRuntimeControlFlow"
    | "fail"
    | "requireEngine"
>;

/**
 * The engine object kinds a program can add properties to: each native
 * handle names one object for that object's whole life
 * (`bbl::engine_object_identity`).
 */
const OBJECT_KINDS = ["material", "mesh", "transform-node"] as const;

type ObjectKind = (typeof OBJECT_KINDS)[number];

/** A value that is an engine object taking added properties. */
type EngineObject = Value & { kind: ObjectKind };

/** The run-time families of a material record (`bbl::material_family_name`). */
type MaterialFamily = "shader" | "standard" | "pbr" | "node";

/** The pinned interface each family's materials are. */
const FAMILY_TYPES: Readonly<Record<MaterialFamily, string>> = {
    shader: "ShaderMaterial",
    standard: "StandardMaterialProps",
    pbr: "PbrMaterialProps",
    node: "NodeMaterial",
};

/**
 * Which storage a property of an engine object is: one the pin's type of
 * the object declares (`engine`), one it does not, which the program adds
 * (`added`), or, for a material whose family generation does not know, the
 * pin's own member of only some families (`families`).
 */
type Membership =
    | { readonly kind: "engine" }
    | { readonly kind: "added" }
    | {
          readonly kind: "families";
          readonly families: readonly MaterialFamily[];
      };

interface Field {
    readonly type: DataType;
    readonly functionCpp: string;
}

/** An engine object a property access names, held for one access. */
interface Target {
    readonly kind: ObjectKind;
    readonly field: Field;
    /** `bbl::EngineObjectProperty<T>&` for the object's engine. */
    readonly valuesCpp: string;
    /** The object's `bbl::engine_object_identity`. */
    readonly identityCpp: string;
}

/**
 * The properties a program adds to engine objects. JavaScript lets a program
 * add an own property to any object, an engine material, mesh or node
 * included; the pin's own members keep their native lowering, and every
 * other property lives in the engine's per-object storage
 * (`bbl::engine_object_property`): per property and kind, the value each
 * object holds by its identity, an object without an entry having none.
 */
export class EngineObjectProperties {
    private readonly fields = new EmissionMap<string, Field>();

    constructor(private readonly context: Context) {}

    /** Whether `owner` is an engine object that takes added properties. */
    private object(owner: Value): owner is EngineObject {
        return (
            OBJECT_KINDS.some((kind) => kind === owner.kind) && owner.cpp !== ""
        );
    }

    /**
     * The family generation knows a material value is of. `assetPbrMaterial`
     * proves none: a material read off any mesh no scene creation names
     * carries it, a ShaderMaterial included.
     */
    private family(owner: Value): MaterialFamily | undefined {
        if (owner.standardMaterial) return "standard";
        if (owner.scenePbrMaterialIndex !== undefined) return "pbr";
        if (owner.nodeMaterialIndex !== undefined) return "node";
        if (owner.sceneShaderVariant !== undefined || owner.shaderCreation)
            return "shader";
        return undefined;
    }

    private declares(typeName: string, name: string): boolean {
        const type = pinnedInterfaceType(
            this.context.program,
            this.context.checker,
            typeName,
        );
        return type !== undefined && type.getProperty(name) !== undefined;
    }

    /** Which storage `name` is on the engine object `owner`. */
    private membership(owner: EngineObject, name: string): Membership {
        const engineIf = (declared: boolean): Membership => ({
            kind: declared ? "engine" : "added",
        });
        const declaresAny = (types: readonly string[]): boolean =>
            types.some((type) => this.declares(type, name));
        // A member the engine's record keeps (a material's own
        // `environmentIntensity`, whatever its family), or one the pin
        // spells as its internal (`_uniformVersion`): its typings erase
        // those, so the object may well have it.
        if (name.startsWith("_") || hasPropertyRule(owner.kind, name))
            return { kind: "engine" };
        if (owner.kind !== "material")
            return engineIf(declaresAny(pinnedHandleTypeNames(owner.kind)));
        const known = this.family(owner);
        if (known) return engineIf(this.declares(FAMILY_TYPES[known], name));
        const all = Object.keys(FAMILY_TYPES) as MaterialFamily[];
        const families = all.filter((family) =>
            this.declares(FAMILY_TYPES[family], name),
        );
        if (families.length === all.length) return { kind: "engine" };
        if (families.length > 0) return { kind: "families", families };
        // A member every material or view carries, whatever its family.
        return engineIf(declaresAny(pinnedHandleTypeNames("material")));
    }

    /**
     * The engine object `owner` is, where `name` on it is a property the
     * program adds: neither the pin's member on the type the program gives
     * `receiver` nor one on the object.
     */
    private addedObject(
        owner: Value,
        name: string,
        receiver: ts.Expression,
    ): EngineObject | undefined {
        return this.object(owner) &&
            !this.declaredByReceiver(receiver, name) &&
            this.membership(owner, name).kind === "added"
            ? owner
            : undefined;
    }

    /**
     * Why a property of a material whose family generation does not know
     * has no storage: it is the pin's own member of `families` and a
     * property the program adds to any other.
     */
    public refusal(
        owner: Value,
        expression: ts.PropertyAccessExpression,
    ): string | undefined {
        const membership = this.object(owner)
            ? this.membership(owner, expression.name.text)
            : undefined;
        return membership?.kind === "families"
            ? `'${expression.name.text}' is the pin's own member of a ${membership.families.join(" or ")} material, and a property the program adds to any other; this material's family is decided at run time, and its own member is not lowered for a material of a family generation does not know.`
            : undefined;
    }

    /** The storage of `name` on `kind` objects, of the type its first site declares. */
    private field(
        kind: ObjectKind,
        name: string,
        declared: ts.Type | undefined,
        site: ts.Node,
    ): Field {
        const key = `${kind}:${name}`;
        const existing = this.fields.get(key);
        if (existing) return existing;
        const context = this.context;
        const valueType =
            declared &&
            (unknownPropertyValue(declared) ??
                context.dataTypes.fromStoredTsType(declared, site));
        if (!valueType)
            return context.fail(
                site,
                `A property the program adds to a ${kind} holds a value of a represented type.`,
            );
        const type = addedPropertyStorage(context.dataTypes, valueType);
        const cppType = context.dataTypes.cppType(type);
        const cppName = context.allocateTemporaryCppName("object_property");
        const signature = `bbl::EngineObjectProperty<${cppType}>& ${cppName}(bbl::Engine& engine)`;
        context.nativeEmission.registerNativeFunction(`${signature};`, [
            `${signature} {`,
            "    static const int key = 0;",
            `    return bbl::engine_object_property<${cppType}>(engine, &key);`,
            "}",
        ]);
        const field = { type, functionCpp: `bblscene::${cppName}` };
        this.fields.set(key, field);
        return field;
    }

    /**
     * Whether the type the program gives `receiver` is a pinned one that
     * declares `name` (`material as ShaderMaterial`): the pin's member,
     * whatever generation knows of the object.
     */
    private declaredByReceiver(receiver: ts.Expression, name: string): boolean {
        const type = this.context.checker.getNonNullableType(
            this.context.checker.getTypeAtLocation(receiver),
        );
        return declaredIn(type.getProperty(name), "babylon");
    }

    /** The engine object `object`, a `kind` one, held for one access of `name`. */
    private target(
        kind: ObjectKind,
        object: Value,
        name: string,
        declared: ts.Type | undefined,
        site: ts.Expression,
    ): Target {
        const field = this.field(kind, name, declared, site);
        return {
            kind,
            field,
            valuesCpp: `${field.functionCpp}(${this.context.requireEngine(object, site)})`,
            identityCpp: `bbl::engine_object_identity(${object.cpp})`,
        };
    }

    /** `owner.name`, read where nothing else claims it: the value the program added, or undefined. */
    public read(
        owner: Value,
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const name = expression.name.text;
        const object = this.addedObject(owner, name, expression.expression);
        if (!object) return undefined;
        const target = this.target(
            object.kind,
            object,
            name,
            this.context.checker.getTypeAtLocation(expression),
            expression,
        );
        // A copy of what the object holds now: no place a write stores
        // into (`assign` owns those), and a later write changes it.
        return {
            ...this.context.dataLowerer.leafValue(
                `bbl::engine_object_property_value(${target.valuesCpp}, ${target.identityCpp})`,
                target.field.type,
            ),
            freshData: true,
            impure: true,
        };
    }

    /**
     * The engine object a write or a deletion of `access` names, evaluated
     * and held, where the property is one the program adds.
     */
    private heldTarget(access: ts.Expression): Target | undefined {
        const context = this.context;
        const node = context.unwrap(access);
        if (!ts.isPropertyAccessExpression(node)) return undefined;
        const receiver = context.unwrap(node.expression);
        const name = node.name.text;
        // A class instance is never one.
        if (
            receiver.kind === ts.SyntaxKind.ThisKeyword ||
            this.declaredByReceiver(receiver, name)
        )
            return undefined;
        const object = context.probeEmission(() => {
            const value = context.dataLowerer.narrowOptional(
                context.compileValue(receiver),
                receiver,
            );
            return this.object(value) &&
                this.membership(value, name).kind === "added"
                ? value
                : undefined;
        });
        if (!object) return undefined;
        // JavaScript evaluates the object before the value it stores.
        const held = context.bindings.pinValueToTemporary(
            object,
            "property_object",
            receiver,
        );
        const target = this.target(
            object.kind,
            held,
            name,
            context.checker.getTypeAtLocation(node),
            node,
        );
        return {
            ...target,
            valuesCpp: this.heldReference(
                "object_properties",
                target.valuesCpp,
            ),
        };
    }

    /** A new `auto&` named for `label`, bound to `initializer`. */
    private heldReference(label: string, initializer: string): string {
        const name = this.context.allocateTemporaryCppName(label);
        this.context.emit({
            kind: "declaration",
            type: "auto&",
            name,
            initializer,
        });
        return name;
    }

    /** `object.name op= value` for a property the program adds. */
    public assign(expression: ts.BinaryExpression): boolean {
        const context = this.context;
        const target = this.heldTarget(expression.left);
        if (!target) return false;
        const slot = `${target.valuesCpp}[${target.identityCpp}]`;
        const operator = expression.operatorToken.kind;
        if (operator === ts.SyntaxKind.EqualsToken) {
            context.emit({
                kind: "expression",
                code: `${slot} = ${context.dataLowerer.compileForRetainedSink(expression.right, target.field.type, "a property added to an engine object")};`,
            });
            return true;
        }
        const logical =
            operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
            operator === ts.SyntaxKind.BarBarEqualsToken ||
            operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
        if (logical) {
            // `&&=` stores nothing where the object has no such property,
            // so it must not make one.
            const emitLogical = (): void => {
                context.dataLowerer.emitLogicalSlotAssignment(
                    expression,
                    context.dataLowerer.leafValue(
                        this.heldReference("object_property", slot),
                        target.field.type,
                    ),
                );
            };
            if (operator !== ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
                emitLogical();
                return true;
            }
            context.emit({
                kind: "open",
                code: `if (${target.valuesCpp}.contains(${target.identityCpp})) {`,
            });
            context.increaseIndent();
            context.enterRuntimeControlFlow();
            try {
                emitLogical();
            } finally {
                context.leaveRuntimeControlFlow();
                context.decreaseIndent();
            }
            context.emit({ kind: "close", code: "}" });
            return true;
        }
        const type = target.field.type;
        if (type.kind !== "optional" || type.inner.kind !== "number")
            return context.fail(
                expression.operatorToken,
                `'${expression.operatorToken.getText()}' on a property the program adds to a ${target.kind} combines a number property.`,
            );
        const held = this.heldReference("object_property", slot);
        const storage = context.dataTypes.cppType(type);
        // An absent property reads as undefined, which is NaN as a number.
        context.dataLowerer.emitNumericCompound(
            expression.left,
            expression.right,
            expression.operatorToken.getText(),
            held,
            `(${optionalPresentCpp(held)} ? ${optionalValueCpp(held)} : std::numeric_limits<double>::quiet_NaN())`,
            (value) => `${held} = ${storage}{${value}};`,
            false,
        );
        return true;
    }

    /** `delete object.name`: the object no longer has the property. */
    public remove(expression: ts.DeleteExpression): boolean {
        const target = this.heldTarget(expression.expression);
        if (!target) return false;
        this.context.emit({
            kind: "expression",
            code: `${target.valuesCpp}.erase(${target.identityCpp});`,
        });
        return true;
    }

    /** `"name" in object` for a property the program adds: whether the object has it. */
    public membershipCpp(
        owner: Value,
        name: string,
        site: ts.Expression,
    ): string | undefined {
        const object = this.addedObject(owner, name, site);
        if (!object) return undefined;
        const declared = this.context.checker
            .getNonNullableType(this.context.checker.getTypeAtLocation(site))
            .getProperty(name);
        const target = this.target(
            object.kind,
            object,
            name,
            declared &&
                this.context.checker.getTypeOfSymbolAtLocation(declared, site),
            site,
        );
        return `${target.valuesCpp}.contains(${target.identityCpp})`;
    }
}
