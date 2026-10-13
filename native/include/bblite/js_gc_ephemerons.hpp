#pragma once

#include <bblite/js_gc.hpp>

namespace bbl::js::gc {

/** Acyclic shared storage needs graph identity only while weak entries are collected. */
struct DiscoveredShared final : Node {
    std::weak_ptr<const void> identity;
    std::shared_ptr<const void> retained;
    const void* value = nullptr;
    TraceVisitor::Trace visit = nullptr;
    mutable bool scanned = false;
    void trace(const TraceVisitor& visitor) const override {
        scanned = true;
        if (visit)
            visit(value, visitor);
    }
    // Its weak-map entry releases acyclic storage; its ordinary owner destroys the payload.
    void clear() noexcept override {}
    std::size_t owners() const noexcept override {
        return static_cast<std::size_t>(identity.use_count());
    }
    void pin() noexcept override { retained = identity.lock(); }
    void unpin() noexcept override { auto release = std::move(retained); }
    std::weak_ptr<const void> shared_owner() const noexcept override { return identity; }
};

class EphemeronGraph {
    struct WeakEdges {
        std::weak_ptr<const void> identity;
        Node* key = nullptr;
        std::vector<Node*> values;
        const void* owner = nullptr;
        TraceVisitor::Erase erase = nullptr;
    };
    struct Edges {
        std::vector<Node*> strong;
        std::vector<WeakEdges> weak;
    };
    SharedNodes shared_;
    std::map<std::weak_ptr<const void>, std::unique_ptr<DiscoveredShared>, std::owner_less<>>
        extra_;
    std::unordered_map<Node*, Edges> edges_;
    std::vector<Node*> nodes_;
    std::vector<Node*> scans_;
    Node* current_ = nullptr;
    std::vector<Node*>* values_ = nullptr;

    void add(Node* node) {
        if (!edges_.try_emplace(node).second)
            return;
        nodes_.push_back(node);
        node->pin();
        node->incoming = 0;
        node->reachable = false;
        scans_.push_back(node);
    }
    void edge(Node* node) {
        add(node);
        ++node->incoming;
        (values_ ? *values_ : edges_.at(current_).strong).push_back(node);
    }
    Node* shared(const std::weak_ptr<const void>& identity, const void* value,
                 TraceVisitor::Trace visit) {
        auto found = extra_.find(identity);
        if (found == extra_.end()) {
            auto node = std::make_unique<DiscoveredShared>();
            node->identity = identity;
            found = extra_.emplace(identity, std::move(node)).first;
        }
        auto& node = *found->second;
        if (!node.visit && visit) {
            if (node.scanned)
                scans_.push_back(&node);
            node.value = value;
            node.visit = visit;
        }
        return &node;
    }
    TraceVisitor visitor() {
        static constexpr TraceVisitor::Discovery discovery{
            [](const std::weak_ptr<const void>& identity, const void* value,
               TraceVisitor::Trace visit, void* graph) -> Node* {
                return static_cast<EphemeronGraph*>(graph)->shared(identity, value, visit);
            },
            [](const std::weak_ptr<const void>& identity, const void* value,
               TraceVisitor::Trace visit, const void* owner, TraceVisitor::Erase erase,
               void* graph) {
                auto& self = *static_cast<EphemeronGraph*>(graph);
                WeakEdges entry{identity, nullptr, {}, owner, erase};
                auto* previous = std::exchange(self.values_, &entry.values);
                try {
                    visit(value, self.visitor());
                } catch (...) {
                    self.values_ = previous;
                    throw;
                }
                self.values_ = previous;
                self.edges_.at(self.current_).weak.push_back(std::move(entry));
            }};
        return {shared_,
                [](Node* node, void* graph) { static_cast<EphemeronGraph*>(graph)->edge(node); },
                this, &discovery};
    }

public:
    ~EphemeronGraph() {
        for (auto* node : nodes_)
            node->unpin();
    }
    void discover(const std::vector<Node*>& roots) {
        for (auto* node : roots) {
            auto identity = node->shared_owner();
            if (!identity.expired())
                shared_.emplace_back(std::move(identity), node);
        }
        std::sort(shared_.begin(), shared_.end(), [](const auto& a, const auto& b) {
            return std::owner_less<>{}(a.first, b.first);
        });
        for (auto* node : roots)
            add(node);
        const auto trace = visitor();
        for (std::size_t index = 0; index < scans_.size(); ++index) {
            current_ = scans_[index];
            current_->trace(trace);
        }
        SharedNodes keys;
        for (auto* node : nodes_) {
            auto identity = node->weak_owner();
            if (!identity.expired())
                keys.emplace_back(std::move(identity), node);
        }
        std::sort(keys.begin(), keys.end(), [](const auto& a, const auto& b) {
            return std::owner_less<>{}(a.first, b.first);
        });
        for (auto& [owner, edges] : edges_) {
            static_cast<void>(owner);
            for (auto& entry : edges.weak)
                entry.key = find_shared_node(keys, entry.identity);
        }
    }
    std::size_t collect() {
        std::vector<Node*> pending;
        pending.reserve(nodes_.size());
        const auto mark = [&](Node* node) {
            if (!node->reachable) {
                node->reachable = true;
                pending.push_back(node);
            }
        };
        for (auto* node : nodes_) {
            if (node->owners() < node->incoming + 1)
                throw std::logic_error("A gc_trace over-reports ownership in a weak collection.");
            if (node->owners() > node->incoming + 1)
                mark(node);
        }
        std::unordered_map<Node*, std::vector<const WeakEdges*>> waiting;
        const auto mark_values = [&](const WeakEdges& entry) {
            for (auto* node : entry.values)
                mark(node);
        };
        while (!pending.empty()) {
            auto* node = pending.back();
            pending.pop_back();
            for (auto* child : edges_.at(node).strong)
                mark(child);
            for (const auto& entry : edges_.at(node).weak) {
                if (entry.identity.expired())
                    continue;
                if (!entry.key || entry.key->reachable)
                    mark_values(entry);
                else
                    waiting[entry.key].push_back(&entry);
            }
            if (const auto found = waiting.find(node); found != waiting.end()) {
                for (const auto* entry : found->second)
                    mark_values(*entry);
                waiting.erase(found);
            }
        }
        for (auto& [node, edges] : edges_) {
            static_cast<void>(node);
            for (const auto& entry : edges.weak) {
                if (entry.identity.expired() || (entry.key && !entry.key->reachable))
                    entry.erase(entry.owner, entry.identity);
            }
        }
        std::size_t collected = 0;
        for (auto* node : nodes_) {
            if (!node->reachable) {
                if (node->payload_alive)
                    ++collected;
                node->clear();
            }
        }
        return collected;
    }
};

inline std::size_t collect_ephemerons() {
    registry.collecting = true;
    struct Reset {
        ~Reset() { registry.collecting = false; }
    } reset;
    EphemeronGraph graph;
    graph.discover(registry.nodes);
    return graph.collect();
}

} // namespace bbl::js::gc
