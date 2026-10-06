import type ts from "typescript";
import { EmissionMap } from "./emission-transaction.js";

/** A property every plain record inherits: no record lacks it. */
const INHERITED_PROPERTIES = new Set(
    Object.getOwnPropertyNames(Object.prototype),
);

/** Any key: an open source whose keys a conversion cannot enumerate. */
export const UNKNOWN_PROPERTIES = "*";

/**
 * Properties a native record provably lacks. A struct stores every property
 * of the record types it stands for, so one none of them declares is absent
 * from each record it holds, and a read of it is `undefined` -- unless a
 * record of another type was converted into it: a conversion copies the
 * target's fields, while the JavaScript object keeps the source's other
 * properties. Reads that relied on absence are checked again once every
 * conversion is known.
 */
export class AbsentRecordProperties {
    /** Properties converted records carried beyond the target struct's fields, by target. */
    private readonly carried = new EmissionMap<string, readonly string[]>();
    /** Struct conversions: the source structs whose records reached each target. */
    private readonly sources = new EmissionMap<string, readonly string[]>();
    /** Reads answered `undefined` because a struct lacks the property, by `struct.property`. */
    private readonly reads = new EmissionMap<
        string,
        { struct: string; property: string; node: ts.Node }
    >();

    public constructor(
        private readonly fail: (node: ts.Node, message: string) => never,
    ) {}

    /** Whether a plain record can lack `property` at all. */
    public static omittable(property: string): boolean {
        return !INHERITED_PROPERTIES.has(property);
    }

    /**
     * A record converted into `target` carrying `extra` beyond its fields;
     * a converted struct also passes on what was carried into it.
     */
    public noteConversion(
        target: string,
        extra: readonly string[],
        source?: string,
    ): void {
        const carried = this.carried.get(target) ?? [];
        const added = extra.filter((property) => !carried.includes(property));
        if (added.length) this.carried.set(target, [...carried, ...added]);
        const sources = this.sources.get(target) ?? [];
        if (source !== undefined && !sources.includes(source))
            this.sources.set(target, [...sources, source]);
    }

    /** Records a read of `property`, absent from `struct`'s layout, as `undefined`. */
    public read(struct: string, property: string, node: ts.Node): void {
        this.refuseCarried(struct, property, node);
        this.reads.set(`${struct}.${property}`, { struct, property, node });
    }

    /** An absent read stays sound only if no conversion carried its property. */
    public check(): void {
        for (const { struct, property, node } of this.reads.values())
            this.refuseCarried(struct, property, node);
    }

    private refuseCarried(
        struct: string,
        property: string,
        node: ts.Node,
    ): void {
        const carried = this.carriedInto(struct);
        if (carried.has(property) || carried.has(UNKNOWN_PROPERTIES))
            this.fail(
                node,
                `Property '${property}' is not stored by '${struct}' records, but a record converted into that storage may carry it.`,
            );
    }

    /** Everything conversions carried into `struct`, directly or through converted structs. */
    private carriedInto(struct: string): ReadonlySet<string> {
        const result = new Set<string>();
        const visited = new Set<string>();
        const pending = [struct];
        for (
            let next = pending.pop();
            next !== undefined;
            next = pending.pop()
        ) {
            if (visited.has(next)) continue;
            visited.add(next);
            for (const property of this.carried.get(next) ?? [])
                result.add(property);
            pending.push(...(this.sources.get(next) ?? []));
        }
        return result;
    }
}
