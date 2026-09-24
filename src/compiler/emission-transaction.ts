/**
 * Speculative emission: a probe either commits or leaves no trace.
 *
 * Every piece of compiler state a probe may write lives in a journaled
 * container -- `EmissionMap`, `EmissionSet`, `emissionArray`,
 * `emissionRecord`, `EmissionWeakMap`, `EmissionWeakSet`, a `@journaled`
 * accessor field, or a record written through `writable()`. While a
 * transaction is open each write appends its undo entry to one journal; a
 * transaction is a mark in that journal, and a rollback replays the entries
 * above its mark in reverse. Opening a transaction copies nothing, and a
 * plain object or array that is not written through one of these is not
 * rolled back.
 */
type Undo = () => void;

/** Undo entries of every open transaction, oldest first. */
const journal: Undo[] = [];
/** Open transactions, innermost last. */
const open: EmissionTransaction[] = [];
let nextTransaction = 1;

/** Transactions opened and declined, undo entries journaled and replayed. */
export interface EmissionTransactionStatistics {
    transactions: number;
    rollbacks: number;
    journaledWrites: number;
    undoneWrites: number;
}

const statistics: EmissionTransactionStatistics = {
    transactions: 0,
    rollbacks: 0,
    journaledWrites: 0,
    undoneWrites: 0,
};

export function emissionTransactionStatistics(): EmissionTransactionStatistics {
    return { ...statistics };
}

/** The innermost open transaction's id; 0 outside every transaction. */
function innermost(): number {
    return open.length === 0 ? 0 : open[open.length - 1]!.id;
}

/**
 * Whether a write to a container created during transaction `born` needs an
 * undo entry: only a transaction opened after the container existed can
 * roll back to a state that still reaches it.
 */
function journaling(born: number): boolean {
    return innermost() > born;
}

function record(undo: Undo): void {
    journal.push(undo);
    ++statistics.journaledWrites;
}

/** A mark in the journal: rollback undoes every write made since. */
export class EmissionTransaction {
    public readonly id = nextTransaction++;
    private readonly mark = journal.length;
    private closed = false;

    public constructor() {
        ++statistics.transactions;
        open.push(this);
    }

    public finish(commit: boolean): void {
        if (this.closed || open.at(-1) !== this)
            throw new Error("Emission transactions must close in order.");
        open.pop();
        this.closed = true;
        if (commit) {
            // Only an enclosing transaction can still roll these writes back.
            if (open.length === 0) journal.length = 0;
            return;
        }
        ++statistics.rollbacks;
        statistics.undoneWrites += journal.length - this.mark;
        for (let index = journal.length - 1; index >= this.mark; --index)
            journal[index]!();
        journal.length = this.mark;
    }

    public run<T>(probe: () => T, answered: (result: T) => boolean): T {
        let commit = false;
        try {
            const result = probe();
            commit = answered(result);
            return result;
        } finally {
            this.finish(commit);
        }
    }
}

/**
 * Restore an object's own properties to a snapshot, key order included:
 * iteration order is output order.
 */
function restoreProperties(
    target: object,
    keys: readonly PropertyKey[],
    descriptors: readonly PropertyDescriptor[],
): void {
    const current = Reflect.ownKeys(target);
    if (
        current.length !== keys.length ||
        current.some((key, index) => key !== keys[index])
    )
        for (const key of current) Reflect.deleteProperty(target, key);
    for (let index = 0; index < keys.length; ++index)
        Reflect.defineProperty(target, keys[index]!, descriptors[index]!);
}

function snapshotProperties(target: object): Undo {
    const keys = Reflect.ownKeys(target);
    const descriptors = keys.map((key) =>
        Reflect.getOwnPropertyDescriptor(target, key)!,
    );
    return () => restoreProperties(target, keys, descriptors);
}

/** The transaction whose undo entry already restores a record's every property. */
const snapshotIn = new WeakMap<object, number>();

/**
 * A compiler record or array about to be written in place: journals its own
 * properties once per transaction, then returns it writable. Compiler state
 * types are readonly so every in-place write names this.
 */
export function writable<T extends object>(target: T): Mutable<T> {
    const current = innermost();
    if (current !== 0 && snapshotIn.get(target) !== current) {
        snapshotIn.set(target, current);
        record(snapshotProperties(target));
    }
    return target as Mutable<T>;
}

/** The writable view `writable()` returns. */
export type Mutable<T> =
    T extends ReadonlyArray<infer E> ? E[] : { -readonly [K in keyof T]: T[K] };

/**
 * A class field whose writes are journaled:
 * `@journaled private accessor count = 0`.
 */
export function journaled<This extends object, V>(
    target: ClassAccessorDecoratorTarget<This, V>,
): ClassAccessorDecoratorResult<This, V> {
    return {
        set(this: This, value: V): void {
            if (open.length > 0) {
                const previous = target.get.call(this);
                if (!Object.is(previous, value))
                    record(() => target.set.call(this, previous));
            }
            target.set.call(this, value);
        },
    };
}

/**
 * A map whose writes are journaled: a set undoes by entry, a delete or clear
 * by the entries it had.
 */
export class EmissionMap<K, V> extends Map<K, V> {
    readonly #born = innermost();
    #restoredBy = 0;

    public constructor(entries?: Iterable<readonly [K, V]> | null) {
        super();
        for (const [key, value] of entries ?? []) super.set(key, value);
    }

