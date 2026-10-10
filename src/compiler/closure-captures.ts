import { createHash } from "node:crypto";
import { EmissionSet, journaled } from "./emission-transaction.js";
import type { DataType } from "./data-types/model.js";

/** An emitted native binding, shared by every expression that reads it. */
export interface NativeCaptureBinding {
    readonly name: string;
    readonly sequence: number;
    readonly borrowed: boolean;
    readonly allowReference: boolean;
    readonly entryLifetime: boolean;
}

/** A delayed expression and the native storage it reads. */
export interface NativeExpression {
    readonly cpp: string;
    readonly nativeCaptures: readonly NativeCaptureBinding[];
}

export const nativeCompanionKeys = [
    "engineCpp",
    "ownedEngineCpp",
    "storedEngineCpp",
    "resourceStorageCpp",
    "optionalStorageCpp",
    "optionalFoundCpp",
    "slotFoundCpp",
    "truthinessCpp",
    "spriteLayerCpp",
    "dynamicAssetPathCpp",
] as const;
export type NativeCompanionKey = (typeof nativeCompanionKeys)[number];

export interface CapturedClosure {
    lines: string[];
    environment: string;
    initializer: string;
    nativeCaptures: readonly NativeCaptureBinding[];
    localBindings: readonly string[];
    environmentType?: string;
}

/**
 * The named aggregate a closure environment is stored in. Its members are
 * the captured bindings; a concrete one is declared ahead of the prototypes
 * that name it, and one with an unresolved capture type is a template.
 */
interface EnvironmentStruct {
    readonly name: string;
    readonly lines: readonly string[];
    /** Every capture type resolved: a declared struct rather than a template. */
    readonly concrete: boolean;
    readonly declaration?: string;
}

export function renderClosure(
    closure: CapturedClosure,
    parameters: string,
    returnType?: string,
): string {
    return (
        `bbl::js::make_closure(${closure.initializer}, []([[maybe_unused]] decltype(${closure.initializer})& ${closure.environment}${parameters ? `, ${parameters}` : ""})${returnType ? ` -> ${returnType}` : ""} {\n` +
        closure.lines.map((line) => `            ${line}`).join("\n") +
        "\n        })"
    );
}

/** A coroutine owns a copy of the environment even if its callback is cleared. */
export function renderCoroutineInvocation(
    closure: CapturedClosure,
    returnType: string,
    parameters = "",
    args = "",
    environment = closure.initializer,
): string {
    return (
        `([]([[maybe_unused]] decltype(${closure.initializer}) ${closure.environment}${parameters ? `, ${parameters}` : ""}) -> ${returnType} {\n` +
        closure.lines.join("\n") +
        `\n}(${environment}${args ? `, ${args}` : ""}))`
    );
}

export function renderAsyncClosure(
    closure: CapturedClosure,
    parameters: readonly {
        type: string;
        dataType: DataType;
        name: string;
    }[],
    returnType: string,
    discard: boolean,
    invoke: typeof renderCoroutineInvocation = renderCoroutineInvocation,
): string {
    const declarations = parameters
        .map(
            (parameter) =>
                `[[maybe_unused]] ${parameter.type} ${parameter.name}`,
        )
        .join(", ");
    const invocation = invoke(
        closure,
        returnType,
        declarations,
        parameters
            .map((parameter) =>
                copiesScalarParameter(parameter.dataType)
                    ? parameter.name
                    : `std::move(${parameter.name})`,
            )
            .join(", "),
        closure.environment,
    );
    return renderClosure(
        {
            ...closure,
            lines: [
                discard
                    ? `static_cast<void>(${invocation});`
                    : `return ${invocation};`,
            ],
        },
        declarations,
        discard ? "void" : returnType,
    );
}

/** Scalar payloads stay trivial through nullable and variant wrappers. */
function copiesScalarParameter(type: DataType): boolean {
    if (type.kind === "optional") return copiesScalarParameter(type.inner);
    if (type.kind === "union") return type.members.every(copiesScalarParameter);
    return (
        type.kind === "number" ||
        type.kind === "boolean" ||
        type.kind === "enum"
    );
}

/**
 * Which captures an environment borrows rather than owns. `true` borrows the
 * bindings that allow a reference, `"entry"` only those living as long as the
 * entry. `"call"` is an environment built for one synchronous call and
 * released when it returns: every capture is a binding of the caller, which
 * outlives the call, so it borrows them all and a call copies no owner.
 */
export type ClosureBorrowing = boolean | "entry" | "call";

