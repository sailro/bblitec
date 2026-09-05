/** An emitted native binding, shared by every expression that reads it. */
export interface NativeCaptureBinding {
    readonly name: string;
    readonly sequence: number;
    readonly borrowed: boolean;
    readonly allowReference: boolean;
}

export const nativeCompanionKeys = [
    "engineCpp", "optionalStorageCpp", "optionalFoundCpp", "truthinessCpp", "wholeTypedArrayBackingCpp",
    "audioMainBusCpp", "spriteLayerCpp", "dynamicAssetPathCpp",
] as const;
export type NativeCompanionKey = typeof nativeCompanionKeys[number];

export interface CapturedClosure {
    lines: string[];
    environment: string;
    initializer: string;
}

export function renderClosure(closure: CapturedClosure, parameters: string, returnType?: string): string {
    return `bbl::js::make_closure(${closure.initializer}, []([[maybe_unused]] auto& ${closure.environment}${parameters ? `, ${parameters}` : ""})${returnType ? ` -> ${returnType}` : ""} {\n` +
        closure.lines.map((line) => `            ${line}`).join("\n") + "\n        })";
}

/** Named aliases preserve all companion expressions while the typed environment
 * exposes the actual owning captures, including mutable cells, to the GC. */
export class ClosureCaptures {
    private readonly bindings = new Set<NativeCaptureBinding>();
    constructor(readonly environment: string, readonly boundary: number, private readonly byReference = false) {}

    use(binding: NativeCaptureBinding): void {
        if (binding.sequence <= this.boundary) this.bindings.add(binding);
    }

    get initializer(): string {
        return `std::tuple{${[...this.bindings].map((binding) =>
            this.borrows(binding) ? `std::ref(${binding.name})` : binding.name).join(", ")}}`;
    }

    get declarations(): string[] {
        return [...this.bindings].map((binding, index) =>
            `[[maybe_unused]] auto& ${binding.name} = std::get<${index}>(${this.environment})${this.borrows(binding) ? ".get()" : ""};`);
    }

    private borrows(binding: NativeCaptureBinding): boolean {
        return binding.borrowed || (this.byReference && binding.allowReference);
    }
}
