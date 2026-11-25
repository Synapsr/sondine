import Darwin
import Foundation

enum ExitCode {
    static let success: Int32 = 0
    static let failure: Int32 = 1
    static let usage: Int32 = 64
}

enum MeterCommand {
    static let usage = """
        usage: sondine-meter <command> [options]

        Read-only resource meter for the always-on budget (architecture §5). It never opens
        audio devices and needs no permission; other users' processes (coreaudiod) are read
        through the setuid /bin/ps and /usr/bin/top.

        commands:
          sample      sample processes to JSON lines
          summarize   turn a sample file into per-process, group and total statistics (JSON)
          list        print matching processes as JSON lines (discovery)

        sample options:
          --pids <a,b,...>            pids to sample
          --match <regex>             also sample processes whose name, executable or path matches;
                                      new matches are picked up every --rediscover-s
          --no-coreaudiod             do not add coreaudiod (added by default for the delta)
          --interval-ms <n>           sampling period (default 1000)
          --duration-s <n>            stop after n seconds (default: until SIGINT or SIGTERM)
          --out <file>                JSON lines output (default stdout)
          --privileged-interval-s <n> top snapshot period for other users' processes (default 60)
          --rediscover-s <n>          --match rescan period (default 10)
          --no-fallback               record other users' processes as denied instead of using ps/top

        summarize options:
          --in <file>                 sample file
          --out <file>                summary JSON (default stdout)
          --group <label>=<a,b,...>   also sum these pids (repeatable)
          --window-s <n>              window for p95 and max rates (default 10)
          --skip-s <n>                ignore the first n seconds (default 0)

        list options:
          --match <regex>             only matching processes (default all)
          --arguments                 include argv (this user's processes only)
        """

    static func run(arguments: [String]) -> Int32 {
        guard let command = arguments.first else {
            fputs(usage + "\n", stderr)
            return ExitCode.usage
        }
        let rest = Array(arguments.dropFirst())
        do {
            switch command {
            case "sample":
                return Sampler.run(try parseSampleOptions(rest))
            case "summarize":
                return Summarizer.run(try parseSummaryOptions(rest))
            case "list":
                return list(try parseListOptions(rest))
            case "--version", "version":
                print("sondine-meter \(MeterFormat.meterVersion)")
                return ExitCode.success
            case "--help", "-h", "help":
                print(usage)
                return ExitCode.success
            default:
                throw UsageError("unknown command \"\(command)\"")
            }
        } catch let error as UsageError {
            fputs("sondine-meter \(command): \(error.message)\n", stderr)
            return ExitCode.usage
        } catch {
            fputs("sondine-meter \(command): \(error)\n", stderr)
            return ExitCode.failure
        }
    }

    struct ListOptions: Equatable {
        var matchPattern: String?
        var arguments = false
    }

    static func list(_ options: ListOptions) -> Int32 {
        let matcher: ProcessMatcher?
        do {
            matcher = try options.matchPattern.map(ProcessMatcher.init(pattern:))
        } catch {
            fputs("sondine-meter list: invalid --match pattern: \(error)\n", stderr)
            return ExitCode.usage
        }
        let own = getpid()
        var lines: [Data] = []
        for pid in ProcessInspector.allPids() where pid != own {
            guard let identity = ProcessInspector.identity(of: pid), matcher?.matches(identity) ?? true else { continue }
            let access: Access = if case .success = ProcessInspector.rusage(of: pid) { .rusage } else { .denied }
            let listed = ListedProcess(
                pid: pid,
                ppid: identity.ppid,
                uid: identity.uid,
                startUs: identity.startUs,
                name: identity.name,
                path: identity.path,
                access: access,
                arguments: options.arguments && access == .rusage ? ProcessInspector.arguments(of: pid) : nil
            )
            if let line = try? JSONLines.encode(listed) { lines.append(line) }
        }
        do {
            try LineWriter(path: nil).write(lines)
        } catch {
            return ExitCode.failure
        }
        return ExitCode.success
    }
}

struct UsageError: Error, Equatable {
    var message: String
    init(_ message: String) { self.message = message }
}

/// Flags with one value each (some repeatable) and boolean switches.
struct ParsedArguments {
    var values: [String: [String]] = [:]
    var switches: Set<String> = []