/** Named aliases preserve all companion expressions while the typed environment
 * exposes the actual owning captures, including mutable cells, to the GC. */
export class ClosureCaptures {
    private readonly bindings = new EmissionSet<NativeCaptureBinding>();
    @journaled private accessor struct: EnvironmentStruct | undefined;
    constructor(
        readonly environment: string,
        readonly boundary: number,
        private readonly byReference: ClosureBorrowing = false,
        private readonly bindingType?: (
            binding: NativeCaptureBinding,
        ) => string | undefined,
    ) {}

    use(binding: NativeCaptureBinding): void {
        if (binding.sequence <= this.boundary && !this.bindings.has(binding)) {
            this.bindings.add(binding);
            this.struct = undefined;
        }
    }

    retainReferenced(identifiers: ReadonlySet<string>): void {
        for (const binding of this.bindings) {
            if (!identifiers.has(binding.name)) {
                this.bindings.delete(binding);
                this.struct = undefined;
            }
        }
    }

    get initializer(): string {
        const struct = this.environmentStruct;
        return `bblscene::${struct.name}{${[...this.bindings]
            .map((binding) =>
                this.wraps(binding, struct)
                    ? `std::ref(${binding.name})`
                    : binding.name,
            )
            .join(", ")}}`;
    }

    get nativeCaptures(): readonly NativeCaptureBinding[] {
        return [...this.bindings];
    }

    get environmentType(): string | undefined {
        const struct = this.environmentStruct;
        return struct.declaration ? `bblscene::${struct.name}` : undefined;
    }

    /**
     * Members are numbered captures, so environments of one shape share a
     * struct and bodies that differ only in capture names stay one body.
     * Owned members are traced; borrowed ones are references. A call
     * environment of concrete types holds C++ references, so it is built from
     * the same initializer text as an owning one.
     */
    get environmentStruct(): EnvironmentStruct {
        if (this.struct) return this.struct;
        const bindings = [...this.bindings];
        const types = bindings.map((binding) => this.bindingType?.(binding));
        const concrete = types.every((type) => type !== undefined);
        const references = this.holdsReferences(concrete);
        const members = bindings.map((binding, index) => {
            const type = types[index];
            const borrowed = this.borrows(binding);
            return {
                name: `capture${index}`,
                type:
                    concrete && type !== undefined
                        ? references
                            ? `std::remove_reference_t<${type}>&`
                            : borrowed
                              ? `std::reference_wrapper<${type}>`
                              : `std::decay_t<${type}>`
                        : `T${index}`,
                borrowed,
            };
        });
        const name = `bbl_environment_${createHash("sha256")
            .update(JSON.stringify(members))
            .digest("hex")
            .slice(0, 16)}`;
        // An owned capture is value-initialized; references and borrowed
        // wrappers are bound wherever the struct is built.
        const initialized = concrete && !references;
        return (this.struct = {
            name,
            concrete,
            lines: [
                ...(concrete
                    ? []
                    : [
                          `template <${members.map((member) => `typename ${member.type}`).join(", ")}>`,
                      ]),
                `struct ${name} {`,
                ...members.map(
                    (member) =>
                        `    ${member.type} ${member.name}${initialized && !member.borrowed ? "{}" : ""};`,
                ),
                `    void gc_trace([[maybe_unused]] const bbl::js::TraceVisitor& visitor) const {`,
                ...members
                    .filter((member) => !member.borrowed)
                    .map((member) => `        visitor(${member.name});`),
                "    }",
                "};",
            ],
            ...(concrete ? { declaration: `struct ${name};` } : {}),
        });
    }

    get declarations(): string[] {
        const struct = this.environmentStruct;
        return [...this.bindings].map(
            (binding, index) =>
                `auto& ${binding.name} = ${this.environment}.capture${index}${this.wraps(binding, struct) ? ".get()" : ""};`,
        );
    }

    /** A borrowed capture held through `std::reference_wrapper`. */
    private wraps(
        binding: NativeCaptureBinding,
        struct: EnvironmentStruct,
    ): boolean {
        return !this.holdsReferences(struct.concrete) && this.borrows(binding);
    }

    /**
     * A call environment of concrete types holds its borrowed captures as C++
     * references initialized from the bindings.
     */
    private holdsReferences(concrete: boolean): boolean {
        return concrete && this.byReference === "call";
    }

    private borrows(binding: NativeCaptureBinding): boolean {
        return (
            binding.borrowed ||
            this.byReference === "call" ||
            (binding.allowReference &&
                (this.byReference === true ||
                    (this.byReference === "entry" && binding.entryLifetime)))
        );
    }
}
