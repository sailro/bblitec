#import <XCTest/XCTest.h>

@interface FilePickerTests : XCTestCase
@end

@implementation FilePickerTests
- (void)waitForPicker:(XCUIApplication*)app {
    XCTAssertTrue([app.navigationBars.firstMatch waitForExistenceWithTimeout:60], @"%@", app.debugDescription);
    NSString* documents = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
    XCTAssertTrue([app.screenshot.PNGRepresentation writeToFile:[documents stringByAppendingPathComponent:@"picker.png"] atomically:YES]);
}
- (void)waitForStatus:(NSString*)value application:(XCUIApplication*)app {
    NSPredicate* predicate = [NSPredicate predicateWithFormat:@"label == %@", value];
    [self expectationForPredicate:predicate evaluatedWithObject:app.staticTexts[@"file-status"] handler:nil];
    [self waitForExpectationsWithTimeout:20 handler:nil];
}
- (XCUIElement*)entry:(NSString*)name application:(XCUIApplication*)app {
    NSPredicate* predicate = [NSPredicate predicateWithFormat:@"label BEGINSWITH %@", name];
    XCUIElement* cell = [[app.cells matchingPredicate:predicate] firstMatch];
    if ([cell waitForExistenceWithTimeout:3]) return cell;
    XCUIElement* button = app.buttons[name];
    if (button.exists) return button;
    return [[app.staticTexts matchingPredicate:predicate] firstMatch];
}
- (void)localFolder:(XCUIApplication*)app {
    [self waitForPicker:app];
    XCTAssertTrue([app.buttons[@"Files, Actions Menu"] waitForExistenceWithTimeout:15], @"%@", app.debugDescription);
}
- (void)cancelPicker:(XCUIApplication*)app {
    [self waitForPicker:app];
    for (NSUInteger step = 0; step < 6 && !app.buttons[@"Cancel"].exists; ++step) {
        XCUIElement* back = [app.navigationBars.firstMatch.buttons elementBoundByIndex:0];
        XCTAssertTrue([back waitForExistenceWithTimeout:5], @"%@", app.debugDescription);
        XCTAssertNotEqualObjects(back.label, @"Save");
        [back tap];
    }
    XCTAssertTrue([app.buttons[@"Cancel"] waitForExistenceWithTimeout:10], @"%@", app.debugDescription);
    [app.buttons[@"Cancel"] tap];
}
- (void)testCancellation {
    self.continueAfterFailure = NO;
    XCUIApplication* app = [[XCUIApplication alloc] initWithBundleIdentifier:@"org.bblite.filetest"];
    [app launch];
    XCTAssertTrue([app.buttons[@"file-export"] waitForExistenceWithTimeout:15]);
    [app.buttons[@"file-export"] tap];
    [self cancelPicker:app];
    [self waitForStatus:@"cancelled" application:app];
    [app.buttons[@"file-import"] tap];
    [self cancelPicker:app];
    [self waitForStatus:@"cancelled" application:app];
    [app terminate];
}
- (void)testExportImport {
    self.continueAfterFailure = NO;
    XCUIApplication* app = [[XCUIApplication alloc] initWithBundleIdentifier:@"org.bblite.filetest"];
    [app launch];
    XCTAssertTrue([app.buttons[@"file-export"] waitForExistenceWithTimeout:15]);
    [app.buttons[@"file-export"] tap];
    NSLog(@"Export picker: %@", app.debugDescription);
    [self localFolder:app];
    XCUIElement* save = app.buttons[@"Save"];
    XCTAssertTrue([save waitForExistenceWithTimeout:10], @"%@", app.debugDescription);
    XCTAssertTrue(save.enabled);
    [save tap];
    if ([app.buttons[@"Replace"] waitForExistenceWithTimeout:2]) [app.buttons[@"Replace"] tap];
    [self waitForStatus:@"exported" application:app];
    [app.buttons[@"file-import"] tap];
    XCUIElement* file = [self entry:@"bblite-fixture" application:app];
    if (!file.exists) {
        [self localFolder:app];
        file = [self entry:@"bblite-fixture" application:app];
    }
    XCTAssertTrue([file waitForExistenceWithTimeout:10], @"%@", app.debugDescription);
    [file tap];
    [self waitForStatus:@"imported" application:app];
    [app terminate];
}
@end
