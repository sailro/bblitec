#include <bblite/pal_worker.hpp>

#include <iostream>

namespace {
using namespace bbl;
using namespace std::chrono_literals;
void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

void counter_module(pal::WorkerRealm& realm) {
    auto count = js::make_ref<double>(0);
    realm.add_message_listener(pal::Worker::MessageCallback(js::make_closure(
        std::tuple{&realm, count}, [](auto& environment, const pal::WorkerMessage& event) {
            auto& [scope, count] = environment;
            *count += event->data<double>();
            scope->post_message(js::serialize_message(*count));
            if (*count == 3) scope->close();
        })));
}

void independent_instances() {
    const js::RealmScope scope;
    pal::EventLoop loop;
    pal::WorkerRealm realm(loop);
    std::vector<std::vector<double>> observed(2);
    std::array<std::shared_ptr<pal::Worker>, 2> workers;
    unsigned completed = 0;
    loop.run([&] {
        for (std::size_t n = 0; n < workers.size(); ++n) {
            workers[n] = realm.create_worker(counter_module);
            workers[n]->add_message_listener([&, n](const pal::WorkerMessage& event) {
                observed[n].push_back(event->data<double>());
                if (observed[n].size() == 2 && ++completed == 2) loop.close();
            });
            workers[n]->post_message(js::serialize_message(1.0));
            workers[n]->post_message(js::serialize_message(2.0));
        }
    });
    for (const auto& values : observed) require(values == std::vector<double>{1, 3}, "Worker instances shared module state");
}

void error_module(pal::WorkerRealm&) { throw std::runtime_error("startup failure"); }

void startup_errors() {
    const js::RealmScope scope;
    pal::EventLoop loop;
    pal::WorkerRealm realm(loop);
    unsigned errors = 0;
    loop.run([&] {
        auto worker = realm.create_worker(error_module);
        worker->add_error_listener([&](pal::WorkerErrorEvent& event) {
            require(event.message == "startup failure", "Worker error was lost");
            event.prevent_default();
            ++errors;
            loop.close();
        });
    });
    require(errors == 1, "Worker startup error was not delivered once");
}

void listener_error_cleanup() {
    const js::RealmScope scope;
    pal::EventLoop loop;
    pal::WorkerRealm realm(loop);
    int phase = 0;
    int errors = 0;
    loop.on_error([&](std::exception_ptr error) {
        try { std::rethrow_exception(error); }
        catch (const std::runtime_error& problem) {
            require(std::string(problem.what()) == "listener failure", "Wrong listener error");
            ++errors;
        }
    });
    loop.run([&] {
        auto worker = realm.create_worker(counter_module);
        worker->add_message_listener([&](const pal::WorkerMessage&) {
            loop.queue_microtask([&] { phase = 1; });
            throw std::runtime_error("listener failure");
        });
        worker->add_message_listener([&](const pal::WorkerMessage&) {
            require(phase == 1, "Listener cleanup did not run its microtask checkpoint");
            phase = 2;
            loop.close();
        });
        worker->post_message(js::serialize_message(3.0));
    });
    require(phase == 2 && errors == 1, "Throwing listener prevented later listener delivery");
}

void busy_module(pal::WorkerRealm& realm) {
    realm.post_message(js::serialize_message(1.0));
    for (;;) realm.loop().checkpoint();
}

void busy_termination() {
    const js::RealmScope scope;
    pal::EventLoop loop;
    pal::WorkerRealm realm(loop);
    std::shared_ptr<pal::Worker> worker;
    loop.run([&] {
        worker = realm.create_worker(busy_module);
        worker->add_message_listener([&](const pal::WorkerMessage&) {
            const auto before = pal::EventLoop::Clock::now();
            worker->terminate();
            require(pal::EventLoop::Clock::now() - before < 500ms, "Worker terminate blocked its parent");
            loop.close();
        });
    });
}

void nested_module(pal::WorkerRealm& realm) {
    auto child = realm.create_worker(counter_module);
    child->add_message_listener([&realm](const pal::WorkerMessage& event) {
        realm.post_message(js::serialize_message(event->data<double>()));
        realm.close();
    });
    child->post_message(js::serialize_message(3.0));
}

void nested_workers() {
    const js::RealmScope scope;
    pal::EventLoop loop;
    pal::WorkerRealm realm(loop);
    double value = 0;
    loop.run([&] {
        auto worker = realm.create_worker(nested_module);
        worker->add_message_listener([&](const pal::WorkerMessage& event) {
            value = event->data<double>();
            loop.close();
        });
    });
    require(value == 3, "Nested worker channel failed");
}

void realm_state_reset() {
    std::size_t first_identity = 0;
    double first_random = 0;
    for (unsigned n = 0; n < 2; ++n) {
        const js::RealmScope scope;
        const auto identity = js::next_callback_identity();
        const auto random = js::random_js();
        require(js::missing_array_value<double>() == 0, "Realm scratch survived prior scope");
        if (n == 0) { first_identity = identity; first_random = random; }
        else require(identity == first_identity && random == first_random, "Realm state was not reset");
        js::missing_array_value<double>() = 12;
    }
}
} // namespace

int main() {
    try {
        independent_instances();
        startup_errors();
        listener_error_cleanup();
        busy_termination();
        nested_workers();
        realm_state_reset();
        std::cout << "Worker service: independent modules, errors, nesting, termination and realm state passed.\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
