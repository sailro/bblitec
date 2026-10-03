import { EmissionMutationObserver } from "./emission-transaction.js";
import type { Value, VariableBinding } from "./types.js";

type Input =
    | {
          kind: "scopes";
          value: readonly ReadonlyMap<unknown, VariableBinding>[];
      }
    | { kind: "scope"; value: ReadonlyMap<unknown, VariableBinding> }
    | { kind: "binding"; value: VariableBinding }
    | { kind: "value"; value: Value }
    | { kind: "properties"; value: Readonly<Record<string, Value>> }
    | { kind: "elements"; value: readonly Value[] };

interface Node {
    input: Input;
    target: object;
    children: Set<Node>;
    parents: Set<Node>;
    keys: object[];
}

/** A derived alias index over the live binding graph; writes and rollback update only changed edges. */
export class ScopedValueIndex {
    /** @unjournaled Derived from observed values; mutations and rollback queue edge refreshes. */
    private readonly observer = new EmissionMutationObserver();
    /** @unjournaled Derived reachable graph; disconnected cycles are removed on edge changes. */
    private readonly nodes = new Map<object, Node>();
    /** @unjournaled Derived alias memberships refreshed with their observed owner nodes. */
    private readonly aliases = new Map<object, Set<Value>>();
    private readonly root: Node;

    constructor(scopes: readonly ReadonlyMap<unknown, VariableBinding>[]) {
        this.root = this.node({ kind: "scopes", value: scopes });
    }

    public matching(keys: readonly (object | undefined)[]): Set<Value> {
        this.refresh();
        const result = new Set<Value>();
        for (const key of keys)
            if (key)
                for (const value of this.aliases.get(key) ?? [])
                    result.add(value);
        return result;
    }

    private node(input: Input): Node {
        const target = this.observer.watch(input.value);
        let node = this.nodes.get(target);
        if (!node) {
            node = {
                input,
                target,
                children: new Set(),
                parents: new Set(),
                keys: [],
            };
            this.nodes.set(target, node);
            this.update(node, new Set());
        }
        return node;
    }

    private inputs(input: Input): Input[] {
        switch (input.kind) {
            case "scopes":
                return input.value.map((value) => ({ kind: "scope", value }));
            case "scope":
                return [...input.value.values()].map((value) => ({
                    kind: "binding",
                    value,
                }));
            case "binding":
                return [{ kind: "value", value: input.value.value }];
            case "properties":
                return Object.values(input.value).map((value) => ({
                    kind: "value",
                    value,
                }));
            case "elements":
                return input.value.map((value) => ({ kind: "value", value }));
            case "value": {
                const value = input.value;
                return [
                    ...(value.recordProperties
                        ? [
                              {
                                  kind: "properties" as const,
                                  value: value.recordProperties,
                              },
                          ]
                        : []),
                    ...(value.staticElements
                        ? [
                              {
                                  kind: "elements" as const,
                                  value: value.staticElements,
                              },
                          ]
                        : []),
                    ...(value.tupleElements
                        ? [
                              {
                                  kind: "elements" as const,
                                  value: value.tupleElements,
                              },
                          ]
                        : []),
                ];
            }
        }
    }

    private removeKeys(node: Node): void {
        if (node.input.kind !== "value") return;
        for (const key of node.keys) {
            const values = this.aliases.get(key)!;
            values.delete(node.input.value);
            if (!values.size) this.aliases.delete(key);
        }
        node.keys = [];
    }

    private update(node: Node, removed: Set<Node>): void {
        this.removeKeys(node);
        if (node.input.kind === "value") {
            const value = node.input.value;
            node.keys = [
                ...new Set(
                    [
                        value,
                        value.staticElementsOwner,
                        value.staticElements,
                        value.collectionCardinality,
                        value.recordProperties,
                    ].filter((key) => key !== undefined),
                ),
            ];
            for (const key of node.keys) {
                let values = this.aliases.get(key);
                if (!values) this.aliases.set(key, (values = new Set()));
                values.add(value);
            }
        }
        const next = new Set(
            this.inputs(node.input).map((input) => this.node(input)),
        );
        for (const child of node.children)
            if (!next.has(child)) {
                child.parents.delete(node);
                removed.add(child);
            }
        for (const child of next) child.parents.add(node);
        node.children = next;
    }

    private refresh(): void {
        const removed = new Set<Node>();
        for (const target of this.observer.takeChanges()) {
            const node = this.nodes.get(target);
            if (node) this.update(node, removed);
        }
        if (!removed.size) return;
        // Only descendants of removed edges can lose reachability. External
        // parents anchor shared subgraphs; cycles with no live anchor expire.
        const suspects = new Set(removed);
        for (const node of suspects)
            for (const child of node.children) suspects.add(child);
        const retained = new Set(
            [...suspects].filter(
                (node) =>
                    node === this.root ||
                    [...node.parents].some((parent) => !suspects.has(parent)),
            ),
        );
        for (const node of retained)
            for (const child of node.children)
                if (suspects.has(child)) retained.add(child);
        for (const node of suspects) {
            if (retained.has(node)) continue;
            this.removeKeys(node);
            for (const child of node.children) child.parents.delete(node);
            this.nodes.delete(node.target);
            this.observer.unwatch(node.input.value);
        }
    }
}
