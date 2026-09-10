type Undo = () => void;

const transactions: EmissionTransaction[] = [];
let nextTransaction = 1;
const collectionBirths = new WeakMap<object, number>();
const managedArrays = new WeakSet<object>();

function journalCollection(collection: object, snapshot: () => Undo): void {
    for (const transaction of transactions) {
        if (collectionBirths.get(collection)! < transaction.id) transaction.recordCollection(collection, snapshot);
    }
}

/** AST nodes, checker types and symbols are immutable compiler inputs. */
export function isCompilerInput(value: object): boolean {
    return ("kind" in value && typeof value.kind === "number" &&
        "pos" in value && typeof value.pos === "number" &&
        "end" in value && typeof value.end === "number") ||
        ("getFlags" in value && typeof value.getFlags === "function");
}

/** Restore existing objects in place so aliases retain their identities. */
export class EmissionTransaction {
    public readonly id = nextTransaction++;
    private readonly visited = new Set<object>();
    private readonly undo: Undo[] = [];
    private readonly changedCollections = new Set<object>();
    private closed = false;

    public constructor(root: object, opaque: readonly object[] = []) {
        for (const value of opaque) this.visited.add(value);
        this.capture(root);
        transactions.push(this);
    }

    public capture(value: unknown): void {
        if (value === null || typeof value !== "object" || this.visited.has(value) || isCompilerInput(value)) return;
        this.visited.add(value);
        if (value instanceof EmissionMap || value instanceof EmissionSet || managedArrays.has(value)) return;
        if (value instanceof WeakMap || value instanceof WeakSet) return;
        if (Array.isArray(value)) {
            const entries: unknown[] = value.slice();
            this.undo.push(() => {
                value.length = entries.length;
                for (let index = 0; index < entries.length; ++index) {
                    if (index in entries) value[index] = entries[index]; else delete value[index];
                }
            });
            for (const entry of entries) this.capture(entry);
            return;
        } else if (value instanceof Map) {
            const entries: [unknown, unknown][] = [...value.entries()];
            this.undo.push(() => { value.clear(); for (const [key, entry] of entries) value.set(key, entry); });
            for (const [key, entry] of entries) { this.capture(key); this.capture(entry); }
        } else if (value instanceof Set) {
            const entries: unknown[] = [...value];
            this.undo.push(() => { value.clear(); for (const entry of entries) value.add(entry); });
            for (const entry of entries) this.capture(entry);
        } else if (ArrayBuffer.isView(value)) {
            const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            const snapshot = bytes.slice();
            this.undo.push(() => bytes.set(snapshot));
            return;
        } else if (value instanceof ArrayBuffer) {
            const bytes = new Uint8Array(value), snapshot = bytes.slice();
            this.undo.push(() => bytes.set(snapshot));
            return;
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        this.undo.push(() => {
            for (const key of Reflect.ownKeys(value)) {
                if (!Object.hasOwn(descriptors, key)) Reflect.deleteProperty(value, key);
            }
            Object.defineProperties(value, descriptors);
        });
        for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            if ("value" in descriptor) this.capture(descriptor.value);
        }
    }

    public record(undo: Undo): void { this.undo.push(undo); }

    public recordCollection(collection: object, snapshot: () => Undo): void {
        if (this.changedCollections.has(collection)) return;
        this.changedCollections.add(collection);
        this.record(snapshot());
    }

