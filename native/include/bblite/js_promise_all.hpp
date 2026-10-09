#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_promise.hpp>

namespace bbl::js {
namespace promise_detail {

template <typename PendingValues, typename Result> struct AllState {
    Promise<Result> result;
    PendingValues values;
    std::size_t remaining;
    bool settled = false;
    explicit AllState(std::size_t count) : remaining(count) {}
    void gc_trace(const TraceVisitor& visitor) const {
        visitor(result);
        visitor(values);
    }
    void reject(std::exception_ptr error) {
        if (settled)
            return;
        settled = true;
        result.reject(error);
    }
    template <typename Finish> void ready(Finish finish) {
        if (--remaining != 0 || settled)
            return;
        result.resolve(finish(values));
        settled = true;
    }
};

template <std::size_t Index, typename State, typename Handler, typename Input>
void settle_all_tuple_element(const State& state, Handler& handler, const Input& value) {
    if (state->settled)
        return;
    try {
        std::get<Index>(state->values) = handler(value);
        state->ready([](const auto& values) {
            return std::apply([](const auto&... item) { return std::tuple{*item...}; }, values);
        });
    } catch (const pal::WorkerTerminated&) {
        throw;
    } catch (...) {
        state->reject(std::current_exception());
    }
}

template <typename... T, typename... Fulfilled, typename... Rejected, std::size_t... I>
auto all_tuple(const std::tuple<Promise<T>...>& inputs, const std::tuple<Fulfilled...>& fulfilled,
               const std::tuple<Rejected...>& rejected, std::index_sequence<I...>) {
    using Result = std::tuple<std::invoke_result_t<Fulfilled&, const T&>...>;
    using PendingValues = std::tuple<std::optional<std::invoke_result_t<Fulfilled&, const T&>>...>;
    auto state = make_gc_shared<AllState<PendingValues, Result>>(sizeof...(T));
    if constexpr (sizeof...(T) == 0)
        state->result.resolve(Result{});
    else
        (std::get<I>(inputs).observe(
             make_closure(std::tuple{state, std::get<I>(fulfilled)},
                          [](auto& environment, const T& value) {
                              auto& [retained, handler] = environment;
                              settle_all_tuple_element<I>(retained, handler, value);
                          }),
             make_closure(std::tuple{state, std::get<I>(rejected)},
                          [](auto& environment, std::exception_ptr error) {
                              auto& [retained, handler] = environment;
                              settle_all_tuple_element<I>(retained, handler, error);
                          })),
         ...);
    return state->result;
}

} // namespace promise_detail

/** Every input is observed immediately; output positions follow input order. */
template <typename... T>
Promise<std::tuple<T...>> promise_all_tuple(const std::tuple<Promise<T>...>& inputs) {
    return promise_detail::all_tuple(
        inputs, std::tuple{([](const T& value) { return value; })...},
        std::tuple{([](std::exception_ptr error) -> T { std::rethrow_exception(error); })...},
        std::index_sequence_for<T...>{});
}

template <typename... T, typename... Fulfilled, typename... Rejected>
auto promise_all_settled_tuple(const std::tuple<Promise<T>...>& inputs,
                               const std::tuple<Fulfilled...>& fulfilled,
                               const std::tuple<Rejected...>& rejected) {
    return promise_detail::all_tuple(inputs, fulfilled, rejected, std::index_sequence_for<T...>{});
}

namespace promise_detail {

/** What an aggregate array holds for one fulfillment: a void fulfillment is undefined. */
template <typename T> struct AllElement {
    using type = T;
    static T from(const T& value) { return value; }
};
template <> struct AllElement<PromiseVoid> {
    using type = Undefined;
    static Undefined from(const PromiseVoid&) { return {}; }
};

template <typename T> Array<T> finish_all_array(const std::vector<std::optional<T>>& values) {
    Array<T> result;
    result.reserve(values.size());
    for (const auto& item : values)
        result.push_back(*item);
    return result;
}

template <typename Stored, typename State, typename Handler, typename Input>
void settle_all_element(const State& state, std::size_t index, Handler& handler,
                        const Input& value) {
    if (state->settled)
        return;
    try {
        state->values[index] = handler(value);
        state->ready(finish_all_array<Stored>);
    } catch (const pal::WorkerTerminated&) {
        throw;
    } catch (...) {
        state->reject(std::current_exception());
    }
}

/** Register each observation before advancing an effectful iterable. */
template <typename Iterable, typename Fulfilled, typename Rejected, typename Resolve>
auto all_iterable(const Iterable& inputs, Fulfilled fulfilled, Rejected rejected, Resolve resolve) {
    using Input = std::remove_cvref_t<decltype(*inputs.begin())>;
    using T = ResultType<std::remove_cvref_t<std::invoke_result_t<Resolve&, const Input&>>>;
    using Stored = std::invoke_result_t<Fulfilled&, const T&>;
    using PendingValues = std::vector<std::optional<Stored>>;
    auto state = make_gc_shared<AllState<PendingValues, Array<Stored>>>(1);
    try {
        if constexpr (requires { inputs.size(); })
            state->values.reserve(inputs.size());
        for (const auto& input : inputs) {
            const auto index = state->values.size();
            state->values.emplace_back();
            ++state->remaining;
            resolve(input).observe(
                make_closure(std::tuple{state, index, fulfilled},
                             [](auto& environment, const T& value) {
                                 auto& [retained, position, handler] = environment;
                                 settle_all_element<Stored>(retained, position, handler, value);
                             }),
                make_closure(std::tuple{state, index, rejected},
                             [](auto& environment, std::exception_ptr error) {
                                 auto& [retained, position, handler] = environment;
                                 settle_all_element<Stored>(retained, position, handler, error);
                             }));
        }
        state->ready(finish_all_array<Stored>);
    } catch (const pal::WorkerTerminated&) {
        throw;
    } catch (...) {
        state->reject(std::current_exception());
    }
    return state->result;
}

} // namespace promise_detail

template <typename Iterable, typename Resolve = std::identity>
auto promise_all(const Iterable& inputs, Resolve resolve = {}) {
    using Input = std::remove_cvref_t<decltype(*inputs.begin())>;
    using Element = promise_detail::AllElement<promise_detail::ResultType<
        std::remove_cvref_t<std::invoke_result_t<Resolve&, const Input&>>>>;
    return promise_detail::all_iterable(
        inputs, [](const auto& value) { return Element::from(value); },
        [](std::exception_ptr error) -> typename Element::type { std::rethrow_exception(error); },
        std::move(resolve));
}

/** Settlement records are fresh owned objects supplied by the typed lowering. */
template <typename Iterable, typename Fulfilled, typename Rejected,
          typename Resolve = std::identity>
auto promise_all_settled(const Iterable& inputs, Fulfilled fulfilled, Rejected rejected,
                         Resolve resolve = {}) {
    return promise_detail::all_iterable(inputs, std::move(fulfilled), std::move(rejected),
                                        std::move(resolve));
}

/** Observing every competitor also handles rejections after the race has settled. */
template <typename T> void observe_race(const Promise<T>& input, const Promise<T>& result) {
    input.observe(make_closure(std::tuple{result},
                               [](auto& environment, const T& value) {
                                   std::get<0>(environment).resolve(value);
                               }),
                  make_closure(std::tuple{result}, [](auto& environment, std::exception_ptr error) {
                      std::get<0>(environment).reject(error);
                  }));
}

template <typename T, typename... Inputs>
Promise<T> promise_race_tuple(const std::tuple<Inputs...>& inputs) {
    Promise<T> result;
    std::apply([&](const auto&... input) { (observe_race(input, result), ...); }, inputs);
    return result;
}

template <typename Iterable, typename Resolve>
auto promise_race(const Iterable& inputs, Resolve resolve) {
    using Input = std::remove_cvref_t<decltype(*inputs.begin())>;
    using T = promise_detail::ResultType<
        std::remove_cvref_t<std::invoke_result_t<Resolve&, const Input&>>>;
    Promise<T> result;
    try {
        for (const auto& input : inputs)
            observe_race(resolve(input), result);
    } catch (const pal::WorkerTerminated&) {
        throw;
    } catch (...) {
        result.reject(std::current_exception());
    }
    return result;
}

template <typename T> Promise<T> promise_race(const Array<Promise<T>>& inputs) {
    return promise_race(inputs, std::identity{});
}

template <typename T> Promise<T> promise_race(const Array<T>& inputs) {
    return promise_race(inputs, [](const T& input) { return Promise<T>::resolved(input); });
}

namespace promise_detail {

template <typename T> struct AnyState {
    Promise<T> result;
    std::vector<std::exception_ptr> errors;
    std::size_t remaining;
    explicit AnyState(std::size_t count) : errors(count), remaining(count) {}
    void gc_trace(const TraceVisitor& visitor) const { visitor(result); }
    /** Every input rejected: an AggregateError of their reasons in input order. */
    void rejected(std::size_t index, std::exception_ptr error) {
        errors[index] = error;
        finish_one();
    }
    void finish_one() {
        if (--remaining == 0)
            result.reject(
                std::make_exception_ptr(AggregateError(errors, "All promises were rejected")));
    }
};

template <typename T, typename State>
void observe_any(const Promise<T>& input, const State& state, std::size_t index) {
    input.observe(
        make_closure(std::tuple{state},
                     [](auto& environment, const T& value) {
                         std::get<0>(environment)->result.resolve(value);
                     }),
        make_closure(std::tuple{state, index}, [](auto& environment, std::exception_ptr error) {
            auto& [retained, position] = environment;
            retained->rejected(position, error);
        }));
}

} // namespace promise_detail

/** The first fulfillment wins; an empty input or one whose inputs all reject rejects. */
template <typename T, typename... Inputs>
Promise<T> promise_any_tuple(const std::tuple<Inputs...>& inputs) {
    auto state = make_gc_shared<promise_detail::AnyState<T>>(sizeof...(Inputs));
    if constexpr (sizeof...(Inputs) == 0)
        state->result.reject(
            std::make_exception_ptr(AggregateError({}, "All promises were rejected")));
    else
        std::apply(
            [&](const auto&... input) {
                std::size_t index = 0;
                (promise_detail::observe_any(input, state, index++), ...);
            },
            inputs);
    return state->result;
}

template <typename Iterable, typename Resolve>
auto promise_any(const Iterable& inputs, Resolve resolve) {
    using Input = std::remove_cvref_t<decltype(*inputs.begin())>;
    using T = promise_detail::ResultType<
        std::remove_cvref_t<std::invoke_result_t<Resolve&, const Input&>>>;
    auto state = make_gc_shared<promise_detail::AnyState<T>>(0);
    state->remaining = 1;
    try {
        if constexpr (requires { inputs.size(); })
            state->errors.reserve(inputs.size());
        for (const auto& input : inputs) {
            const auto index = state->errors.size();
            state->errors.emplace_back();
            ++state->remaining;
            promise_detail::observe_any(resolve(input), state, index);
        }
        state->finish_one();
    } catch (const pal::WorkerTerminated&) {
        throw;
    } catch (...) {
        state->result.reject(std::current_exception());
    }
    return state->result;
}

template <typename T> Promise<T> promise_any(const Array<Promise<T>>& inputs) {
    return promise_any(inputs, std::identity{});
}

template <typename T> Promise<T> promise_any(const Array<T>& inputs) {
    return promise_any(inputs, [](const T& input) { return Promise<T>::resolved(input); });
}

} // namespace bbl::js
