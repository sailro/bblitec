import { EmissionSet } from "./emission-transaction.js";
import { cppIdentifiers } from "./cpp-identifiers.js";
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
    "optionalStorageCpp",
    "optionalFoundCpp",
    "truthinessCpp",
    "audioMainBusCpp",
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

/** Named aliases preserve all companion expressions while the typed environment
 * exposes the actual owning captures, including mutable cells, to the GC. */
export class ClosureCaptures {
    private readonly bindings = new EmissionSet<NativeCaptureBinding>();
    constructor(
        readonly environment: string,
        readonly boundary: number,
        private readonly byReference: boolean | "entry" = false,
        private readonly bindingType?: (
            binding: NativeCaptureBinding,
        ) => string | undefined,
    ) {}

    use(binding: NativeCaptureBinding): void {
        if (binding.sequence <= this.boundary) this.bindings.add(binding);
    }

    retainReferenced(lines: readonly string[]): ReadonlySet<string> {
        const identifiers = cppIdentifiers(lines.join("\n"));
        for (const binding of this.bindings) {
            if (!identifiers.has(binding.name)) this.bindings.delete(binding);
        }
        return identifiers;
    }

    get initializer(): string {
        return `std::tuple{${[...this.bindings]
            .map((binding) =>
                this.borrows(binding)
                    ? `std::ref(${binding.name})`
                    : binding.name,
            )
            .join(", ")}}`;
    }

    get nativeCaptures(): readonly NativeCaptureBinding[] {
        return [...this.bindings];
    }

    get environmentType(): string | undefined {
        const types: string[] = [];
        for (const binding of this.bindings) {
            const type = this.bindingType?.(binding);
            if (!type) return undefined;
            types.push(
                this.borrows(binding)
                    ? `std::reference_wrapper<${type}>`
                    : `std::decay_t<${type}>`,
            );
        }
        return `std::tuple<${types.join(", ")}>`;
    }

    get declarations(): string[] {
        return [...this.bindings].map(
            (binding, index) =>
                `auto& ${binding.name} = std::get<${index}>(${this.environment})${this.borrows(binding) ? ".get()" : ""};`,
        );
    }

    private borrows(binding: NativeCaptureBinding): boolean {
        return (
            binding.borrowed ||
            (binding.allowReference &&
                (this.byReference === true ||
                    (this.byReference === "entry" && binding.entryLifetime)))
        );
    }
}