    public finish(commit: boolean): void {
        if (this.closed || transactions.at(-1) !== this) throw new Error("Emission transactions must close in order.");
        transactions.pop();
        this.closed = true;
        if (!commit) for (let index = this.undo.length - 1; index >= 0; --index) this.undo[index]!();
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

/** Strong collections journal writes and snapshot only values a probe reads. */
export class EmissionMap<K, V> extends Map<K, V> {
    public constructor(entries?: Iterable<readonly [K, V]> | null) {
        super();
        collectionBirths.set(this, transactions.at(-1)?.id ?? 0);
        for (const [key, value] of entries ?? []) {
            for (const transaction of transactions) { transaction.capture(key); transaction.capture(value); }
            super.set(key, value);
        }
    }

    public override get(key: K): V | undefined {
        const value = super.get(key);
        for (const transaction of transactions) transaction.capture(value);
        return value;
    }

    public override set(key: K, value: V): this {
        for (const transaction of transactions) {
            transaction.capture(key);
            transaction.capture(value);
            transaction.capture(super.get(key));
        }
        journalCollection(this, () => {
            const entries = [...super.entries()];
            return () => { super.clear(); for (const [key, value] of entries) super.set(key, value); };
        });
        return super.set(key, value);
    }

    public override delete(key: K): boolean {
        if (super.has(key)) {
            for (const transaction of transactions) transaction.capture(super.get(key));
            journalCollection(this, () => {
                const entries = [...super.entries()];
                return () => { super.clear(); for (const [key, value] of entries) super.set(key, value); };
            });
        }
        return super.delete(key);
    }

    public override clear(): void {
        for (const value of super.values()) for (const transaction of transactions) transaction.capture(value);
        journalCollection(this, () => {
            const entries = [...super.entries()];
            return () => { super.clear(); for (const [key, value] of entries) super.set(key, value); };
        });
        super.clear();
    }

    public override *entries(): MapIterator<[K, V]> {
        for (const [key, value] of super.entries()) {
            for (const transaction of transactions) { transaction.capture(key); transaction.capture(value); }
            yield [key, value];
        }
    }
    public override [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
    public override *keys(): MapIterator<K> {
        for (const key of super.keys()) {
            for (const transaction of transactions) transaction.capture(key);
            yield key;
        }
    }
    public override *values(): MapIterator<V> {
        for (const value of super.values()) {
            for (const transaction of transactions) transaction.capture(value);
            yield value;
        }
    }
    public override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
        for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
    }
}

export class EmissionSet<T> extends Set<T> {
    public constructor(values?: Iterable<T> | null) {
        super();
        collectionBirths.set(this, transactions.at(-1)?.id ?? 0);
        for (const value of values ?? []) {
            for (const transaction of transactions) transaction.capture(value);
            super.add(value);
        }
    }

    public override add(value: T): this {
        for (const transaction of transactions) transaction.capture(value);
        if (!super.has(value)) journalCollection(this, () => {
            const values = [...super.values()];
            return () => { super.clear(); for (const value of values) super.add(value); };
        });
        return super.add(value);
    }
    public override delete(value: T): boolean {
        if (super.has(value)) {
            for (const transaction of transactions) transaction.capture(value);
            journalCollection(this, () => {
                const values = [...super.values()];
                return () => { super.clear(); for (const value of values) super.add(value); };
            });
        }
        return super.delete(value);
    }
    public override clear(): void {
        for (const value of super.values()) for (const transaction of transactions) transaction.capture(value);
        journalCollection(this, () => {
            const values = [...super.values()];
            return () => { super.clear(); for (const value of values) super.add(value); };
        });
        super.clear();
    }
    public override *values(): SetIterator<T> {
        for (const value of super.values()) {
            for (const transaction of transactions) transaction.capture(value);
            yield value;
        }
    }
    public override keys(): SetIterator<T> { return this.values(); }
    public override [Symbol.iterator](): SetIterator<T> { return this.values(); }
    public override *entries(): SetIterator<[T, T]> { for (const value of this.values()) yield [value, value]; }
    public override forEach(callback: (value: T, value2: T, set: Set<T>) => void, thisArg?: unknown): void {
        for (const value of this.values()) callback.call(thisArg, value, value, this);
    }
}

/** Array index and length writes journal only the slots they change. */
export function emissionArray<T>(values: T[] = []): T[] {
    const createdIn = transactions.at(-1)?.id ?? 0;
    for (const value of values) for (const transaction of transactions) transaction.capture(value);
    const beforeWrite = (key: PropertyKey): void => {
        for (const transaction of transactions) {
            if (createdIn >= transaction.id) continue;
            const descriptor = Object.getOwnPropertyDescriptor(values, key);
            const length = values.length;
            if (descriptor && "value" in descriptor) transaction.capture(descriptor.value);
            transaction.record(() => {
                if (descriptor) Object.defineProperty(values, key, descriptor); else Reflect.deleteProperty(values, key);
                values.length = length;
            });
        }
    };
    const proxy = new Proxy(values, {
        get(target, key, receiver) {
            const value: unknown = Reflect.get(target, key, receiver);
            for (const transaction of transactions) transaction.capture(value);
            return value;
        },
        set(target, key, value: unknown) {
            for (const transaction of transactions) transaction.capture(value);
            if (key === "length" && typeof value === "number" && value < target.length) {
                for (let index = value; index < target.length; ++index) beforeWrite(String(index));
            }
            beforeWrite(key);
            return Reflect.set(target, key, value, target);
        },
        deleteProperty(target, key) { beforeWrite(key); return Reflect.deleteProperty(target, key); },
        defineProperty(target, key, descriptor) {
            const length: unknown = descriptor.value;
            if (key === "length" && typeof length === "number" && length < target.length) {
                for (let index = length; index < target.length; ++index) beforeWrite(String(index));
            }
            beforeWrite(key);
            return Reflect.defineProperty(target, key, descriptor);
        },
    });
    managedArrays.add(proxy);
    return proxy;
}

/** Weak entries join active transactions without retaining their keys afterwards. */
export class EmissionWeakMap<K extends WeakKey, V> extends WeakMap<K, V> {
    public override get(key: K): V | undefined {
        const value = super.get(key);
        for (const transaction of transactions) transaction.capture(value);
        return value;
    }

    public override set(key: K, value: V): this {
        const present = super.has(key), previous = super.get(key);
        for (const transaction of transactions) {
            transaction.capture(value);
            transaction.capture(previous);
            transaction.record(() => { if (present) super.set(key, previous!); else super.delete(key); });
        }
        return super.set(key, value);
    }

    public override delete(key: K): boolean {
        const present = super.has(key), previous = super.get(key);
        if (present) for (const transaction of transactions) {
            transaction.capture(previous);
            transaction.record(() => { super.set(key, previous!); });
        }
        return super.delete(key);
    }
}

export class EmissionWeakSet<K extends WeakKey> extends WeakSet<K> {
    public override add(key: K): this {
        if (!super.has(key)) for (const transaction of transactions) transaction.record(() => { super.delete(key); });
        return super.add(key);
    }

    public override delete(key: K): boolean {
        if (super.has(key)) for (const transaction of transactions) transaction.record(() => { super.add(key); });
        return super.delete(key);
    }
}
