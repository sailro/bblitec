import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

/**
 * The demand-driven runtime representation of a local class.
 *
 * A class stays what the subset always made it -- a compile-time record of
 * per-field bindings -- until a native data position demands one instance
 * be a value: an array element, a map key or value, a set member, a
 * callback parameter or result. Then, and only then, it becomes the
 * reference struct shared objects already have here, `bbl::js::Ref<XData>`,
 * so identity, null, `includes`, `indexOf`, `Set` membership and `Map` keys
 * all answer the way JavaScript answers them.
 *
 * These tests hold the boundary: what stays a record, what becomes a shared
 * object, what the layout stores against what it hoists, and the refusals
 * that stand where the model has no honest answer.
 */

const workspaceOverParts = `
    interface Quat { x: number; y: number; z: number; w: number; }

    class Part {
        readonly locked: boolean;
        private readonly _renderer: Renderer;
        private readonly _workspace: Workspace;
        private _size: [number, number, number];
        private readonly _position: { x: number; y: number; z: number };
        private readonly _quat: Quat = { x: 0, y: 0, z: 0, w: 1 };
        private _destroyed = false;
        private readonly _changeHandlers = new Set<() => void>();

        constructor(renderer: Renderer, workspace: Workspace, locked: boolean) {
            this._renderer = renderer;
            this._workspace = workspace;
            this.locked = locked;
            this._size = [2, 1, 1];
            this._position = { x: 0, y: 0, z: 0 };
            workspace.add(this);
        }

        get size(): readonly [number, number, number] { return this._size; }
        get destroyed(): boolean { return this._destroyed; }

        setPosition(p: { readonly x: number; readonly y: number; readonly z: number }): void {
            this._position.x = p.x;
            this._position.y = p.y;
            this._position.z = p.z;
            this._emitChange();
        }

        rotate90(): void {
            const q = this._quat;
            const nx = q.w;
            q.w = q.x;
            q.x = nx;
        }

        volume(): number {
            return this._size[0]! * this._size[1]! * this._size[2]!;
        }

        clone(): Part {
            const copy = new Part(this._renderer, this._workspace, this.locked);
            copy._quat.x = this._quat.x;
            return copy;
        }

        destroy(): void {
            if (this._destroyed) { return; }
            this._destroyed = true;
            this._renderer.freed += 1;
            this._workspace.remove(this);
            this._changeHandlers.clear();
        }

        onChange(handler: () => void): void { this._changeHandlers.add(handler); }
        offChange(handler: () => void): void { this._changeHandlers.delete(handler); }

        private _emitChange(): void {
            for (const h of this._changeHandlers) { h(); }
        }
    }

    class Renderer {
        freed = 0;
    }

    class Workspace {
        private readonly _parts: Part[] = [];
        private _selected: Part | null = null;

        get parts(): readonly Part[] { return this._parts; }
        get selected(): Part | null { return this._selected; }

        add(part: Part): void {
            if (this._parts.includes(part)) { return; }
            this._parts.push(part);
        }

        remove(part: Part): void {
            const i = this._parts.indexOf(part);
            if (i < 0) { return; }
            this._parts.splice(i, 1);
            if (part === this._selected) { this._selected = null; }
        }

        select(part: Part): void { this._selected = part; }

        total(): number {
            let sum = 0;
            for (const part of this._parts) {
                if (!part.destroyed) { sum += part.volume(); }
            }
            return sum;
        }
    }
`;

test("keeps a class nothing stores as a compile-time record", () => {
    const result = compileSource(`
        class Counter {
            private total = 0;
            add(value: number): void { this.total += value; }
            get sum(): number { return this.total; }
        }
        const counter = new Counter();
        counter.add(3);
        const read = counter.sum;
        const unused = read + 1;
    `);

    // No struct survives; the mutable field is a shared closure cell so a
    // retained callback would still observe the same class state.
    assert.doesNotMatch(result.cpp, /struct CounterData/);
    assert.doesNotMatch(result.cpp, /make_ref<bblscene::Counter/);
    assert.match(
        result.cpp,
        /auto v_bblite_class_field_total_\d+ = std::make_shared<double>\(0\.0\)/,
    );
});