    public override set(key: K, value: V): this {
        if (journaling(this.#born) && this.#restoredBy !== innermost()) {
            if (super.has(key)) {
                const previous = super.get(key) as V;
                if (!Object.is(previous, value))
                    record(() => {
                        super.set(key, previous);
                    });
            } else
                record(() => {
                    super.delete(key);
                });
        }
        return super.set(key, value);
    }

    public override delete(key: K): boolean {
        if (super.has(key)) this.#snapshot();
        return super.delete(key);
    }

    public override clear(): void {
        if (this.size > 0) this.#snapshot();
        super.clear();
    }

    /** Iteration order is output order: a removal restores every entry. */
    #snapshot(): void {
        if (!journaling(this.#born) || this.#restoredBy === innermost()) return;
        this.#restoredBy = innermost();
        const entries = [...super.entries()];
        record(() => {
            super.clear();
            for (const [key, value] of entries) super.set(key, value);
        });
    }
}

/** A set whose writes are journaled, like `EmissionMap`. */
export class EmissionSet<T> extends Set<T> {
    readonly #born = innermost();
    #restoredBy = 0;

    public constructor(values?: Iterable<T> | null) {
        super();
        for (const value of values ?? []) super.add(value);
    }

    public override add(value: T): this {
        if (
            journaling(this.#born) &&
            this.#restoredBy !== innermost() &&
            !super.has(value)
        )
            record(() => {
                super.delete(value);
            });
        return super.add(value);
    }

    public override delete(value: T): boolean {
        if (super.has(value)) this.#snapshot();
        return super.delete(value);
    }

    public override clear(): void {
        if (this.size > 0) this.#snapshot();
        super.clear();
    }

    #snapshot(): void {
        if (!journaling(this.#born) || this.#restoredBy === innermost()) return;
        this.#restoredBy = innermost();
        const values = [...super.values()];
        record(() => {
            super.clear();
            for (const value of values) super.add(value);
        });
    }
}

/** Journal one own property of `target` before it changes. */
function recordProperty(target: object, key: PropertyKey): void {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    record(() => {
        if (descriptor) Reflect.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
    });
}

/** Whether a write of `value` to `key` would leave the property as it is. */
function unchanged(target: object, key: PropertyKey, value: unknown): boolean {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    return (
        descriptor !== undefined &&
        "value" in descriptor &&
        Object.is(descriptor.value, value)
    );
}

/** Journal one slot of `target` and its length before the slot changes. */
function recordSlot(target: unknown[], key: PropertyKey): void {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    const length = target.length;
    record(() => {
        if (descriptor) Reflect.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
        target.length = length;
    });
}

/** Array index and length writes journal only the slots they change. */
export function emissionArray<T>(values: T[] = []): T[] {
    const born = innermost();
    /** A shrinking length removes the slots past it. */
    const truncate = (target: T[], length: unknown): void => {
        if (typeof length === "number")
            for (let index = length; index < target.length; ++index)
                recordSlot(target, String(index));
    };
    return new Proxy(values, {
        set(target, key, value: unknown) {
            if (journaling(born) && !unchanged(target, key, value)) {
                if (key === "length") truncate(target, value);
                recordSlot(target, key);
            }
            return Reflect.set(target, key, value, target);
        },
        deleteProperty(target, key) {
            if (journaling(born) && Object.hasOwn(target, key))
                recordSlot(target, key);
            return Reflect.deleteProperty(target, key);
        },
        defineProperty(target, key, descriptor) {
            if (journaling(born)) {
                if (key === "length") truncate(target, descriptor.value);
                recordSlot(target, key);
            }
            return Reflect.defineProperty(target, key, descriptor);
        },
    });
}

/**
 * A plain record whose property writes are journaled by key; a deleted key
 * returns to its place in the key order.
 */
export function emissionRecord<T extends object>(value: T): T {
    const born = innermost();
    return new Proxy(value, {
        set(target, key, next: unknown) {
            if (journaling(born) && !unchanged(target, key, next))
                recordProperty(target, key);
            return Reflect.set(target, key, next, target);
        },
        deleteProperty(target, key) {
            if (journaling(born) && Object.hasOwn(target, key))
                record(snapshotProperties(target));
            return Reflect.deleteProperty(target, key);
        },
        defineProperty(target, key, descriptor) {
            if (journaling(born)) recordProperty(target, key);
            return Reflect.defineProperty(target, key, descriptor);
        },
    });
}

/** Weak entries journal their previous entry. */
export class EmissionWeakMap<K extends WeakKey, V> extends WeakMap<K, V> {
    readonly #born = innermost();

    public constructor(entries?: Iterable<readonly [K, V]> | null) {
        super();
        for (const [key, value] of entries ?? []) super.set(key, value);
    }

    public override set(key: K, value: V): this {
        if (journaling(this.#born)) {
            if (super.has(key)) {
                const previous = super.get(key) as V;
                if (!Object.is(previous, value))
                    record(() => {
                        super.set(key, previous);
                    });
            } else
                record(() => {
                    super.delete(key);
                });
        }
        return super.set(key, value);
    }

    public override delete(key: K): boolean {
        if (journaling(this.#born) && super.has(key)) {
            const previous = super.get(key) as V;
            record(() => {
                super.set(key, previous);
            });
        }
        return super.delete(key);
    }
}

export class EmissionWeakSet<K extends WeakKey> extends WeakSet<K> {
    readonly #born = innermost();

    public constructor(keys?: Iterable<K> | null) {
        super();
        for (const key of keys ?? []) super.add(key);
    }

    public override add(key: K): this {
        if (journaling(this.#born) && !super.has(key))
            record(() => {
                super.delete(key);
            });
        return super.add(key);
    }

    public override delete(key: K): boolean {
        if (journaling(this.#born) && super.has(key))
            record(() => {
                super.add(key);
            });
        return super.delete(key);
    }
}
