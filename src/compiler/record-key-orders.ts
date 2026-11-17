import type ts from "typescript";
import {
    EmissionMap,
    EmissionSet,
    emissionArray,
} from "./emission-transaction.js";
import { StorageDemand } from "./storage-demand.js";
import type { StorageRequest } from "./replay-storage.js";
import { keyIndex, sameKeys } from "./syntax.js";

/**
 * `keys` as the own keys of one object that creates them in this order:
 * array indices ascending, then the others in the order each was first
 * created (a key written again keeps its place).
 */
export function ownKeyOrder(keys: Iterable<string>): string[] {
    return Object.keys(
        Object.fromEntries([...keys].map((key) => [key, undefined])),
    );
}

/** The key orders records take, each a list of their own keys. */
export type KeyOrders = readonly (readonly string[])[];

/**
 * The one order of `base`'s keys every order of `orders` agrees with,
 * each key otherwise where `base` puts it, as an object's own keys
 * (`ownKeyOrder`); undefined where two orders disagree.
 */
export function agreedKeyOrder(
    orders: KeyOrders,
    base: readonly string[],
): string[] | undefined {
    const position = new Map(base.map((key, index) => [key, index]));
    const after = new Map(base.map((key) => [key, new Set<string>()]));
    const before = new Map(base.map((key) => [key, 0]));
    for (const order of orders) {
        const known = order.filter((key) => position.has(key));
        for (let index = 1; index < known.length; index++) {
            const followers = after.get(known[index - 1]!)!;
            if (followers.has(known[index]!)) continue;
            followers.add(known[index]!);
            before.set(known[index]!, before.get(known[index]!)! + 1);
        }
    }
    const agreed: string[] = [];
    const ready = base.filter((key) => before.get(key) === 0);
    while (ready.length > 0) {
        ready.sort((left, right) => position.get(left)! - position.get(right)!);
        const key = ready.shift()!;
        agreed.push(key);
        for (const follower of after.get(key)!) {
            const remaining = before.get(follower)! - 1;
            before.set(follower, remaining);
            if (remaining === 0) ready.push(follower);
        }
    }
    return agreed.length === base.length ? ownKeyOrder(agreed) : undefined;
}

/** What one creation of a record makes own, in creation order (`RecordKeyOrders`). */
export type CreatedKeys =
    /** A key the creation writes; `maybe` where it is own only at run time (a conditional spread's). */
    | { readonly key: string; readonly maybe?: true }
    /**
     * The own keys of a record of struct `struct`, in that record's order: a
     * spread or a conversion. `maybe` where no record may be there at all.
     */
    | { readonly struct: string; readonly maybe?: true }
    /** A key only the run time names (a computed key a tag selects). */
    | { readonly unordered: true };

/** One field of a struct's layout: its key, and whether a record may lack it. */
interface LayoutKey {
    readonly key: string;
    readonly maybe: boolean;
}

/** A struct's fields in layout order; undefined for a name no struct has. */
type Layout = (struct: string) => readonly LayoutKey[] | undefined;

/** The one order a struct's records' keys agree on, or "varies" where their orders differ. */
type Agreed = readonly string[] | "varies";

/** A struct's agreed order and the orders its creations give its records. */
interface Agreement {
    readonly order: Agreed;
    readonly orders: KeyOrders;
}

/**
 * The own-key orders of native records. A struct enumerates its records'
 * own keys in its field order, while JavaScript orders each object's keys
 * as the object created them: a literal's keys as written, a spread's as
 * its source object has them, a key written again in its first place,
 * array indices first. Each creation of a struct's record is noted with
 * the keys it makes own; once every creation is known, an enumerated
 * struct whose layout is not the one order they all agree on is settled:
 * laid out in that order, or, where creations disagree, stored as objects
 * that keep their own order.
 */
export class RecordKeyOrders {
    /** Each struct's distinct creations, in the order each was first noted. */
    private readonly creations = new EmissionMap<
        string,
        (readonly CreatedKeys[])[]
    >();
    /** Every creation noted, spelled with its struct. */
    private readonly spellings = new EmissionSet<string>();
    /** Enumerated structs, with the first node enumerating each. */
    private readonly enumerations = new EmissionMap<string, ts.Node>();

    /** A record of `struct` created making `keys` own, in order. */
    public noteCreation(struct: string, keys: readonly CreatedKeys[]): void {
        const spelled = JSON.stringify([struct, keys]);
        if (this.spellings.has(spelled)) return;
        this.spellings.add(spelled);
        const known = this.creations.get(struct);
        if (known) known.push(keys);
        else this.creations.set(struct, emissionArray([keys]));
    }

