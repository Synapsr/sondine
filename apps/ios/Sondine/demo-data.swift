#if DEBUG
import Foundation
import SondinePhone

// The demonstration (`-SondineDemo`, debug builds only): invented recordings
// on the phone and an invented Mac that answers the memory reads, so every
// screen can be shown and captured in the simulator with no real voice, name
// or transcript (ux-redesign.md, « invented data in captures »). Nothing here
// touches the network or the Keychain.

enum DemoData {
    static let macName = "Sondine K7Q2"
    /// The Mac's tags, the latest used first (ADR 039).
    static let macTags = ["idées", "contenu", "jardin", "perso", "récap"]

    /// The paired Mac, reachable at home; the unnamed recording of the
    /// afternoon is on its way.
    static func status(uploading id: UUID?, bytes: Int64) -> PhoneSyncClient.Status {
        var status = PhoneSyncClient.Status()
        var mac = PairedMac(macId: UUID(), pin: String(repeating: "0", count: 64), name: macName, port: 7_317, addrs: [], pairedAtMs: nowMs - 12 * day)
        mac.lastSeenMs = nowMs
        mac.lastSyncMs = nowMs - 60_000
        status.mac = mac
        status.reachable = true
        status.path = .home
        if let id { status.uploads[id] = bytes * 2 / 5 }
        return status
    }

    // Recordings on the phone

    private struct Seed {
        let id: UUID
        let name: String?
        let startMs: Int64
        let minutes: Int
        let mac: MacRecordingState?
        let result: [String: Any]?
    }

    /// Writes the invented recordings into an empty store; answers the one still being sent.
    @discardableResult
    static func seed(_ store: RecordingStore) -> UUID? {
        var uploading: UUID?
        for seed in seeds {
            let header = PhoneRecordingHeader(
                recordingId: seed.id, sessionId: UUID(), part: 1, startedWallMs: seed.startMs, utcOffsetMin: 60,
                deviceId: device, input: .builtIn, previous: nil, app: "0.5.0 (1)")
            guard let (folder, log) = try? store.create(header, atMs: seed.startMs) else { continue }
            let endMs = seed.startMs + Int64(seed.minutes) * 60_000
            try? log.append(RecordingEvent(kind: .ended, atMs: endMs, samples: seed.minutes * 60 * phoneSampleRate, end: .stopped))
            log.close()
            if let name = seed.name { _ = try? store.rename(seed.id, to: name, typedAtMs: endMs) }
            if let mac = seed.mac {
                try? store.updateSync(seed.id) { sync in
                    sync.stored = true
                    sync.mac = mac
                }
            } else {
                // Still on the phone: its audio waits for the Mac.
                try? Data(count: seed.minutes * 1_900_000).write(to: folder.audio)
                uploading = seed.id
            }
            if let result = seed.result, let decoded = decode(PhoneResult.self, result) {
                try? store.writeResult(seed.id, StoredResult(revision: "demo-\(seed.id)", fetchedAtMs: nowMs, result: decoded))
            }
        }
        return uploading
    }

    private static let device = UUID()
    private static let nowMs = Int64(Date.now.timeIntervalSince1970 * 1000)
    private static let day: Int64 = 86_400_000
    private static let todayMs = Int64(Calendar.current.startOfDay(for: .now).timeIntervalSince1970 * 1000)

    /// `hour:minute` on the day `daysAgo` before today, never later than an hour ago.
    private static func at(_ daysAgo: Int64, _ hour: Int64, _ minute: Int64 = 0) -> Int64 {
        let ms = todayMs - daysAgo * day + (hour * 60 + minute) * 60_000
        return min(ms, nowMs - 3_600_000 - daysAgo * 1_000)
    }

    private static let product = UUID(uuidString: "6f1d2a4e-8b3c-4d5e-9f60-1a2b3c4d5e01")!
    private static let afternoon = UUID(uuidString: "6f1d2a4e-8b3c-4d5e-9f60-1a2b3c4d5e02")!
    private static let dinner = UUID(uuidString: "6f1d2a4e-8b3c-4d5e-9f60-1a2b3c4d5e03")!
    private static let morning = UUID(uuidString: "6f1d2a4e-8b3c-4d5e-9f60-1a2b3c4d5e04")!
    private static let interview = UUID(uuidString: "6f1d2a4e-8b3c-4d5e-9f60-1a2b3c4d5e05")!
    private static let workshop = UUID(uuidString: "6f1d2a4e-8b3c-4d5e-9f60-1a2b3c4d5e06")!
    private static let ideas = UUID(uuidString: "6f1d2a4e-8b3c-4d5e-9f60-1a2b3c4d5e07")!

