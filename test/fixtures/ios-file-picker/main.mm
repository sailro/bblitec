#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>
#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>
#import <UIKit/UIKit.h>

#include <cstdlib>
#include <iostream>
#include <utility>

namespace bbl::pal {
std::string environment_variable(const char* name) {
    const char* value = SDL_getenv(name);
    return value ? value : "";
}
} // namespace bbl::pal

enum class FileOperation { None, Save, Open };

@interface FileActions : NSObject {
@public
    bbl::Engine engine;
    FileOperation pending;
}
@property(strong, nonatomic) UILabel* status;
- (void)performPending;
@end

@implementation FileActions
- (void)save:(id)sender {
    (void)sender;
    pending = FileOperation::Save;
}
- (void)open:(id)sender {
    (void)sender;
    pending = FileOperation::Open;
}
- (void)performPending {
    const auto operation = std::exchange(pending, FileOperation::None);
    if (operation == FileOperation::None)
        return;
    try {
        if (operation == FileOperation::Save) {
            const bbl::pal::FileDialogOptions options{"Export fixture", "bblite-fixture.json",
                                                      "JSON", "*.json"};
            const bool saved = bbl::pal::save_file(
                engine, options, std::string_view("{\"value\":\"UIKit document export\"}\n"));
            self.status.text = saved ? @"exported" : @"cancelled";
        } else {
            const bbl::pal::FileDialogOptions options{"Import fixture", "", "JSON", "*.json"};
            const auto selected = bbl::pal::choose_open_file(engine, options);
            if (!selected)
                self.status.text = @"cancelled";
            else {
                const std::string bytes(selected->bytes.begin(), selected->bytes.end());
                if (bytes != "{\"value\":\"UIKit document export\"}\n" ||
                    selected->display_name != "bblite-fixture.json") {
                    throw std::runtime_error("Imported filename or bytes differ.");
                }
                self.status.text = @"imported";
            }
        }
    } catch (const std::exception& error) {
        self.status.text =
            [@"error: " stringByAppendingString:[NSString stringWithUTF8String:error.what()]];
    }
}
@end

int main(int, char**) {
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS))
        return 1;
    SDL_Window* window = SDL_CreateWindow("File Bridge Test", 667, 375, SDL_WINDOW_FULLSCREEN);
    if (!window)
        return 2;
    UIWindow* native = (__bridge UIWindow*)SDL_GetPointerProperty(
        SDL_GetWindowProperties(window), SDL_PROP_WINDOW_UIKIT_WINDOW_POINTER, nullptr);
    if (!native)
        return 3;
    FileActions* actions = [FileActions new];
    actions.status = [[UILabel alloc] initWithFrame:CGRectMake(20, 170, 620, 160)];
    actions.status.numberOfLines = 0;
    actions.status.text = @"ready";
    actions.status.accessibilityIdentifier = @"file-status";
    native.rootViewController.view.backgroundColor = UIColor.whiteColor;
    [native.rootViewController.view addSubview:actions.status];
    NSArray<NSString*>* names = @[ @"Export", @"Import" ];
    for (NSUInteger index = 0; index < names.count; ++index) {
        UIButton* button = [UIButton buttonWithType:UIButtonTypeSystem];
        button.frame = CGRectMake(20 + index * 180, 80, 160, 60);
        button.accessibilityIdentifier = index == 0 ? @"file-export" : @"file-import";
        [button setTitle:names[index] forState:UIControlStateNormal];
        [button addTarget:actions
                      action:index == 0 ? @selector(save:) : @selector(open:)
            forControlEvents:UIControlEventTouchUpInside];
        [native.rootViewController.view addSubview:button];
    }
    for (;;) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT) {
                SDL_DestroyWindow(window);
                SDL_Quit();
                std::exit(0);
            }
        }
        [actions performPending];
        SDL_Delay(10);
    }
}