    /** `struct`'s own keys are enumerated in its field order. */
    public noteEnumeration(struct: string, node: ts.Node): void {
        if (!this.enumerations.has(struct)) this.enumerations.set(struct, node);
    }

    /**
     * Settles every enumerated struct `layout` lays out (in field order)
     * whose layout is not the one order its records' own keys agree on:
     * `settle` receives the orders they take, or undefined where they
     * differ from record to record.
     */
    public check(
        layout: Layout,
        settle: (
            struct: string,
            orders: KeyOrders | undefined,
            node: ts.Node,
        ) => void,
    ): void {
        const layouts = new Map<string, readonly LayoutKey[] | undefined>();
        const laidOut: Layout = (struct) => {
            if (!layouts.has(struct)) layouts.set(struct, layout(struct));
            return layouts.get(struct);
        };
        // The enumerated structs and every struct their records take keys from.
        const involved = new Set<string>();
        const visit = (struct: string): void => {
            if (involved.has(struct) || !laidOut(struct)) return;
            involved.add(struct);
            for (const created of this.creations.get(struct) ?? [])
                for (const item of created)
                    if ("struct" in item) visit(item.struct);
        };
        for (const struct of this.enumerations.keys()) visit(struct);
        const agreements = this.agree(involved, laidOut);
        for (const [struct, node] of this.enumerations) {
            const keys = laidOut(struct);
            const agreement = agreements.get(struct);
            if (!keys || !agreement) continue;
            if (agreement.order === "varies") settle(struct, undefined, node);
            else if (
                agreement.order.some((key, index) => key !== keys[index]!.key)
            )
                settle(struct, agreement.orders, node);
        }
    }

    /**
     * Each struct's agreement. A record takes keys from records of other
     * structs (a spread, a conversion, even of its own struct), so orders
     * are searched for together: each struct agrees on the orders of the
     * creations whose sources have an order so far, until none changes;
     * then each still without one takes its layout's, and the search goes
     * on. The orders found are then checked against every creation: a
     * struct varies where a creation's order varies or the orders disagree,
     * and so does every struct taking keys from it. One still changing
     * after as many rounds as its keys can take varies.
     */
    private agree(
        structs: ReadonlySet<string>,
        layout: Layout,
    ): ReadonlyMap<string, Agreement> {
        const bases = new Map(
            [...structs].map((struct) => [
                struct,
                layout(struct)!.map(({ key }) => key),
            ]),
        );
        const base = (struct: string): string[] => bases.get(struct)!;
        const bound =
            structs.size *
            (Math.max(0, ...[...bases.values()].map((keys) => keys.length)) +
                1);
        // The structs whose creations take keys from each one.
        const dependents = new Map<string, Set<string>>();
        for (const struct of structs)
            for (const created of this.creations.get(struct) ?? [])
                for (const item of created)
                    if ("struct" in item && structs.has(item.struct)) {
                        const readers = dependents.get(item.struct);
                        if (readers) readers.add(struct);
                        else dependents.set(item.struct, new Set([struct]));
                    }
        // Rounds over the structs in order while one changes and `more`
        // allows: a struct is evaluated again only after an order it reads
        // changed, which otherwise leaves its answer as it was.
        const rounds = (
            evaluate: (struct: string, round: number) => boolean,
            more: (round: number) => boolean,
        ): void => {
            const stale = new Set(structs);
            for (
                let round = 0, changed = true;
                changed && more(round);
                round++
            ) {
                changed = false;
                for (const struct of structs) {
                    if (!stale.delete(struct) || !evaluate(struct, round))
                        continue;
                    changed = true;
                    for (const reader of dependents.get(struct) ?? [])
                        stale.add(reader);
                }
            }
        };
        // The orders a struct's creations give its records from their
        // sources' orders, and whether one varies.
        const give = (
            struct: string,
            source: (struct: string) => Agreed | undefined,
        ): { orders: string[][]; varies: boolean } => {
            const orders: string[][] = [];
            let varies = false;
            for (const created of this.creations.get(struct) ?? []) {
                const made = this.created(
                    struct,
                    created,
                    layout(struct)!,
                    layout,
                    source,
                );
                if (made === "varies") varies = true;
                else if (made) orders.push(made);
            }
            return { orders, varies };
        };
        const found = new Map<string, readonly string[]>();
        const search = (): void =>
            rounds(
                (struct) => {
                    const { orders } = give(struct, (source) =>
                        structs.has(source) ? found.get(source) : "varies",
                    );
                    if (orders.length === 0 && this.creations.has(struct))
                        return false;
                    const order = agreedKeyOrder(orders, base(struct));
                    const known = found.get(struct);
                    if (!order || (known && sameAgreed(known, order)))
                        return false;
                    found.set(struct, order);
                    return true;
                },
                (round) => round <= bound,
            );
        search();
        for (const struct of structs)
            if (!found.has(struct))
                found.set(struct, ownKeyOrder(base(struct)));
        search();
        const agreements = new Map<string, Agreement>(
            [...structs].map((struct) => [
                struct,
                { order: found.get(struct)!, orders: [] },
            ]),
        );
        rounds(
            (struct, round) => {
                const known = agreements.get(struct)!;
                if (known.order === "varies") return false;
                const { orders, varies } = give(
                    struct,
                    (source) => agreements.get(source)?.order ?? "varies",
                );
                const order =
                    (varies
                        ? undefined
                        : agreedKeyOrder(orders, base(struct))) ?? "varies";
                const settled =
                    round > bound && !sameAgreed(known.order, order)
                        ? "varies"
                        : order;
                agreements.set(struct, { order: settled, orders });
                return !sameAgreed(known.order, settled);
            },
            () => true,
        );
        return agreements;
    }