    private static var seeds: [Seed] {
        [
            Seed(id: product, name: "Point produit avec Marie", startMs: at(0, 10, 5), minutes: 48, mac: .ready,
                 result: productResult(startMs: at(0, 10, 5))),
            Seed(id: afternoon, name: nil, startMs: nowMs - 26 * 60_000, minutes: 12, mac: nil, result: nil),
            Seed(id: ideas, name: "Idées de la matinée", startMs: at(0, 8, 40), minutes: 3, mac: .ready,
                 result: ideasResult(startMs: at(0, 8, 40))),
            Seed(id: dinner, name: "Dîner chez Paul", startMs: at(1, 20, 10), minutes: 92, mac: .ready,
                 result: dinnerResult(startMs: at(1, 20, 10))),
            Seed(id: morning, name: nil, startMs: at(1, 9, 10), minutes: 6, mac: .transcribing, result: nil),
            Seed(id: interview, name: "Entretien Lucas", startMs: at(3, 16), minutes: 35, mac: .ready,
                 result: interviewResult(startMs: at(3, 16))),
            Seed(id: workshop, name: nil, startMs: at(6, 11, 20), minutes: 22, mac: .ready,
                 result: workshopResult(startMs: at(6, 11, 20))),
        ]
    }

    // The invented conversations

    private static var me: [String: Any] { ["ordinal": 1, "name": "Téo", "guess": NSNull(), "self": true] }

    private static func speaker(_ ordinal: Int, name: String? = nil, guess: String? = nil) -> [String: Any] {
        ["ordinal": ordinal, "name": name ?? NSNull(), "guess": guess ?? NSNull(), "self": false]
    }

    private static func voice(_ ref: String, _ speaker: [String: Any]) -> [String: Any] {
        var voice = speaker
        voice["ref"] = ref
        return voice
    }

    /// Sentences every few seconds from `startMs`, ids from `firstId`.
    private static func sentences(_ lines: [(Int?, String)], startMs: Int64, firstId: Int) -> [[String: Any]] {
        var at = startMs + 4_000
        return lines.enumerated().map { index, line in
            let length = Int64(max(2_000, line.1.count * 70))
            defer { at += length + 2_500 }
            return ["id": firstId + index, "startMs": at, "endMs": at + length, "speaker": line.0 ?? NSNull(), "text": line.1]
        }
    }

    private static func line(
        _ kind: String, _ text: String, voices: [[String: Any]], sentence: Int, sentences: [[String: Any]],
        done: Bool = false, due: String? = nil, episodeId: Int? = nil
    ) -> [String: Any] {
        let start = sentences.first { ($0["id"] as? Int) == sentence }?["startMs"] ?? 0
        var line: [String: Any] = [
            "kind": kind, "text": text, "voices": voices, "sentenceIds": [sentence], "startMs": start,
            "done": done, "due": due ?? NSNull(),
        ]
        if let episodeId { line["episodeId"] = episodeId }
        return line
    }

    private static func dueIn(_ days: Int) -> String {
        memoryDay(Date.now.addingTimeInterval(TimeInterval(days) * 86_400))
    }

    private static func result(
        _ id: UUID, name: String?, startMs: Int64, minutes: Int, speakers: [[String: Any]],
        sentences: [[String: Any]], journal: [[String: Any]], notes: [[String: Any]] = [], tags: [String] = []
    ) -> [String: Any] {
        [
            "recordingId": id.uuidString.lowercased(), "name": name ?? NSNull(), "startedAtMs": startMs,
            "endedAtMs": startMs + Int64(minutes) * 60_000, "timeUncertain": false, "speakers": speakers,
            "sentences": sentences, "journal": journal, "notes": notes, "tags": tags,
            "audio": ["generation": 1, "startedAtMs": startMs, "durationMs": Int64(minutes) * 60_000],
        ]
    }

