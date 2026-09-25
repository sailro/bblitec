/**
 * Speculative emission: a probe either commits or leaves no trace.
 *
 * Every piece of compiler state a probe may write lives in a journaled
 * container -- `EmissionMap`, `EmissionSet`, `emissionArray`,
 * `emissionRecord`, `EmissionWeakMap`, `EmissionWeakSet`, a `@journaled`
 * accessor field, or a record written through `writable()`. The first write
 * a transaction makes to one slot of one container saves that slot's
 * original in the transaction's record of the container; later writes to
 * the slot save nothing, an array slot past the array's length at the
 * transaction's start saves nothing, and a container created inside the
 * transaction records nothing for it. A commit folds each record into the
 * enclosing transaction's record of the same container, which keeps its
 * older originals; a rollback restores the records. What a transaction
 * holds is bounded by the distinct slots it wrote, not by how often it wrote
 * them. A plain object or array that is not written through one of these is
 * not rolled back.
 */

/** Revisions are allocated only for state observed by a derived cache. */
const mutationVersions = new WeakMap<object, number>();
const proxyTargets = new WeakMap<object, object>();

export function emissionMutationVersion(value: object): number {
    const target = proxyTargets.get(value) ?? value;
    let version = mutationVersions.get(target);
    if (version === undefined) mutationVersions.set(target, (version = 0));
    return version;
}

function changed(value: object): void {
    const version = mutationVersions.get(value);
    if (version !== undefined) mutationVersions.set(value, version + 1);
}

/** Transactions opened and declined, originals saved, containers restored. */
interface EmissionTransactionStatistics {
    transactions: number;
    rollbacks: number;
    journaledSlots: number;
    restoredContainers: number;
}

const statistics: EmissionTransactionStatistics = {
    transactions: 0,
    rollbacks: 0,
    journaledSlots: 0,
    restoredContainers: 0,
};

export function emissionTransactionStatistics(): EmissionTransactionStatistics {
    return { ...statistics };
}

/** A container that wrote in a transaction and settles with it. */
interface Participant {
    /** Restore the closing transaction's record, or keep it for `enclosing`. */
    settle(commit: boolean, enclosing: EmissionTransaction | undefined): void;
}

/** Open transactions, innermost last. */
const open: EmissionTransaction[] = [];
let nextTransaction = 1;

function innermost(): EmissionTransaction | undefined {
    return open[open.length - 1];
}

/** The innermost open transaction's id; 0 outside every transaction. */
function innermostId(): number {
    return innermost()?.id ?? 0;
}

/**
 * Whether a write to a container created during transaction `born` needs an
 * original: only a transaction opened after the container existed can roll
 * back to a state that still reaches it.
 */
function journaling(born: number): boolean {
    return innermostId() > born;
}

/** A transaction: its participants settle when it commits or rolls back. */
export class EmissionTransaction {
    public readonly id = nextTransaction++;
    private readonly participants: Participant[] = [];
    private closed = false;

    public constructor() {
        ++statistics.transactions;
        open.push(this);
    }

    /** A container's first write in this transaction. */
    public join(participant: Participant): void {
        this.participants.push(participant);
    }

