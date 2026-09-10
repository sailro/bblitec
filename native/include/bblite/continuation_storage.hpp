#pragma once
#include <memory>
#include <type_traits>
#include <utility>
#include <vector>

namespace bbl {

/** Locals shared by the deferred parts of one entry invocation. */
class ContinuationStorage {
    struct Entry { virtual ~Entry() = default; };
    template <typename T> struct Local final : Entry {
        T value;
        template <typename Initializer>
        explicit Local(Initializer&& initializer) : value(initializer()) {}
    };
    std::vector<std::unique_ptr<Entry>> locals_;
public:
    template <typename Initializer>
    auto& retain(Initializer&& initializer) {
        using T = std::invoke_result_t<Initializer>;
        auto local = std::make_unique<Local<T>>(std::forward<Initializer>(initializer));
        auto& value = local->value;
        locals_.push_back(std::move(local));
        return value;
    }
};

} // namespace bbl
