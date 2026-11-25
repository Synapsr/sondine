/// Who the audio on `system:other` belongs to (ADR 026). App tracks are `exact`; the residual is
/// `single-active` when its output comes from one app (all of that app's process objects) or one
/// process with no app, else `ambiguous`.
public enum AttributionPolicy {
    /// Apps whose microphone use means a call.
    public static let callApps: Set<String> = [
        "us.zoom.xos", "com.microsoft.teams2", "com.microsoft.teams", "com.hnc.Discord", "com.apple.FaceTime",
        "com.tinyspeck.slackmacgap", "net.whatsapp.WhatsApp", "com.cisco.webexmeetingsapp", "com.skype.skype",
    ]

    /// `scope` holds the process objects `system:other` captures (not excluded, not on an app track).
    public static func systemLabel(scope: [CatalogProcess]) -> (confidence: AttributionConfidence, bundleId: String?, candidates: [HALObjectID]) {
        let candidates = scope.filter(\.io.runningOutput)
        let owners = Set(candidates.map { process in process.resolution.app?.bundleId ?? "pid:\(process.pid)" })
        if owners.count == 1, let first = candidates.first {
            return (.singleActive, first.resolution.app?.bundleId, candidates.map(\.id))
        }
        return (.ambiguous, nil, candidates.map(\.id))
    }
}