    private static let productLines: [(Int?, String)] = [
        (1, "Bon, on fait le point sur la nouvelle version ?"),
        (2, "Oui. Les retours des testeurs sont plutôt bons sur l'accueil."),
        (2, "Par contre, deux personnes ne trouvent pas où reprendre un enregistrement."),
        (1, "On peut mettre « Reprendre » directement sur l'écran verrouillé."),
        (3, "C'est déjà dans l'activité en direct, non ?"),
        (1, "Oui, mais elle n'est pas assez visible."),
        (2, "Je t'envoie le compte rendu des tests jeudi."),
        (1, "Parfait. Et le calendrier ?"),
        (2, "Le zoom au pincement plaît beaucoup, on le garde."),
        (3, "Il faudrait la même chose sur l'iPhone."),
        (1, "Je regarde ça cette semaine."),
        (2, "Alors on se revoit lundi pour décider."),
    ]

    private static func productResult(startMs: Int64) -> [String: Any] {
        let said = sentences(productLines, startMs: startMs, firstId: 100)
        let marie = speaker(2, name: "Marie")
        let lucas = speaker(3, guess: "Lucas")
        return result(
            product, name: "Point produit avec Marie", startMs: startMs, minutes: 48, speakers: [me, marie, lucas],
            sentences: said,
            journal: [
                line("line", "{P1} et {P2} font le point sur la nouvelle version : l'accueil plaît, « Reprendre » se cherche.", voices: [voice("P1", me), voice("P2", marie)], sentence: 100, sentences: said),
                line("line", "Le zoom du calendrier reste ; {P3} le veut aussi sur l'iPhone.", voices: [voice("P3", lucas)], sentence: 108, sentences: said),
                line("commitment", "{P2} envoie le compte rendu des tests à {P1}", voices: [voice("P1", me), voice("P2", marie)], sentence: 106, sentences: said, due: dueIn(3)),
                line("commitment", "{P1} regarde le zoom sur l'iPhone", voices: [voice("P1", me)], sentence: 110, sentences: said, due: dueIn(5)),
            ],
            notes: [["id": 1, "text": "Revoir l'activité en direct avant lundi.", "addedAtMs": startMs + 50 * 60_000]],
            tags: ["contenu"])
    }

    /// A voice note: one voice, which Sondine takes for the user (« Téo ? »), and a tag (ADR 039).
    private static func ideasResult(startMs: Int64) -> [String: Any] {
        let said = sentences([
            (1, "Une idée pour la newsletter : raconter comment je teste l'app chaque matin."),
            (1, "Et un récap de la semaine, court, à lire en deux minutes."),
        ], startMs: startMs, firstId: 500)
        let guessed: [String: Any] = ["ordinal": 1, "name": NSNull(), "guess": "Téo", "self": false, "guessSelf": true]
        return result(
            ideas, name: "Idées de la matinée", startMs: startMs, minutes: 3, speakers: [guessed], sentences: said,
            journal: [], tags: ["idées"])
    }

    private static func dinnerResult(startMs: Int64) -> [String: Any] {
        let said = sentences([
            (2, "Vous restez dormir ? Il est tard."),
            (1, "Non, on rentre, merci. C'était délicieux."),
            (2, "Je te donne la recette du gratin, rappelle-moi de te l'envoyer."),
            (3, "Et pour les vacances, on part toujours en février ?"),
            (1, "Oui, la deuxième semaine. Je réserve le chalet demain."),
        ], startMs: startMs, firstId: 200)
        let paul = speaker(2, name: "Paul")
        let julie = speaker(3, name: "Julie")
        return result(
            dinner, name: "Dîner chez Paul", startMs: startMs, minutes: 92, speakers: [me, paul, julie], sentences: said,
            journal: [
                line("line", "Dîner chez {P2} : les vacances de février se confirment.", voices: [voice("P2", paul)], sentence: 203, sentences: said),
                line("commitment", "{P1} réserve le chalet", voices: [voice("P1", me)], sentence: 204, sentences: said, done: true),
                line("commitment", "{P2} envoie la recette du gratin à {P1}", voices: [voice("P1", me), voice("P2", paul)], sentence: 202, sentences: said),
            ])
    }

    private static func interviewResult(startMs: Int64) -> [String: Any] {
        let said = sentences([
            (1, "Merci d'être venu. Tu peux te présenter en quelques mots ?"),
            (2, "Bien sûr. Je suis développeur iOS depuis six ans, surtout en SwiftUI."),
            (1, "Qu'est-ce qui t'attire chez nous ?"),
            (2, "Le fait que tout reste en local. C'est rare."),
        ], startMs: startMs, firstId: 300)
        let lucas = speaker(2, name: "Lucas")
        return result(
            interview, name: "Entretien Lucas", startMs: startMs, minutes: 35, speakers: [me, lucas], sentences: said,
            journal: [
                line("line", "Entretien avec {P2}, développeur iOS, attiré par le local.", voices: [voice("P2", lucas)], sentence: 301, sentences: said),
                line("commitment", "{P1} rappelle {P2} pour un second entretien", voices: [voice("P1", me), voice("P2", lucas)], sentence: 303, sentences: said, due: dueIn(-1)),
            ])
    }