    /**
     * The order of the keys a creation of a `struct` record makes own, of
     * those `keys` lays out, its sources' records in the order `source`
     * gives them; undefined while a source has none yet. It varies where a
     * source's order varies, or where a key the creation may have made own
     * is written again after other keys (absent, it is created last); a
     * record of `struct` itself may lack such a key only where its order
     * can put it last: this creation puts it there.
     */
    private created(
        struct: string,
        created: readonly CreatedKeys[],
        keys: readonly LayoutKey[],
        layout: Layout,
        source: (struct: string) => Agreed | undefined,
    ): string[] | "varies" | undefined {
        const stored = new Set(keys.map(({ key }) => key));
        const made: { key: string; maybe: boolean; own: boolean }[] = [];
        for (const item of created) {
            if ("unordered" in item) return "varies";
            const own = "struct" in item && item.struct === struct;
            let written: { key: string; maybe: boolean }[];
            if ("key" in item)
                written = [{ key: item.key, maybe: item.maybe === true }];
            else {
                const order = source(item.struct);
                const fields = layout(item.struct);
                if (order === undefined) return undefined;
                if (order === "varies" || !fields) return "varies";
                const lacks = new Map(
                    fields.map(({ key, maybe }) => [key, maybe]),
                );
                written = order.map((key) => ({
                    key,
                    maybe: item.maybe === true || lacks.get(key) === true,
                }));
            }
            for (const { key, maybe } of written) {
                if (!stored.has(key)) continue;
                const index = made.findIndex((known) => known.key === key);
                if (index < 0) {
                    made.push({ key, maybe, own });
                    continue;
                }
                const known = made[index]!;
                if (!known.maybe) continue;
                if (
                    keyIndex(key) === undefined &&
                    made
                        .slice(index + 1)
                        .some((later) => keyIndex(later.key) === undefined)
                ) {
                    if (!known.own) return "varies";
                    made.splice(index, 1);
                    made.push({ key, maybe, own: false });
                    continue;
                }
                made[index] = { key, maybe, own: known.own };
            }
        }
        return ownKeyOrder(made.map(({ key }) => key));
    }
}

/** Whether two agreements are the same order, or both vary. */
function sameAgreed(left: Agreed, right: Agreed): boolean {
    return left === "varies" || right === "varies"
        ? left === right
        : sameKeys(left, right);
}

/**
 * An enumerated record type whose struct does not lay its fields out in
 * the order its records create their keys: the compile replays with the
 * struct laid out in the order `orders` agree on (`agreedKeyOrder`).
 */
export class RecordKeyOrderRequired extends StorageDemand {
    constructor(
        readonly record: ts.Symbol | ts.Type,
        readonly orders: KeyOrders,
    ) {
        super(
            "An enumerated record's struct lays its fields out in the order its records create their keys.",
        );
    }

    get request(): StorageRequest {
        return { kind: "key-order", record: this.record, orders: this.orders };
    }
}