    public finish(commit: boolean): void {
        if (this.closed || innermost() !== this)
            throw new Error("Emission transactions must close in order.");
        open.pop();
        this.closed = true;
        const enclosing = innermost();
        if (!commit) {
            ++statistics.rollbacks;
            statistics.restoredContainers += this.participants.length;
        }
        for (let index = this.participants.length - 1; index >= 0; --index)
            this.participants[index]!.settle(commit, enclosing);
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

/** What one open transaction saved of one container. */
interface Originals {
    transaction: EmissionTransaction;
}

/** One container's originals, one record per open transaction that wrote it, innermost last. */
class Journal<R extends Originals> implements Participant {
    private readonly records: R[] = [];

    public constructor(
        private readonly born: number,
        private readonly create: (transaction: EmissionTransaction) => R,
        private readonly restore: (record: R) => void,
        /** Keep in `older` the originals it lacks from a committed `newer`. */
        private readonly absorb: (older: R, newer: R) => void,
    ) {}

    /** The innermost transaction's record, created by its first write here. */
    public current(): R | undefined {
        const transaction = innermost();
        if (transaction === undefined || transaction.id <= this.born)
            return undefined;
        const top = this.records[this.records.length - 1];
        if (top !== undefined && top.transaction === transaction) return top;
        const record = this.create(transaction);
        this.records.push(record);
        transaction.join(this);
        return record;
    }

    public settle(
        commit: boolean,
        enclosing: EmissionTransaction | undefined,
    ): void {
        const record = this.records.pop()!;
        if (!commit) {
            this.restore(record);
            return;
        }
        // A container created inside the enclosing transaction needs no
        // record there; outside every transaction nothing is kept.
        if (enclosing === undefined || enclosing.id <= this.born) return;
        const older = this.records[this.records.length - 1];
        if (older !== undefined && older.transaction === enclosing) {
            this.absorb(older, record);
        } else {
            record.transaction = enclosing;
            this.records.push(record);
            enclosing.join(this);
        }
    }
}

/** A slot's value at a transaction's start: present with a value, or absent. */
type Original<V> = { readonly present: true; readonly value: V } | undefined;

interface KeyedOriginals<K, V> extends Originals {
    /** The originals of the keys written before `entries` was taken. */
    readonly saved: Map<K, Original<V>>;
    /**
     * Every entry at the first removal: iteration order is output order, and
     * a removed key cannot return to its place by key alone. Later writes
     * save nothing.
     */
    entries: (readonly [K, V])[] | undefined;
}

function adoptMissing<K, V>(older: Map<K, V>, newer: ReadonlyMap<K, V>): void {
    for (const [key, value] of newer)
        if (!older.has(key)) older.set(key, value);
}

function absorbKeyed<K, V>(
    older: KeyedOriginals<K, V>,
    newer: KeyedOriginals<K, V>,
): void {
    if (older.entries !== undefined) return;
    adoptMissing(older.saved, newer.saved);
    older.entries = newer.entries;
}

function saveOriginal<K, V>(
    saved: Map<K, Original<V>>,
    key: K,
    original: () => Original<V>,
): void {
    if (saved.has(key)) return;
    saved.set(key, original());
    ++statistics.journaledSlots;
}

/** A map whose writes are journaled by key. */
export class EmissionMap<K, V> extends Map<K, V> {
    readonly #born = innermostId();
    #journal: Journal<KeyedOriginals<K, V>> | undefined;

    public constructor(entries?: Iterable<readonly [K, V]> | null) {
        super();
        for (const [key, value] of entries ?? []) super.set(key, value);
    }

    #record(): KeyedOriginals<K, V> | undefined {
        if (!journaling(this.#born)) return undefined;
        this.#journal ??= new Journal<KeyedOriginals<K, V>>(
            this.#born,
            (transaction) => ({
                transaction,
                saved: new Map(),
                entries: undefined,
            }),
            (record) => {
                changed(this);
                if (record.entries === undefined) {
                    for (const [key, original] of record.saved) {
                        if (original) super.set(key, original.value);
                        else super.delete(key);
                    }
                    return;
                }
                super.clear();
                for (const [key, value] of record.entries) {
                    if (!record.saved.has(key)) super.set(key, value);
                    else {
                        const original = record.saved.get(key);
                        if (original) super.set(key, original.value);
                    }
                }
            },
            absorbKeyed,
        );
        return this.#journal.current();
    }

    public override set(key: K, value: V): this {
        const present = super.has(key);
        const previous = super.get(key);
        if (present && Object.is(previous, value)) return this;
        changed(this);
        if (!journaling(this.#born)) return super.set(key, value);
        const record = this.#record();
        if (record && record.entries === undefined)
            saveOriginal(record.saved, key, () =>
                // `has` answered presence; `get` returned the stored value.
                present ? { present, value: previous as V } : undefined,
            );
        return super.set(key, value);
    }

    public override delete(key: K): boolean {
        if (!super.has(key)) return false;
        changed(this);
        this.#snapshot();
        return super.delete(key);
    }

    public override clear(): void {
        if (this.size === 0) return;
        changed(this);
        this.#snapshot();
        super.clear();
    }

    #snapshot(): void {
        const record = this.#record();
        if (record && record.entries === undefined) {
            record.entries = [...super.entries()];
            ++statistics.journaledSlots;
        }
    }
}

interface SetOriginals<T> extends Originals {
    /** Values absent at the transaction's start, added before `entries`. */
    readonly added: Set<T>;
    entries: T[] | undefined;
}

/** A set whose writes are journaled by value, like `EmissionMap`. */
export class EmissionSet<T> extends Set<T> {
    readonly #born = innermostId();
    #journal: Journal<SetOriginals<T>> | undefined;

    public constructor(values?: Iterable<T> | null) {
        super();
        for (const value of values ?? []) super.add(value);
    }

    #record(): SetOriginals<T> | undefined {
        if (!journaling(this.#born)) return undefined;
        this.#journal ??= new Journal<SetOriginals<T>>(
            this.#born,
            (transaction) => ({
                transaction,
                added: new Set(),
                entries: undefined,
            }),
            (record) => {
                if (record.entries === undefined) {
                    for (const value of record.added) super.delete(value);
                    return;
                }
                super.clear();
                for (const value of record.entries)
                    if (!record.added.has(value)) super.add(value);
            },
            (older, newer) => {
                if (older.entries !== undefined) return;
                for (const value of newer.added) older.added.add(value);
                older.entries = newer.entries;
            },
        );
        return this.#journal.current();
    }

    public override add(value: T): this {
        if (super.has(value)) return this;
        const record = this.#record();
        if (record && record.entries === undefined) {
            record.added.add(value);
            ++statistics.journaledSlots;
        }
        return super.add(value);
    }

    public override delete(value: T): boolean {
        if (!super.has(value)) return false;
        this.#snapshot();
        return super.delete(value);
    }

    public override clear(): void {
        if (this.size === 0) return;
        this.#snapshot();
        super.clear();
    }

    #snapshot(): void {
        const record = this.#record();
        if (record && record.entries === undefined) {
            record.entries = [...super.values()];
            ++statistics.journaledSlots;
        }
    }
}

interface WeakOriginals<K extends WeakKey, V> extends Originals {
    readonly saved: Map<K, Original<V>>;
}

/** Weak entries journal their originals by key. */
export class EmissionWeakMap<K extends WeakKey, V> extends WeakMap<K, V> {
    readonly #born = innermostId();
    #journal: Journal<WeakOriginals<K, V>> | undefined;

    public constructor(entries?: Iterable<readonly [K, V]> | null) {
        super();
        for (const [key, value] of entries ?? []) super.set(key, value);
    }

    #save(key: K): void {
        if (!journaling(this.#born)) return;
        this.#journal ??= new Journal<WeakOriginals<K, V>>(
            this.#born,
            (transaction) => ({ transaction, saved: new Map() }),
            (record) => {
                for (const [key, original] of record.saved) {
                    if (original) super.set(key, original.value);
                    else super.delete(key);
                }
            },
            (older, newer) => adoptMissing(older.saved, newer.saved),
        );
        const record = this.#journal.current();
        if (record)
            saveOriginal(record.saved, key, () =>
                super.has(key)
                    ? { present: true, value: super.get(key) as V }
                    : undefined,
            );
    }

    public override set(key: K, value: V): this {
        if (!journaling(this.#born)) return super.set(key, value);
        if (super.has(key) && Object.is(super.get(key), value)) return this;
        this.#save(key);
        return super.set(key, value);
    }

    public override delete(key: K): boolean {
        if (!super.has(key)) return false;
        this.#save(key);
        return super.delete(key);
    }
}

interface WeakSetOriginals<K extends WeakKey> extends Originals {
    /** Whether each written key was present at the transaction's start. */
    readonly saved: Map<K, boolean>;
}

export class EmissionWeakSet<K extends WeakKey> extends WeakSet<K> {
    readonly #born = innermostId();
    #journal: Journal<WeakSetOriginals<K>> | undefined;

    public constructor(keys?: Iterable<K> | null) {
        super();
        for (const key of keys ?? []) super.add(key);
    }

    #save(key: K, present: boolean): void {
        if (!journaling(this.#born)) return;
        this.#journal ??= new Journal<WeakSetOriginals<K>>(
            this.#born,
            (transaction) => ({ transaction, saved: new Map() }),
            (record) => {
                for (const [key, present] of record.saved) {
                    if (present) super.add(key);
                    else super.delete(key);
                }
            },
            (older, newer) => adoptMissing(older.saved, newer.saved),
        );
        const record = this.#journal.current();
        if (record && !record.saved.has(key)) {
            record.saved.set(key, present);
            ++statistics.journaledSlots;
        }
    }

    public override add(key: K): this {
        if (super.has(key)) return this;
        this.#save(key, false);
        return super.add(key);
    }

    public override delete(key: K): boolean {
        if (!super.has(key)) return false;
        this.#save(key, true);
        return super.delete(key);
    }
}

interface ArrayOriginals extends Originals {
    /** The length at the transaction's start; later slots need no original. */
    readonly length: number;
    /** The written slots below `length`, and any other written key. */
    readonly saved: Map<PropertyKey, PropertyDescriptor | undefined>;
}

/** The array index `key` names, or undefined for another key. */
function arrayIndex(key: PropertyKey): number | undefined {
    if (typeof key !== "string") return undefined;
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && String(index) === key
        ? index
        : undefined;
}

/** Arrays journal only the slots below their starting length that a write changes. */
export function emissionArray<T>(values: T[] = []): T[] {
    const born = innermostId();
    let journal: Journal<ArrayOriginals> | undefined;
    const record = (): ArrayOriginals | undefined => {
        if (!journaling(born)) return undefined;
        journal ??= new Journal<ArrayOriginals>(
            born,
            (transaction) => ({
                transaction,
                length: values.length,
                saved: new Map(),
            }),
            (original) => {
                changed(values);
                values.length = original.length;
                for (const [key, descriptor] of original.saved) {
                    if (descriptor)
                        Reflect.defineProperty(values, key, descriptor);
                    else Reflect.deleteProperty(values, key);
                }
            },
            (older, newer) => {
                for (const [key, descriptor] of newer.saved) {
                    const index = arrayIndex(key);
                    if (
                        (index === undefined || index < older.length) &&
                        !older.saved.has(key)
                    )
                        older.saved.set(key, descriptor);
                }
            },
        );
        return journal.current();
    };
    const save = (original: ArrayOriginals, key: PropertyKey): void => {
        const index = arrayIndex(key);
        if (
            (index !== undefined && index >= original.length) ||
            original.saved.has(key)
        )
            return;
        original.saved.set(key, Reflect.getOwnPropertyDescriptor(values, key));
        ++statistics.journaledSlots;
    };
    /** A shrinking length removes the slots between it and the old length. */
    const write = (key: PropertyKey, length: unknown): void => {
        changed(values);
        const original = record();
        if (!original) return;
        if (key !== "length") {
            save(original, key);
            return;
        }
        if (typeof length === "number")
            for (
                let index = length;
                index < Math.min(values.length, original.length);
                ++index
            )
                save(original, String(index));
    };
    const proxy = registerContainer(
        new Proxy(values, {
            set(target, key, value: unknown) {
                const current = Reflect.getOwnPropertyDescriptor(target, key);
                if (
                    !current ||
                    !("value" in current) ||
                    !Object.is(current.value, value)
                )
                    write(key, value);
                return Reflect.set(target, key, value, target);
            },
            deleteProperty(target, key) {
                if (Object.hasOwn(target, key)) write(key, undefined);
                return Reflect.deleteProperty(target, key);
            },
            defineProperty(target, key, descriptor) {
                write(key, descriptor.value);
                return Reflect.defineProperty(target, key, descriptor);
            },
        }),
    );
    proxyTargets.set(proxy, values);
    return proxy;
}

interface PropertyOriginals extends Originals {
    readonly keys: readonly PropertyKey[];
    readonly descriptors: readonly PropertyDescriptor[];
}

function sameDescriptor(
    current: PropertyDescriptor,
    captured: PropertyDescriptor,
): boolean {
    return (
        current.enumerable === captured.enumerable &&
        current.configurable === captured.configurable &&
        ("value" in captured
            ? current.writable === captured.writable &&
              Object.is(current.value, captured.value)
            : current.get === captured.get && current.set === captured.set)
    );
}

/**
 * Restore an object's own properties, key order included: iteration order is
 * output order. Unchanged properties are left alone.
 */
function restoreProperties(target: object, original: PropertyOriginals): void {
    changed(target);
    const { keys, descriptors } = original;
    const current = Reflect.ownKeys(target);
    const reordered =
        current.length !== keys.length ||
        current.some((key, index) => key !== keys[index]);
    if (reordered)
        for (const key of current) Reflect.deleteProperty(target, key);
    for (let index = 0; index < keys.length; ++index) {
        const key = keys[index]!,
            descriptor = descriptors[index]!;
        if (
            reordered ||
            !sameDescriptor(
                Reflect.getOwnPropertyDescriptor(target, key)!,
                descriptor,
            )
        )
            Reflect.defineProperty(target, key, descriptor);
    }
}

/** Each record's snapshot journal: its whole property list, once per transaction. */
const snapshots = new WeakMap<object, Journal<PropertyOriginals>>();

function snapshotBeforeWrite(target: object, born: number): void {
    changed(target);
    if (!journaling(born)) return;
    let journal = snapshots.get(target);
    if (!journal) {
        journal = new Journal<PropertyOriginals>(
            born,
            (transaction) => {
                const keys = Reflect.ownKeys(target);
                ++statistics.journaledSlots;
                return {
                    transaction,
                    keys,
                    descriptors: keys.map((key) =>
                        Reflect.getOwnPropertyDescriptor(target, key)!,
                    ),
                };
            },
            (original) => restoreProperties(target, original),
            () => {},
        );
        snapshots.set(target, journal);
    }
    journal.current();
}

/** Containers that journal their own writes; `writable()` refuses them. */
const containers = new WeakSet<object>();

function registerContainer<T extends object>(container: T): T {
    containers.add(container);
    return container;
}

/**
 * A compiler record or array about to be written in place: journals its own
 * properties once per transaction, then returns it writable. Compiler state
 * types are readonly so every in-place write names this.
 */
export function writable<T extends object>(target: T): Mutable<T> {
    if (open.length > 0) {
        if (
            containers.has(target) ||
            target instanceof EmissionMap ||
            target instanceof EmissionSet ||
            target instanceof EmissionWeakMap ||
            target instanceof EmissionWeakSet
        )
            throw new Error(
                "writable() names a journaled container; write it directly.",
            );
    }
    snapshotBeforeWrite(target, 0);
    return target as Mutable<T>;
}

/** The writable view `writable()` returns. */
export type Mutable<T> =
    T extends ReadonlyArray<infer E> ? E[] : { -readonly [K in keyof T]: T[K] };

/** A plain record whose writes are journaled: its properties, once per transaction. */
export function emissionRecord<T extends object>(value: T): T {
    const born = innermostId();
    const proxy = registerContainer(
        new Proxy(value, {
            set(target, key, next: unknown) {
                snapshotBeforeWrite(target, born);
                return Reflect.set(target, key, next, target);
            },
            deleteProperty(target, key) {
                snapshotBeforeWrite(target, born);
                return Reflect.deleteProperty(target, key);
            },
            defineProperty(target, key, descriptor) {
                snapshotBeforeWrite(target, born);
                return Reflect.defineProperty(target, key, descriptor);
            },
        }),
    );
    proxyTargets.set(proxy, value);
    return proxy;
}

interface FieldOriginals extends Originals {
    /** Each written field's restoration, by its accessor. */
    readonly saved: Map<object, () => void>;
}

/** Each instance's field journal, created by its first write in a transaction. */
const fields = new WeakMap<object, Journal<FieldOriginals>>();

/** Save a field's original before a write that changes it. */
function saveField<This extends object, V>(
    instance: This,
    target: ClassAccessorDecoratorTarget<This, V>,
    value: V,
): void {
    const previous = target.get.call(instance);
    if (Object.is(previous, value)) return;
    let journal = fields.get(instance);
    if (!journal) {
        journal = new Journal<FieldOriginals>(
            0,
            (transaction) => ({ transaction, saved: new Map() }),
            (original) => {
                for (const restore of original.saved.values()) restore();
            },
            (older, newer) => adoptMissing(older.saved, newer.saved),
        );
        fields.set(instance, journal);
    }
    const original = journal.current();
    if (original && !original.saved.has(target)) {
        original.saved.set(target, () => target.set.call(instance, previous));
        ++statistics.journaledSlots;
    }
}

/**
 * A class field whose writes are journaled:
 * `@journaled private accessor count = 0`.
 */
export function journaled<This extends object, V>(
    target: ClassAccessorDecoratorTarget<This, V>,
): ClassAccessorDecoratorResult<This, V> {
    return {
        set(this: This, value: V): void {
            if (open.length > 0) saveField(this, target, value);
            target.set.call(this, value);
        },
    };
}
