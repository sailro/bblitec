import { emissionMutationVersion } from "./emission-transaction.js";
import {
    nativeCompanionKeys,
    type NativeCaptureBinding,
} from "./closure-captures.js";
import type { Value } from "./types.js";

/** Captures follow the current value graph, including rolled-back mutations. */
export class NativeCaptureCache {
    constructor(
        private readonly nativeBindings: ReadonlyMap<
            string,
            NativeCaptureBinding
        >,
    ) {}
    /** @unjournaled Derived entries validate every dependency revision and binding before reuse. */
    private readonly entries = new WeakMap<
        Value,
        {
            bindings: readonly NativeCaptureBinding[];
            objects: readonly { value: object; version: number }[];
            names: readonly {
                name: string;
                binding: NativeCaptureBinding | undefined;
            }[];
        }
    >();

    public bindingsOf(value: Value): readonly NativeCaptureBinding[] {
        let captured = this.entries.get(value);
        if (
            !captured ||
            captured.objects.some(
                (entry) =>
                    emissionMutationVersion(entry.value) !== entry.version,
            ) ||
            captured.names.some(
                (entry) =>
                    this.nativeBindings.get(entry.name) !== entry.binding,
            )
        ) {
            const bindings = new Set<NativeCaptureBinding>();
            const seen = new Set<Value>();
            const objects = new Map<object, number>();
            const names = new Map<string, NativeCaptureBinding | undefined>();
            const observe = (object: object | undefined): void => {
                if (object && !objects.has(object))
                    objects.set(object, emissionMutationVersion(object));
            };
            const captures = (
                items: readonly NativeCaptureBinding[] | undefined,
            ): void => {
                observe(items);
                for (const binding of items ?? []) bindings.add(binding);
            };
            const named = (name: string): void => {
                const binding = this.nativeBindings.get(name);
                names.set(name, binding);
                if (binding) bindings.add(binding);
            };
            const collect = (current: Value): void => {
                if (seen.has(current)) return;
                seen.add(current);
                observe(current);
                if (current.kind !== "record" && current.kind !== "tuple") {
                    captures(current.nativeCaptures);
                    named(current.cpp);
                }
                observe(current.nativeCompanionCaptures);
                for (const key of nativeCompanionKeys) {
                    const companion = current[key];
                    if (companion === undefined) continue;
                    const dependencies = current.nativeCompanionCaptures?.[key];
                    if (dependencies) captures(dependencies);
                    else named(companion);
                }
                if (current.kind === "record") {
                    observe(current.sceneNodeVector);
                    observe(current.cameraVector);
                    if (current.sceneNodeVector)
                        collect(current.sceneNodeVector.owner);
                    if (current.cameraVector)
                        collect(current.cameraVector.owner);
                    observe(current.recordProperties);
                    for (const field of Object.values(
                        current.recordProperties ?? {},
                    ))
                        collect(field);
                }
                if (current.kind === "tuple") {
                    observe(current.tupleElements);
                    for (const field of current.tupleElements ?? [])
                        collect(field);
                }
                observe(current.materialUboArrayFields);
                for (const expression of current.materialUboArrayFields?.values() ??
                    []) {
                    observe(expression);
                    captures(expression.nativeCaptures);
                }
            };
            collect(value);
            captured = {
                bindings: [...bindings],
                objects: [...objects].map(([value, version]) => ({
                    value,
                    version,
                })),
                names: [...names].map(([name, binding]) => ({ name, binding })),
            };
            this.entries.set(value, captured);
        }
        return captured.bindings;
    }
}