    private static func workshopResult(startMs: Int64) -> [String: Any] {
        let said = sentences([
            (2, "On commence par les priorités du trimestre."),
            (1, "La synchronisation d'abord, le reste ensuite."),
        ], startMs: startMs, firstId: 400)
        return result(
            workshop, name: nil, startMs: startMs, minutes: 22, speakers: [me, speaker(2)], sentences: said,
            journal: [line("line", "Les priorités du trimestre : la synchronisation d'abord.", voices: [], sentence: 400, sentences: said)])
    }

    // The invented Mac's memory

    /// Answers a memory read as a Mac would.
    @Sendable static func read(_ path: String, _ json: Data) async -> MacRead {
        try? await Task.sleep(for: .milliseconds(180))
        let request = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any] ?? [:]
        let answer: [String: Any]
        switch path {
        case PhoneSync.MemoryRoute.day:
            answer = dayAnswer(request["day"] as? String ?? memoryDay(.now))
        case PhoneSync.MemoryRoute.journal:
            answer = journalAnswer(request["day"] as? String ?? memoryDay(.now))
        case PhoneSync.MemoryRoute.commitments:
            answer = ["status": "commitments", "today": memoryDay(.now), "commitments": openCommitments, "nextBeforeMs": nowMs - 90 * day]
        case PhoneSync.MemoryRoute.conversation:
            answer = conversationAnswer(request["episodeId"] as? Int ?? 0)
        default:
            answer = searchAnswer(request["text"] as? String ?? "")
        }
        guard let data = try? JSONSerialization.data(withJSONObject: answer) else { return .unreachable }
        return .answer(data)
    }

    /// The Mac's own conversations of today, around the phone's.
    private struct MacEpisode {
        let id: Int
        let startMs: Int64
        let minutes: Int
        let context: String
        let people: [String]
        let guesses: [String]
        let apps: [String]
        let firstWords: String
        let lines: [(Int?, String)]
        let journal: [String]
        var phone: UUID?
        var phoneName: String?
    }

    private static var macEpisodes: [MacEpisode] {
        [
            MacEpisode(
                id: 21, startMs: at(0, 9, 2), minutes: 18, context: "call", people: ["Camille"], guesses: [], apps: ["FaceTime"],
                firstWords: "Salut, tu as deux minutes pour le devis ?",
                lines: [(2, "Salut, tu as deux minutes pour le devis ?"), (1, "Oui, vas-y."), (2, "On peut le signer avant vendredi ?"), (1, "Je te l'envoie ce soir.")],
                journal: ["Camille veut signer le devis avant vendredi."]),
            MacEpisode(
                id: 22, startMs: at(0, 10, 5), minutes: 48, context: "in_person", people: ["Marie"], guesses: ["Lucas"], apps: [],
                firstWords: "Bon, on fait le point sur la nouvelle version ?", lines: productLines,
                journal: ["Marie et Téo font le point sur la nouvelle version : l'accueil plaît, « Reprendre » se cherche.", "Le zoom du calendrier reste ; Lucas ? le veut aussi sur l'iPhone."],
                phone: product, phoneName: "Point produit avec Marie"),
            MacEpisode(
                id: 23, startMs: at(0, 12, 40), minutes: 31, context: "call", people: ["Hugo", "Sarah"], guesses: [], apps: ["Zoom"],
                firstWords: "On partage l'écran ?",
                lines: [(2, "On partage l'écran ?"), (3, "Je vois la maquette, c'est beaucoup plus calme."), (1, "Oui, on a retiré presque tout le texte.")],
                journal: ["Hugo et Sarah valident la maquette, beaucoup plus calme."]),
        ]
    }

    private static func episode(_ episode: MacEpisode) -> [String: Any] {
        [
            "episodeId": episode.id, "startedAtMs": episode.startMs, "endedAtMs": episode.startMs + Int64(episode.minutes) * 60_000,
            "context": episode.context, "size": "conversation", "firstWords": episode.firstWords, "people": episode.people,
            "guesses": episode.guesses, "apps": episode.apps,
            "phone": episode.phone.map { ["name": episode.phoneName ?? NSNull(), "recordingId": $0.uuidString.lowercased()] as [String: Any] } ?? NSNull(),
        ]
    }

    private static func dayAnswer(_ day: String) -> [String: Any] {
        let episodes = day == memoryDay(.now) ? macEpisodes.reversed().map(episode) : []
        return ["status": "day", "day": day, "conversations": episodes, "moments": 6, "media": 2, "dictations": 4, "traces": 18]
    }

    private static func journalAnswer(_ day: String) -> [String: Any] {
        guard day == memoryDay(.now) else {
            return ["status": "journal", "day": day, "lines": [], "commitments": [], "pending": 0, "writing": false]
        }
        let lines = macEpisodes.flatMap { episode in
            episode.journal.enumerated().map { index, text in
                ["kind": "line", "text": text, "voices": [], "sentenceIds": [episode.id * 10 + index], "startMs": episode.startMs + Int64(index) * 300_000,
                 "done": false, "due": NSNull(), "episodeId": episode.id] as [String: Any]
            }
        }
        return ["status": "journal", "day": day, "lines": lines, "commitments": todayCommitments, "pending": 0, "writing": false]
    }

    private static var todayCommitments: [[String: Any]] {
        [
            commitment("Envoyer le devis à Camille", episode: 21, startMs: at(0, 9, 10), due: memoryDay(.now)),
            commitment("Marie envoie le compte rendu des tests", episode: 22, startMs: at(0, 10, 30), due: dueIn(3)),
            commitment("Regarder le zoom sur l'iPhone", episode: 22, startMs: at(0, 10, 40), due: dueIn(5)),
            commitment("Relire la maquette avec Sarah", episode: 23, startMs: at(0, 12, 50), done: true),
        ]
    }

    private static var openCommitments: [[String: Any]] {
        todayCommitments.filter { ($0["done"] as? Bool) == false } + [
            commitment("Rappeler Lucas pour un second entretien", episode: 30, startMs: at(3, 16, 20), due: dueIn(-1)),
        ]
    }

    private static func commitment(_ text: String, episode: Int, startMs: Int64, due: String? = nil, done: Bool = false) -> [String: Any] {
        ["kind": "commitment", "text": text, "voices": [], "sentenceIds": [episode * 10], "startMs": startMs, "done": done,
         "due": due ?? NSNull(), "episodeId": episode]
    }

    private static func conversationAnswer(_ id: Int) -> [String: Any] {
        guard let found = macEpisodes.first(where: { $0.id == id }) else { return ["status": "gone"] }
        let speakers: [[String: Any]] = [me] + found.people.enumerated().map { speaker($0.offset + 2, name: $0.element) }
            + found.guesses.map { speaker(found.people.count + 2, guess: $0) }
        let said = sentences(found.lines, startMs: found.startMs, firstId: found.id * 10)
        return ["status": "conversation", "episode": episode(found), "speakers": speakers, "sentences": said, "notes": [], "truncated": false]
    }

    private static func searchAnswer(_ text: String) -> [String: Any] {
        let needle = text.lowercased()
        let found: [[String: Any]] = macEpisodes.compactMap { episode in
            let said = sentences(episode.lines, startMs: episode.startMs, firstId: episode.id * 10)
            let hits: [[String: Any]] = said.compactMap { sentence in
                guard let words = sentence["text"] as? String, let range = words.lowercased().range(of: needle) else { return nil }
                let start = words.utf16.distance(from: words.startIndex, to: range.lowerBound)
                let speakerOrdinal = sentence["speaker"] as? Int
                return [
                    "sentenceId": sentence["id"] ?? 0, "startMs": sentence["startMs"] ?? 0, "endMs": sentence["endMs"] ?? 0,
                    "text": words, "highlights": [["start": start, "end": start + needle.utf16.count]],
                    "speaker": speakerOrdinal.map { $0 == 1 ? me : speaker($0, name: episode.people.first) } ?? NSNull(),
                ]
            }
            guard !hits.isEmpty else { return nil }
            return ["episode": self.episode(episode), "hitCount": hits.count, "hits": hits, "notes": []]
        }
        return ["status": "results", "episodes": found, "total": found.count, "untranscribed": 0, "nextOffset": NSNull()]
    }

    private static func decode<Value: Decodable>(_ type: Value.Type, _ object: [String: Any]) -> Value? {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            print("demo: \(type) did not decode: \(error)")
            return nil
        }
    }
}
#endif