test("stores a class an array element demands as a shared object", () => {
    const result = compileSource(`
        ${workspaceOverParts}
        const renderer = new Renderer();
        const workspace = new Workspace();
        const first = new Part(renderer, workspace, false);
        const total = workspace.total();
        const unused = total + 1;
    `);

    // The layout keeps the plain-data fields and drops the two that name
    // things generation owns -- the renderer and the workspace.
    assert.match(
        result.cpp,
        /struct PartData \{\s*bool locked;\s*bbl::js::Tuple<3> _size;\s*bblscene::\w+ _position;\s*bblscene::Quat _quat;\s*bool _destroyed;\s*bbl::js::Set<bbl::js::Callback<void\(\)>> _changeHandlers;\s*\};/,
    );
    assert.match(result.cpp, /using Part = bbl::js::Ref<PartData>;/);
    assert.match(
        result.cpp,
        /bblscene::Part v_\w+ = bbl::js::make_ref<bblscene::PartData>\(\);/,
    );
    // The array holds the shared object, not a copy of its fields.
    assert.match(result.cpp, /bbl::js::Array<bblscene::Part>/);
});

test("inlines a method on an instance read back out of a container", () => {
    const result = compileSource(`
        ${workspaceOverParts}
        const renderer = new Renderer();
        const workspace = new Workspace();
        new Part(renderer, workspace, false);
        const total = workspace.total();
        const unused = total + 1;
    `);

    // The loop variable is a `Ref`, and both the getter (`destroyed`) and
    // the method (`volume`) read through it rather than through a local.
    assert.match(
        result.cpp,
        /for \(auto&& (v_\w+) : v_\w+\) \{\s*if \(!\(\(static_cast<bool>\(\1\) && \1->_destroyed\)\)\)/,
    );
    assert.match(result.cpp, /\w+->_size\[bbl::js::array_index\(0\.0\)\]/);
});

test("keeps object identity and null on stored instances", () => {
    const result = compileSource(`
        ${workspaceOverParts}
        const renderer = new Renderer();
        const workspace = new Workspace();
        const first = new Part(renderer, workspace, false);
        workspace.select(first);
        workspace.remove(first);
        const unused = workspace.parts.length;
    `);

    // `includes`, `indexOf` and `===` are all the Ref's own identity.
    assert.match(result.cpp, /bbl::js::array_index_of\(/);
    assert.match(result.cpp, /\.get\(\) == /);
    // A null instance is the empty reference, not a second state beside it.
    assert.match(
        result.cpp,
        /auto v_\w+ = std::make_shared<bblscene::Part>\(bblscene::Part\{\}\);/,
    );
    assert.doesNotMatch(result.cpp, /Nullable<bblscene::Part>/);
});

test("clones a stored instance into a second shared object", () => {
    const result = compileSource(`
        ${workspaceOverParts}
        const renderer = new Renderer();
        const workspace = new Workspace();
        const first = new Part(renderer, workspace, false);
        const copy = first.clone();
        copy.setPosition({ x: 1, y: 2, z: 3 });
        const unused = copy.size[0]! + workspace.parts.length;
    `);

    assert.equal(
        (result.cpp.match(/bbl::js::make_ref<bblscene::PartData>\(\)/g) ?? [])
            .length,
        2,
    );
});

test("mutates a nested object field in place instead of copying it", () => {
    const result = compileSource(`
        ${workspaceOverParts}
        const renderer = new Renderer();
        const workspace = new Workspace();
        const first = new Part(renderer, workspace, false);
        first.rotate90();
        first.setPosition({ x: 1, y: 2, z: 3 });
        const unused = workspace.parts.length;
    `);

    // `const q = this._quat` aliases the stored object: the writes land on
    // the instance, not on a detached copy.
    assert.match(
        result.cpp,
        /bblscene::Quat& (v_\w+) = v_\w+->_quat;[\s\S]*\1->w = \1->x;/,
    );
    assert.match(result.cpp, /->_position->x = /);
});

test("gives one callback declaration one identity at every materialization", () => {
    const result = compileSource(`
        ${workspaceOverParts}
        class Watcher {
            private _seen = 0;
            private readonly _part: Part;
            private readonly _onChange = (): void => { this._seen += 1; };

            constructor(part: Part) {
                this._part = part;
                part.onChange(this._onChange);
            }

            stop(): void { this._part.offChange(this._onChange); }
            get seen(): number { return this._seen; }
        }

        const renderer = new Renderer();
        const workspace = new Workspace();
        const first = new Part(renderer, workspace, false);
        const watcher = new Watcher(first);
        watcher.stop();
        const unused = watcher.seen;
    `);

    const identities = [
        ...result.cpp.matchAll(
            /bbl::js::Callback<void\(\)> \w+\{(\d+)u,/g,
        ),
    ].map((match) => match[1]);
    assert.equal(identities.length, 2);
    assert.equal(identities[0], identities[1]);
    assert.match(result.cpp, /_changeHandlers\.add\(/);
    assert.match(result.cpp, /_changeHandlers\.erase\(/);
});

test("resolves a generic class's fields through each instantiation", () => {
    const result = compileSource(`
        interface Entry { readonly locked: boolean; }

        class Block { readonly locked = false; readonly weight = 2; }
        class Marker { readonly locked = true; readonly tag = "m"; }

        class Registry<P extends Entry = Entry> {
            private readonly _items: P[] = [];
            private readonly _handlers = new Map<string, Set<(item: P) => void>>();

            add(item: P): void {
                this._items.push(item);
                const set = this._handlers.get("added");
                if (set) { for (const h of set) { h(item); } }
            }

            on(event: string, handler: (item: P) => void): void {
                let set = this._handlers.get(event);
                if (!set) { set = new Set(); this._handlers.set(event, set); }
                set.add(handler);
            }

            get count(): number { return this._items.length; }
        }

        const blocks = new Registry<Block>();
        const markers = new Registry<Marker>();
        blocks.add(new Block());
        markers.add(new Marker());
        const unused = blocks.count + markers.count;
    `);

    // Each instantiation gets its own element type; neither reads back the
    // other's struct.
    assert.match(result.cpp, /bbl::js::Array<bblscene::Block>/);
    assert.match(result.cpp, /bbl::js::Array<bblscene::Marker>/);
    assert.match(
        result.cpp,
        /bbl::js::Map<std::string, bbl::js::Set<bbl::js::Callback<void\(bblscene::Block\)>>>/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Map<std::string, bbl::js::Set<bbl::js::Callback<void\(bblscene::Marker\)>>>/,
    );
});

test("keeps two instantiations of one generic interface apart", () => {
    const result = compileSource(`
        interface Entry { readonly locked: boolean; }
        interface Hit<P extends Entry> { readonly part: P; readonly distance: number; }

        class Block { readonly locked = false; readonly weight = 2; }
        class Marker { readonly locked = true; readonly tag = "m"; }

        class Registry<P extends Entry = Entry> {
            private readonly _items: P[] = [];

            add(item: P): void { this._items.push(item); }

            first(): Hit<P> | null {
                let best: Hit<P> | null = null;
                for (const item of this._items) {
                    if (!item.locked) { best = { part: item, distance: 1 }; }
                }
                return best;
            }
        }

        const blocks = new Registry<Block>();
        const markers = new Registry<Marker>();
        blocks.add(new Block());
        markers.add(new Marker());
        const blockHit = blocks.first();
        const markerHit = markers.first();
        const unused = (blockHit ? blockHit.part.weight : 0) + (markerHit ? markerHit.part.tag.length : 0);
    `);

    const hits = [
        ...result.cpp.matchAll(/struct (Hit\d*)Data \{\s*bblscene::(\w+) part;/g),
    ];
    assert.equal(hits.length, 2);
    assert.notEqual(hits[0]![1], hits[1]![1]);
    assert.deepEqual(
        [hits[0]![2], hits[1]![2]].sort(),
        ["Block", "Marker"],
    );
});

test("refuses a stored class whose hoisted field differs per construction", () => {
    assert.throws(
        () =>
            compileSource(`
                ${workspaceOverParts}
                const one = new Renderer();
                const two = new Renderer();
                const workspace = new Workspace();
                new Part(one, workspace, false);
                new Part(two, workspace, false);
                const unused = workspace.parts.length;
            `),
        /is not the same at every construction/,
    );
});

test("refuses a stored class that would need dynamic dispatch", () => {
    assert.throws(
        () =>
            compileSource(`
                abstract class Shape {
                    abstract area(): number;
                }
                class Square extends Shape {
                    area(): number { return 4; }
                }
                const shapes: Shape[] = [];
                const unused = shapes.length;
            `),
        /has no single native representation|extends another class/,
    );
});

test("refuses a per-instance callback of a class instances are stored by", () => {
    assert.throws(
        () =>
            compileSource(`
                interface Entry { readonly locked: boolean; }

                class Alarm {
                    readonly locked = false;
                    private _fired = 0;
                    private readonly _ring = (): void => { this._fired += 1; };
                    private readonly _handlers = new Set<() => void>();

                    arm(): void { this._handlers.add(this._ring); }
                    disarm(): void { this._handlers.delete(this._ring); }
                    get fired(): number { return this._fired; }
                }

                const alarms: Alarm[] = [];
                for (let i = 0; i < 2; i++) { alarms.push(new Alarm()); }
                for (const alarm of alarms) { alarm.arm(); }
                const unused = alarms.length;
            `),
        /identity a container could compare/,
    );
});

test("keeps a compile-time instance out of a container that shares objects", () => {
    assert.throws(
        () =>
            compileSource(`
                class Node {
                    readonly weight: number;
                    constructor(weight: number) { this.weight = weight; }
                }
                const first = new Node(1);
                const seen = new Set<Node>();
                seen.add(first);
                const unused = seen.size;
            `),
        /compile-time record/,
    );
});

/**
 * A hoisted field is bound from the constructor argument the CALLER
 * evaluated, so the one constructor assignment the proof selected has
 * already happened by the time the body spells it. Nothing else has:
 * the binding outlives the construction -- a method inlined on a stored
 * instance reads it back out of the proven map -- so any other write
 * would have to change a field no instance stores.
 */
const rigOverRenderers = (members: string): string => `
    class Renderer { freed = 0; }

    class Rig {
        readonly locked = false;
        private _renderer: Renderer;
        ${members}
        bump(): void { this._renderer.freed += 1; }
    }
`;

test("emits the one constructor write a hoisted field was proven from", () => {
    const result = compileSource(`
        ${rigOverRenderers(`
            constructor(renderer: Renderer) { this._renderer = renderer; }
        `)}
        const one = new Renderer();
        const rigs: Rig[] = [];
        rigs.push(new Rig(one));
        for (const rig of rigs) { rig.bump(); }
        const unused = rigs.length + one.freed;
    `);

    // The field names the caller's renderer, and the constructor's own
    // `this._renderer = renderer` emitted nothing beside it.
    const local =
        /auto (v_bblite_class_field_freed_\d+) = std::make_shared<double>\(0\.0\);/.exec(
        result.cpp,
    )?.[1];
    assert.ok(local);
    assert.match(result.cpp, new RegExp(`\\(\\*${local}\\) \\+= 1\\.0;`));
});

test("refuses a method that retargets a hoisted class field", () => {
    assert.throws(
        () =>
            compileSource(`
                ${rigOverRenderers(`
                    constructor(renderer: Renderer) { this._renderer = renderer; }
                    retarget(other: Renderer): void { this._renderer = other; }
                `)}
                const one = new Renderer();
                const two = new Renderer();
                const rigs: Rig[] = [];
                rigs.push(new Rig(one));
                for (const rig of rigs) { rig.retarget(two); rig.bump(); }
                const unused = rigs.length + one.freed + two.freed;
            `),
        /input\.ts:\d+:\d+: Field '_renderer' is already bound/,
    );
});

test("refuses a conditional constructor write to a hoisted field", () => {
    assert.throws(
        () =>
            compileSource(`
                ${rigOverRenderers(`
                    constructor(renderer: Renderer, spare: Renderer, useSpare: boolean) {
                        this._renderer = renderer;
                        if (useSpare) { this._renderer = spare; }
                    }
                `)}
                const one = new Renderer();
                const two = new Renderer();
                const rigs: Rig[] = [];
                rigs.push(new Rig(one, two, rigs.length === 0));
                for (const rig of rigs) { rig.bump(); }
                const unused = rigs.length + one.freed + two.freed;
            `),
        /input\.ts:\d+:\d+: Field '_renderer' is already bound/,
    );
});

/**
 * A callback's JavaScript identity is its declaration together with the
 * closure that declaration closes over -- the instance of the class that
 * wrote it, or the evaluation of the function body it sits in. It is never
 * whichever receiver happened to be bound where the callback was
 * materialized: that receiver is incidental to the function object.
 */
const tickerOverParts = `
    ${workspaceOverParts}

    function onTick(): void { }

    class Ticker {
        private readonly _part: Part;
        constructor(part: Part) {
            this._part = part;
            part.onChange(onTick);
        }
    }
`;

const callbackIdentities = (cpp: string): string[] =>
    [...cpp.matchAll(/bbl::js::Callback<void\(\)> \w+\{(\d+)u,/g)].map(
        (match) => match[1]!,
    );

test("keeps one module-level callback one identity across receivers", () => {
    const result = compileSource(`
        ${tickerOverParts}
        const renderer = new Renderer();
        const workspace = new Workspace();
        const first = new Part(renderer, workspace, false);
        const ticker = new Ticker(first);
        first.offChange(onTick);
        const unused = workspace.parts.length;
    `);

    // Added with the ticker instance bound as `this`, removed at module
    // scope with nothing bound: one function object either way.
    const identities = callbackIdentities(result.cpp);
    assert.equal(identities.length, 2);
    assert.equal(identities[0], identities[1]);
    assert.match(result.cpp, /_changeHandlers\.add\(/);
    assert.match(result.cpp, /_changeHandlers\.erase\(/);
});

test("adds one module-level callback once from two owners", () => {
    const result = compileSource(`
        ${tickerOverParts}
        const renderer = new Renderer();
        const workspace = new Workspace();
        const first = new Part(renderer, workspace, false);
        const second = new Part(renderer, workspace, false);
        const one = new Ticker(first);
        const two = new Ticker(second);
        const unused = workspace.parts.length;
    `);

    // Two constructions, two receivers, still the one handler `onTick`
    // names -- a Set that saw both must hold a single member.
    const identities = callbackIdentities(result.cpp);
    assert.equal(identities.length, 2);
    assert.equal(identities[0], identities[1]);
});

test("gives two instances of one class-field callback two identities", () => {
    const result = compileSource(`
        ${workspaceOverParts}
        class Watcher {
            private _seen = 0;
            private readonly _part: Part;
            private readonly _onChange = (): void => { this._seen += 1; };

            constructor(part: Part) {
                this._part = part;
                part.onChange(this._onChange);
            }

            stop(): void { this._part.offChange(this._onChange); }
            get seen(): number { return this._seen; }
        }

        const renderer = new Renderer();
        const workspace = new Workspace();
        const first = new Part(renderer, workspace, false);
        const second = new Part(renderer, workspace, false);
        const one = new Watcher(first);
        const two = new Watcher(second);
        one.stop();
        two.stop();
        const unused = one.seen + two.seen;
    `);

    // On and off pair up within each watcher, and the two watchers do not
    // share the handler the other one registered. Both constructions run
    // before either `stop`, so the adds come first.
    const identities = callbackIdentities(result.cpp);
    assert.equal(identities.length, 4);
    assert.equal(identities[0], identities[2]);
    assert.equal(identities[1], identities[3]);
    assert.notEqual(identities[0], identities[1]);
});

test("keeps callback-producing functions on the per-call inliner", () => {
    const result = compileSource(`
        ${workspaceOverParts}
        function attach(part: Part): void {
            part.onChange((): void => { });
        }

        const renderer = new Renderer();
        const workspace = new Workspace();
        const first = new Part(renderer, workspace, false);
        const second = new Part(renderer, workspace, false);
        attach(first);
        attach(second);
        const unused = workspace.parts.length;
    `);

    const identities = callbackIdentities(result.cpp);
    assert.equal(identities.length, 2);
    assert.notEqual(identities[0], identities[1]);
    assert.doesNotMatch(result.cpp, /void attach\(/);
});

test("keeps two instantiations of one inline object type apart", () => {
    const result = compileSource(`
        interface Entry { readonly locked: boolean; }

        class Block { readonly locked = false; readonly weight = 2; }
        class Marker { readonly locked = true; readonly tag = "m"; }

        class Registry<P extends Entry = Entry> {
            private readonly _items: P[] = [];

            add(item: P): void { this._items.push(item); }

            first(): { part: P; distance: number } | null {
                let best: { part: P; distance: number } | null = null;
                for (const item of this._items) {
                    if (!item.locked) { best = { part: item, distance: 1 }; }
                }
                return best;
            }
        }

        const blocks = new Registry<Block>();
        const markers = new Registry<Marker>();
        blocks.add(new Block());
        markers.add(new Marker());
        const blockHit = blocks.first();
        const markerHit = markers.first();
        const unused = (blockHit ? blockHit.part.weight : 0) + (markerHit ? markerHit.part.tag.length : 0);
    `);

    // The anonymous shape is written once, so both instantiations carry
    // one type literal's symbol; each still gets its own struct.
    const hits = [
        ...result.cpp.matchAll(/struct (\w+)Data \{\s*bblscene::(\w+) part;/g),
    ];
    assert.equal(hits.length, 2);
    assert.notEqual(hits[0]![1], hits[1]![1]);
    assert.deepEqual(
        [hits[0]![2], hits[1]![2]].sort(),
        ["Block", "Marker"],
    );
});

test("keeps two instantiations of an intersecting inline type apart", () => {
    const result = compileSource(`
        interface Entry { readonly locked: boolean; }
        interface Stamped { readonly distance: number; }

        class Block { readonly locked = false; readonly weight = 2; }
        class Marker { readonly locked = true; readonly tag = "m"; }

        class Registry<P extends Entry = Entry> {
            private readonly _items: P[] = [];

            add(item: P): void { this._items.push(item); }

            first(): ({ part: P } & Stamped) | null {
                let best: ({ part: P } & Stamped) | null = null;
                for (const item of this._items) {
                    if (!item.locked) { best = { part: item, distance: 1 }; }
                }
                return best;
            }
        }

        const blocks = new Registry<Block>();
        const markers = new Registry<Marker>();
        blocks.add(new Block());
        markers.add(new Marker());
        const blockHit = blocks.first();
        const markerHit = markers.first();
        const unused = (blockHit ? blockHit.part.weight : 0) + (markerHit ? markerHit.part.tag.length : 0);
    `);

    const hits = [
        ...result.cpp.matchAll(/struct (\w+)Data \{\s*bblscene::(\w+) part;/g),
    ];
    assert.equal(hits.length, 2);
    assert.notEqual(hits[0]![1], hits[1]![1]);
    assert.deepEqual(
        [hits[0]![2], hits[1]![2]].sort(),
        ["Block", "Marker"],
    );
});
