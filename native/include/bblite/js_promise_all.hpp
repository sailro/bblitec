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

template <typename... T, std::size_t... I>
Promise<std::tuple<T...>> all_tuple(const std::tuple<Promise<T>...>& inputs,
                                    std::index_sequence<I...>) {
    using Result = std::tuple<T...>;
    using PendingValues = std::tuple<std::optional<T>...>;
    auto state = make_gc_shared<AllState<PendingValues, Result>>(sizeof...(T));
    if constexpr (sizeof...(T) == 0)
        state->result.resolve(Result{});
    else
        (std::get<I>(inputs).observe(
             make_closure(std::tuple{state},
                          [](auto& environment, const T& value) {
                              auto& owned = *std::get<0>(environment);
                              if (owned.settled)
                                  return;
                              try {
                                  std::get<I>(owned.values) = value;
                                  owned.ready([](const PendingValues& values) {
                                      return std::apply(
                                          [](const auto&... item) { return Result{*item...}; },
                                          values);
                                  });
                              } catch (...) {
                                  owned.reject(std::current_exception());
                              }
                          }),
             make_closure(std::tuple{state},
                          [](auto& environment, std::exception_ptr error) {
                              std::get<0>(environment)->reject(error);
                          })),
         ...);
    return state->result;
}

} // namespace promise_detail

/** Every input is observed immediately; output positions follow input order. */
template <typename... T>
Promise<std::tuple<T...>> promise_all_tuple(const std::tuple<Promise<T>...>& inputs) {
    return promise_detail::all_tuple(inputs, std::index_sequence_for<T...>{});
}

template <typename T> Promise<Array<T>> promise_all(const Array<Promise<T>>& inputs) {
    using PendingValues = std::vector<std::optional<T>>;
    auto state = make_gc_shared<promise_detail::AllState<PendingValues, Array<T>>>(inputs.size());
    state->values.resize(inputs.size());
    if (inputs.empty())
        state->result.resolve(Array<T>{});
    for (std::size_t index = 0; index < inputs.size(); ++index)
        inputs[index].observe(
            make_closure(std::tuple{state, index},
                         [](auto& environment, const T& value) {
                             auto& [retained, position] = environment;
                             auto& owned = *retained;
                             if (owned.settled)
                                 return;
                             try {
                                 owned.values[position] = value;
                                 owned.ready([](const PendingValues& values) {
                                     Array<T> result;
                                     result.reserve(values.size());
                                     for (const auto& item : values)
                                         result.push_back(*item);
                                     return result;
                                 });
                             } catch (...) {
                                 owned.reject(std::current_exception());
                             }
                         }),
            make_closure(std::tuple{state}, [](auto& environment, std::exception_ptr error) {
                std::get<0>(environment)->reject(error);
            }));
    return state->result;
}

/** Settlement records are fresh owned objects supplied by the typed lowering. */
template <typename T, typename Fulfilled, typename Rejected>
auto promise_all_settled(const Array<Promise<T>>& inputs, Fulfilled fulfilled, Rejected rejected) {
    using Result = std::invoke_result_t<Fulfilled&, const T&>;
    Array<Promise<Result>> settlements;
    settlements.reserve(inputs.size());
    for (const auto& input : inputs)
        settlements.push_back(input.then(fulfilled, rejected));
    return promise_all(settlements);
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

template <typename T> Promise<T> promise_race(const Array<Promise<T>>& inputs) {
    Promise<T> result;
    for (const auto& input : inputs)
        observe_race(input, result);
    return result;
}

template <typename T> Promise<T> promise_race(const Array<T>& inputs) {
    Promise<T> result;
    for (const auto& input : inputs)
        observe_race(Promise<T>::resolved(input), result);
    return result;
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

template <typename T> Promise<T> promise_any(const Array<Promise<T>>& inputs) {
    auto state = make_gc_shared<promise_detail::AnyState<T>>(inputs.size());
    if (inputs.empty())
        state->result.reject(
            std::make_exception_ptr(AggregateError({}, "All promises were rejected")));
    for (std::size_t index = 0; index < inputs.size(); ++index)
        promise_detail::observe_any(inputs[index], state, index);
    return state->result;
}

template <typename T> Promise<T> promise_any(const Array<T>& inputs) {
    Array<Promise<T>> promises;
    promises.reserve(inputs.size());
    for (const auto& input : inputs)
        promises.push_back(Promise<T>::resolved(input));
    return promise_any(promises);
}

} // namespace bbl::js
