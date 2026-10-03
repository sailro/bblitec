#pragma once

#include <bblite/js_callback.hpp>
#include <bblite/js_error.hpp>

#include <algorithm>
#include <exception>
#include <string_view>
#include <vector>

namespace bbl::js {

/** A finite compiled module's immutable identity; exports remain compiler-resolved live bindings. */
struct ModuleNamespace {
    std::string_view key;
    bool operator==(const ModuleNamespace&) const = default;
};

/** A realm's module evaluation retains its bindings and first failure. */
class ModuleActivation {
public:
    explicit ModuleActivation(std::string_view key) : namespace_{key} {}

    void set_initializer(Callback<void()> initializer) { initializer_ = std::move(initializer); }

    void evaluate() {
        if (active_evaluation_ != nullptr) {
            evaluate(*active_evaluation_);
            return;
        }
        Evaluation evaluation;
        active_evaluation_ = &evaluation;
        try {
            evaluate(evaluation);
            active_evaluation_ = nullptr;
        } catch (...) {
            const Error error = std::current_exception();
            for (auto* module : evaluation.stack) {
                module->error_ = error;
                module->state_ = State::failed;
            }
            // Importers own their dependencies through these callbacks.
            // Release in reverse order so every pending module stays alive.
            for (auto entry = evaluation.stack.rbegin(); entry != evaluation.stack.rend(); ++entry)
                (*entry)->initializer_ = {};
            active_evaluation_ = nullptr;
            throw;
        }
    }

    ModuleNamespace module_namespace() const { return namespace_; }
    void gc_trace(const TraceVisitor& visitor) const {
        visitor(initializer_);
        visitor(error_);
    }

private:
    enum class State { pending, evaluating, evaluated, failed };
    struct Evaluation {
        std::vector<ModuleActivation*> stack;
        ModuleActivation* current = nullptr;
        std::size_t next_index = 0;
    };

    // Synchronous evaluation can revisit a cycle before its root completes.
    // Members stay pending together so a root failure rejects every member.
    void evaluate(Evaluation& evaluation) {
        if (state_ == State::failed)
            std::rethrow_exception(error_);
        if (state_ == State::evaluated)
            return;
        auto* importer = evaluation.current;
        if (state_ == State::pending) {
            state_ = State::evaluating;
            index_ = evaluation.next_index++;
            ancestor_ = index_;
            evaluation.stack.push_back(this);
            evaluation.current = this;
            initializer_();
            evaluation.current = importer;
            if (ancestor_ == index_) {
                ModuleActivation* member = nullptr;
                do {
                    member = evaluation.stack.back();
                    evaluation.stack.pop_back();
                    member->state_ = State::evaluated;
                    member->initializer_ = {};
                } while (member != this);
            }
        }
        if (importer != nullptr && state_ == State::evaluating)
            importer->ancestor_ = std::min(importer->ancestor_, ancestor_);
    }

    inline static thread_local Evaluation* active_evaluation_ = nullptr;
    ModuleNamespace namespace_;
    Callback<void()> initializer_;
    Error error_;
    State state_ = State::pending;
    std::size_t index_ = 0;
    std::size_t ancestor_ = 0;
};

} // namespace bbl::js
