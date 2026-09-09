import { EmissionSet } from "./emission-transaction.js";
import { cppIdentifiers } from "./cpp-identifiers.js";

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
    "engineCpp", "ownedEngineCpp", "optionalStorageCpp", "optionalFoundCpp", "truthinessCpp",
    "audioMainBusCpp", "spriteLayerCpp", "dynamicAssetPathCpp",
] as const;
export type NativeCompanionKey = typeof nativeCompanionKeys[number];

export interface CapturedClosure {
    lines: string[];
    environment: string;
    initializer: string;
    nativeCaptures: readonly NativeCaptureBinding[];
}

export function renderClosure(closure: CapturedClosure, parameters: string, returnType?: string): string {
    return `bbl::js::make_closure(${closure.initializer}, []([[maybe_unused]] decltype(${closure.initializer})& ${closure.environment}${parameters ? `, ${parameters}` : ""})${returnType ? ` -> ${returnType}` : ""} {\n` +
        closure.lines.map((line) => `            ${line}`).join("\n") + "\n        })";
}

/** Named aliases preserve all companion expressions while the typed environment
 * exposes the actual owning captures, including mutable cells, to the GC. */
export class ClosureCaptures {
    private readonly bindings = new EmissionSet<NativeCaptureBinding>();
    constructor(readonly environment: string, readonly boundary: number, private readonly byReference: boolean | "entry" = false) {}

    use(binding: NativeCaptureBinding): void {
        if (binding.sequence <= this.boundary) this.bindings.add(binding);
    }

    retainReferenced(lines: readonly string[]): void {
        const identifiers = cppIdentifiers(lines.join("\n"));
        for (const binding of this.bindings) {
            if (!identifiers.has(binding.name)) this.bindings.delete(binding);
        }
    }

    get initializer(): string {
        return `std::tuple{${[...this.bindings].map((binding) =>
            this.borrows(binding) ? `std::ref(${binding.name})` : binding.name).join(", ")}}`;
    }

    get nativeCaptures(): readonly NativeCaptureBinding[] { return [...this.bindings]; }

    get declarations(): string[] {
        return [...this.bindings].map((binding, index) =>
            `auto& ${binding.name} = std::get<${index}>(${this.environment})${this.borrows(binding) ? ".get()" : ""};`);
    }

    private borrows(binding: NativeCaptureBinding): boolean {
        return binding.borrowed || (binding.allowReference &&
            (this.byReference === true || (this.byReference === "entry" && binding.entryLifetime)));
    }
}