    init(_ arguments: [String], valued: Set<String>, repeatable: Set<String> = [], switches allowed: Set<String> = []) throws {
        var index = 0
        while index < arguments.count {
            let flag = arguments[index]
            if allowed.contains(flag) {
                switches.insert(flag)
                index += 1
                continue
            }
            guard valued.contains(flag) || repeatable.contains(flag) else { throw UsageError("unknown option \(flag)") }
            guard index + 1 < arguments.count else { throw UsageError("\(flag) needs a value") }
            if values[flag] != nil, !repeatable.contains(flag) { throw UsageError("\(flag) given twice") }
            values[flag, default: []].append(arguments[index + 1])
            index += 2
        }
    }

    func value(_ flag: String) -> String? { values[flag]?.first }

    func positiveInt(_ flag: String, default fallback: Int) throws -> Int {
        guard let text = value(flag) else { return fallback }
        guard let number = Int(text), number > 0 else { throw UsageError("\(flag) must be a positive integer") }
        return number
    }

    func nonNegativeDouble(_ flag: String) throws -> Double? {
        guard let text = value(flag) else { return nil }
        guard let number = Double(text), number.isFinite, number >= 0 else { throw UsageError("\(flag) must be a number ≥ 0") }
        return number
    }
}

func parsePidList(_ text: String) throws -> [Int32] {
    let pids = try text.split(separator: ",").map { part -> Int32 in
        guard let pid = Int32(part.trimmingCharacters(in: .whitespaces)), pid > 0 else {
            throw UsageError("invalid pid \"\(part)\"")
        }
        return pid
    }
    guard !pids.isEmpty else { throw UsageError("empty pid list") }
    return pids
}

func parseSampleOptions(_ arguments: [String]) throws -> SampleOptions {
    let parsed = try ParsedArguments(
        arguments,
        valued: ["--pids", "--match", "--interval-ms", "--duration-s", "--out", "--privileged-interval-s", "--rediscover-s"],
        switches: ["--no-coreaudiod", "--no-fallback"]
    )
    var options = SampleOptions()
    if let pids = parsed.value("--pids") { options.pids = try parsePidList(pids) }
    options.matchPattern = parsed.value("--match")
    options.includeCoreaudiod = !parsed.switches.contains("--no-coreaudiod")
    options.fallback = !parsed.switches.contains("--no-fallback")
    options.intervalMs = try parsed.positiveInt("--interval-ms", default: 1_000)
    options.durationS = try parsed.nonNegativeDouble("--duration-s")
    options.output = parsed.value("--out")
    options.privilegedIntervalS = try parsed.positiveInt("--privileged-interval-s", default: 60)
    options.rediscoverS = try parsed.positiveInt("--rediscover-s", default: 10)
    guard !options.pids.isEmpty || options.matchPattern != nil else {
        throw UsageError("nothing to sample: give --pids or --match")
    }
    return options
}

func parseSummaryOptions(_ arguments: [String]) throws -> SummaryOptions {
    let parsed = try ParsedArguments(arguments, valued: ["--in", "--out", "--window-s", "--skip-s"], repeatable: ["--group"])
    guard let input = parsed.value("--in") else { throw UsageError("--in is required") }
    var options = SummaryOptions(input: input, output: parsed.value("--out"))
    if let window = try parsed.nonNegativeDouble("--window-s") {
        guard window > 0 else { throw UsageError("--window-s must be > 0") }
        options.windowS = window
    }
    options.skipS = try parsed.nonNegativeDouble("--skip-s") ?? 0
    for text in parsed.values["--group"] ?? [] {
        guard let equals = text.firstIndex(of: "="), equals != text.startIndex else {
            throw UsageError("--group needs <label>=<pid,pid,...>")
        }
        let label = String(text[..<equals])
        guard !options.groups.contains(where: { $0.label == label }) else { throw UsageError("group \(label) given twice") }
        options.groups.append(SummaryOptions.Group(label: label, pids: try parsePidList(String(text[text.index(after: equals)...]))))
    }
    return options
}

func parseListOptions(_ arguments: [String]) throws -> MeterCommand.ListOptions {
    let parsed = try ParsedArguments(arguments, valued: ["--match"], switches: ["--arguments"])
    return MeterCommand.ListOptions(matchPattern: parsed.value("--match"), arguments: parsed.switches.contains("--arguments"))
}
