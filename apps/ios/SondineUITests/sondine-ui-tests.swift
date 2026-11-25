import XCTest

/// The short UI test of `pnpm test:ios`: the first run, a recording made and
/// stopped, its row on the home screen, « Mac » before pairing, and the
/// Mac's memory (the search) saying it needs a paired Mac. On a
/// scripted audio session and a tone (`-SondineUITest`), so no microphone,
/// no network and no permission prompt.
final class SondineUITests: XCTestCase {
    @MainActor
    func testFirstRunThenARecordingAppearsOnTheHomeScreen() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-SondineUITest", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        let next = app.buttons["first-run-next"]
        XCTAssertTrue(next.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Sondine records when you ask"].exists)
        next.tap()
        XCTAssertTrue(app.staticTexts["Every voice nearby is recorded"].waitForExistence(timeout: 5))
        next.tap()
        XCTAssertEqual(next.label, "Allow the microphone")
        next.tap()

        let record = app.buttons["record"]
        XCTAssertTrue(record.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["No recording yet"].exists)
        record.tap()

        let elapsed = app.staticTexts["elapsed"]
        XCTAssertTrue(elapsed.waitForExistence(timeout: 5))
        // The tone flows: the clock moves past its first second.
        let moved = NSPredicate(format: "label != %@", "0:00:00")
        expectation(for: moved, evaluatedWith: elapsed)
        waitForExpectations(timeout: 5)
        app.buttons["stop"].tap()

        let row = app.descendants(matching: .any)["recording-row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.label.contains("On the phone"))
        row.tap()
        app.descendants(matching: .any)["recording-actions"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Delete…"].waitForExistence(timeout: 5))
        // The menu closes with a touch outside it.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.9)).tap()
        let back = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()

        // Not paired: the Mac's mark says so and opens the pairing's first page.
        let mac = app.buttons["mac"]
        XCTAssertTrue(mac.waitForExistence(timeout: 5))
        XCTAssertEqual(mac.label, "Mac: not paired")
        mac.tap()
        XCTAssertTrue(app.staticTexts["Pair this iPhone with your Mac"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["pair-scan"].exists)
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // The Mac's memory is read live: without a paired Mac, the search says so,
        // and the day's journal stays off the home screen.
        XCTAssertFalse(app.buttons["today"].exists)
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("budget\n")
        let searched = app.staticTexts["Pair this iPhone with your Mac to search its memory."]
        XCTAssertTrue(searched.waitForExistence(timeout: 5))
    }

    /// The same screens in French, from the String Catalog, kept as screenshots in the result.
    @MainActor
    func testTheScreensSpeakFrench() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-SondineUITest", "-AppleLanguages", "(fr)", "-AppleLocale", "fr_FR"]
        app.launch()

        let next = app.buttons["first-run-next"]
        XCTAssertTrue(next.waitForExistence(timeout: 10))
        XCTAssertEqual(next.label, "Continuer")
        keep(app, "1-premiere-ouverture")
        next.tap()
        XCTAssertTrue(app.staticTexts["Toutes les voix proches sont enregistrées"].waitForExistence(timeout: 5))
        keep(app, "2-premiere-ouverture-voix")
        next.tap()
        XCTAssertEqual(next.label, "Autoriser le micro")
        next.tap()

        let record = app.buttons["record"]
        XCTAssertTrue(record.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Aucun enregistrement"].exists)
        keep(app, "3-accueil")
        record.tap()
        let elapsed = app.staticTexts["elapsed"]
        XCTAssertTrue(elapsed.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "label != %@", "0:00:00"), evaluatedWith: elapsed)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(app.buttons["stop"].label, "Arrêter")
        keep(app, "4-enregistrement-en-cours")
        app.buttons["stop"].tap()

        let row = app.descendants(matching: .any)["recording-row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.label.contains("Sur le téléphone"))
        keep(app, "5-accueil-avec-un-enregistrement")
        row.tap()
        app.descendants(matching: .any)["recording-actions"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Supprimer…"].waitForExistence(timeout: 5))
        keep(app, "6-un-enregistrement")
        // The menu closes with a touch outside it.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.9)).tap()
        let back = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()
        app.buttons["Réglages"].tap()
        XCTAssertTrue(app.staticTexts["Expire le"].waitForExistence(timeout: 5))
        keep(app, "7-reglages")
        app.buttons["settings-mac"].tap()
        XCTAssertTrue(app.staticTexts["Appairer cet iPhone avec votre Mac"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["pair-scan"].label, "Scanner le code")
        keep(app, "8-mac")
    }

    @MainActor
    private func keep(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
