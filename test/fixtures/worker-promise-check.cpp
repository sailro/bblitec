#include <bblite/js_promise.hpp>
#include <bblite/js_promise_all.hpp>
#include <bblite/js_realm_state.hpp>
#include <bblite/pal_frame_driver.hpp>
#include <bblite/pal_iteration.hpp>
#include <bblite/pal_async_engine.hpp>

#include <iostream>

namespace {
int asset_loads = 0;
}
namespace bbl {
AssetHandle load_gltf(Engine&, const std::string& path) {
    ++asset_loads;
    if (path == "missing")
        throw std::runtime_error("fixture asset unavailable");
    return {17};
}
} // namespace bbl

namespace {
using namespace bbl;
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

js::Promise<double> compute(js::Promise<double> input, std::vector<int>* order) {
    order->push_back(1);
    const double value = co_await input;
    order->push_back(3);
    co_return value * 2;
}

js::Promise<js::PromiseVoid> await_result_view(js::Promise<std::optional<double>> input,
                                               std::vector<int>* order) {
    require(co_await input == std::optional<double>{7}, "Promise view lost its awaited result");
    order->push_back(3);
    co_return js::PromiseVoid{};
}

void result_views_preserve_protocol() {
    for (const bool settled : {false, true}) {
        const js::RealmScope realm;
        pal::EventLoop loop;
        std::vector<int> order;
        loop.run([&] {
            auto source = settled ? js::Promise<double>::resolved(7) : js::Promise<double>{};
            auto view = js::Promise<std::optional<double>>::view(
                source, [](double value) { return std::optional<double>{value}; });
            require(source == view && source.pending() == view.pending(),
                    "Promise view changed identity or settlement");
            source.then([&](double) { order.push_back(1); });
            view.then([&](std::optional<double> value) {
                require(value == 7, "Promise view conversion failed");
                order.push_back(2);
            });
            await_result_view(view, &order);
            source.then([&](double) {
                order.push_back(4);
                loop.close();
            });
            js::collect_cycles();
            if (!settled)
                source.resolve(7);
        });
        require(order == std::vector<int>{1, 2, 3, 4},
                "Promise view changed microtask registration order");
    }
    const js::RealmScope realm;
    pal::EventLoop loop;
    int completed = 0, unhandled = 0;
    loop.on_unhandled_rejection([&](std::exception_ptr) { ++unhandled; });
    loop.run([&] {
        auto absent = js::Promise<js::PromiseVoid>::resolved({});
        auto view = js::Promise<std::optional<double>>::view(
            absent, [](const js::PromiseVoid&) { return std::optional<double>{}; });
        require(view == absent, "Undefined promise view changed identity");
        auto done = [&] {
            if (++completed == 2)
                loop.close();
        };
        view.then([done](std::optional<double> value) {
            require(!value, "Undefined promise acquired a value");
            done();
        });
        auto rejected =
            js::Promise<double>::rejected(std::make_exception_ptr(std::runtime_error("failure")));
        auto failure = js::Promise<std::optional<double>>::view(
            rejected, [](double value) { return std::optional<double>{value}; });
        failure.catch_error([done](std::exception_ptr error) {
            require(js::promise_error_message(error) == "failure",
                    "Promise view replaced its rejection");
            done();
            return std::optional<double>{};
        });
        std::weak_ptr<int> released;
        {
            auto token = std::make_shared<int>(1);
            released = token;
            js::Promise<double> source;
            auto cycle = js::Promise<std::optional<double>>::view(
                source, [](double value) { return std::optional<double>{value}; });
            source.observe(js::make_closure(std::tuple{cycle, token}, [](auto&, double) {}),
                           [](std::exception_ptr) {});
        }
        js::collect_cycles();
        require(released.expired(), "Promise result view retained an unreachable cycle");
    });
    require(completed == 2 && unhandled == 0, "Promise view lost completion or rejection handling");
}

void ordering_and_recovery() {
    const js::RealmScope realm;
    pal::EventLoop loop;
    std::vector<int> order;
    double result = 0;
    loop.run([&] {
        auto input = js::Promise<double>::resolved(4);
        compute(input, &order)
            .then([&](double value) {
                order.push_back(4);
                return js::Promise<double>::resolved(value + 1);
            })
            .then([&](double value) {
                result = value;
                throw std::runtime_error("reaction failure");
            })
            .catch_error([&](std::exception_ptr error) {
                require(js::promise_error_message(error) == "reaction failure",
                        "Rejection lost its error");
                order.push_back(5);
                loop.close();
            });
        order.push_back(2);
    });
    require(order == std::vector<int>{1, 2, 3, 4, 5} && result == 9,
            "Promise reactions ran in the wrong order");
}

void aggregate_promises() {
    const js::RealmScope realm;
    pal::EventLoop loop;
    int completed = 0;
    int unhandled = 0;
    bool synchronous = true;
    loop.on_unhandled_rejection([&](std::exception_ptr) { ++unhandled; });
    loop.run([&] {
        auto done = [&] {
            require(!synchronous, "Aggregate reaction ran synchronously");
            if (++completed == 4)
                loop.close();
        };
        js::Promise<double> first, second;
        js::promise_all_tuple(std::tuple{first, second, js::Promise<std::string>::resolved("tail")})
            .then([&, done](const auto& values) {
                require(std::get<0>(values) == 1 && std::get<1>(values) == 2 &&
                            std::get<2>(values) == "tail",
                        "Tuple aggregation lost input order");
                done();
            });
        js::promise_all(js::Array<js::Promise<double>>{first, second})
            .then([&, done](const auto& values) {
                require(values.size() == 2 && values[0] == 1 && values[1] == 2,
                        "Array aggregation lost input order");
                done();
            });
        js::promise_all_tuple(std::tuple{}).then([done](const auto&) { done(); });
        js::Promise<double> rejected, later;
        js::promise_all_tuple(std::tuple{rejected, later})
            .observe([](const auto&) { require(false, "Rejected aggregate fulfilled"); },
                     [done](std::exception_ptr error) {
                         require(js::promise_error_message(error) == "first",
                                 "Aggregate rejection changed");
                         done();
                     });
        rejected.reject(std::make_exception_ptr(std::runtime_error("first")));
        later.reject(std::make_exception_ptr(std::runtime_error("later")));
        second.resolve(2);
        loop.post([first] { first.resolve(1); });
        require(completed == 0, "Aggregate result ran before microtasks");
        synchronous = false;
    });
    require(completed == 4 && unhandled == 0, "Aggregate left an input rejection unhandled");
}

struct Owned {
    std::thread::id owner = std::this_thread::get_id();
    int* destroyed;
    ~Owned() {
        require(owner == std::this_thread::get_id(), "Coroutine destroyed outside its realm");
        ++*destroyed;
    }
};

js::Promise<js::PromiseVoid> waiting(js::Promise<double> signal, int* destroyed) {
    Owned owned{std::this_thread::get_id(), destroyed};
    const auto value = co_await signal;
    static_cast<void>(value);
    require(false, "A closed realm resumed suspended source code");
    co_return js::PromiseVoid{};
}

void shutdown_releases_suspended_activations() {
    const js::RealmScope realm;
    pal::EventLoop loop;
    int destroyed = 0;
    loop.run([&] {
        js::Promise<double> signal;
        waiting(signal, &destroyed);
        loop.close();
    });
    require(destroyed == 1, "Suspended activation survived realm shutdown");
}

void unhandled_rejections_reach_the_realm_error_handler() {
    const js::RealmScope realm;
    pal::EventLoop loop;
    int failures = 0;
    loop.on_error([&](std::exception_ptr error) {
        require(js::promise_error_message(error) == "unhandled",
                "Default rejection report lost its error");
        ++failures;
        loop.close();
    });
    loop.run([&] {
        static_cast<void>(js::Promise<double>::rejected(
            std::make_exception_ptr(std::runtime_error("unhandled"))));
    });
    require(failures == 1, "Unhandled rejection disappeared without a dedicated listener");
}

int frame_steps = 0;
int frame_cleanup = 0;
int preparation_steps = 0;
pal::Iteration<bool> renderer_preparation() {
    bool timer_ran = false;
    pal::EventLoop::current().set_timeout([&] { timer_ran = true; }, 0);
    ++preparation_steps;
    co_yield false;
    require(timer_ran, "GPU preparation blocked the realm's loading timer");
    ++preparation_steps;
    co_return true;
}
pal::FrameDriver renderer_activation(Engine& engine) {
    const auto cleanup = js::finally([&] {
        require(pal::OffscreenRun::current() == engine.offscreen_run.get(),
                "Renderer cleanup lost its canvas binding");
        ++frame_cleanup;
    });
    require(pal::OffscreenRun::current() == engine.offscreen_run.get(),
            "Renderer activation lost its canvas binding");
    auto preparation = renderer_preparation();
    while (preparation.advance())
        co_yield false;
    ++frame_steps;
    co_yield false; // No output image was available yet.
    ++frame_steps;
    co_yield true;
    require(false, "Closed realm resumed its renderer");
    co_return true;
}

void renderer_tasks_yield_and_retire() {
    const js::RealmScope realm;
    pal::EventLoop loop;
    auto frames = std::make_shared<pal::AnimationFrameSource>();
    pal::OffscreenSurface surface(32, 32, frames);
    pal::OffscreenDevice device;
    Engine engine;
    engine.offscreen_run = std::make_shared<pal::OffscreenRun>(surface, device);
    bool timer_ran = false;
    loop.run([&] {
        auto driver = renderer_activation(engine);
        driver.ready().observe(
            [&](const js::PromiseVoid&) {
                require(frame_steps == 2 && preparation_steps == 2 && timer_ran,
                        "Readiness preceded output or renderer prevented timer dispatch");
                require(!pal::OffscreenRun::current(),
                        "Renderer leaked its canvas binding into a reaction");
                loop.close();
            },
            [](std::exception_ptr error) { std::rethrow_exception(error); });
        driver.start();
        loop.set_timeout([frames] { frames->tick(pal::EventLoop::Clock::now()); }, 1, true);
        loop.set_timeout([&] { timer_ran = true; }, 0);
    });
    require(frame_cleanup == 1 && !pal::OffscreenRun::current(),
            "Renderer frame survived shutdown or kept its canvas bound");
}

void asset_tasks_preserve_owners_and_errors() {
    const js::RealmScope realm;
    pal::EventLoop loop;
    int completed = 0;
    loop.run([&] {
        auto engine = std::make_shared<Engine>();
        engine->realm_owner = engine;
        const auto first = pal::load_realm_gltf(*engine, "ready");
        const auto failed = pal::load_realm_gltf(*engine, "missing");
        require(asset_loads == 0 && first.pending() && failed.pending(),
                "Asset decoding blocked its promise creation");
        const std::weak_ptr<Engine> weak = engine;
        engine.reset();
        require(!weak.expired(), "Pending asset work lost its engine");
        const auto finish = [&] {
            if (++completed == 2)
                loop.close();
        };
        first.observe(
            [finish](const AssetHandle& value) {
                require(value.value == 17, "Asset task returned the wrong handle");
                finish();
            },
            [](std::exception_ptr error) { std::rethrow_exception(error); });
        failed.observe([](const AssetHandle&) { require(false, "Asset failure resolved"); },
                       [finish](std::exception_ptr error) {
                           try {
                               std::rethrow_exception(error);
                           } catch (const std::runtime_error& failure) {
                               require(std::string_view(failure.what()) ==
                                           "fixture asset unavailable",
                                       "Asset failure lost its source error");
                           }
                           finish();
                       });
    });
    require(completed == 2 && asset_loads == 2, "Asset tasks repeated or lost a decode");
}
} // namespace

int main() {
    try {
        ordering_and_recovery();
        result_views_preserve_protocol();
        aggregate_promises();
        shutdown_releases_suspended_activations();
        unhandled_rejections_reach_the_realm_error_handler();
        renderer_tasks_yield_and_retire();
        asset_tasks_preserve_owners_and_errors();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
