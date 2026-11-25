import CoreText
import SwiftUI

// The Mac's design tokens, for the phone and its widget extension (the Live
// Activity, the control): the same ink, neutrals, spacing, corners, type and
// motion, copied from Graphical's theme (graphical/generated/theme.css), in
// the Mac's face, Allo (`Fonts/`, SIL OFL, its WOFF2 read by Core Text).
// The accent is ink, black in light mode and white in dark (ADR 037); red
// marks only a recording under way and what went wrong (U9).

enum Theme {
    /// `color-1`, `neutral-10`: ink. Primary actions, text, the day shown.
    static let ink = Color(light: 0x000000, dark: 0xFFFFFF)
    /// What sits on ink: `neutral-1`.
    static let onInk = Color(light: 0xFFFFFF, dark: 0x000000)
    /// `error`: a recording under way, and what went wrong.
    static let danger = Color(red: 0xFC / 255, green: 0x03 / 255, blue: 0x2D / 255)
    static let success = Color(red: 0, green: 0x90 / 255, blue: 0x6C / 255)

    /// `neutral-1`: the canvas.
    static let canvas = Color(light: 0xFFFFFF, dark: 0x000000)
    /// `neutral-2`: a quiet surface on the canvas.
    static let raised = Color(light: 0xFBFBFB, dark: 0x202020)
    /// `neutral-3`: a tile, a field, a pressed row.
    static let surface = Color(light: 0xF4F4F4, dark: 0x2B2B2B)
    /// `neutral-4`: hairlines and rings.
    static let line = Color(light: 0xE7E7E7, dark: 0x3D3D3D)
    /// `neutral-5`: what cannot be reached (days to come).
    static let faint = Color(light: 0xCDCDCD, dark: 0x565656)
    /// `neutral-10` and `neutral-7`: text, and muted text.
    static let text = Color(light: 0x000000, dark: 0xFFFFFF)
    static let muted = Color(light: 0x7D7D7D, dark: 0xABABAB)

    enum Space {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 8
        static let s: CGFloat = 13
        static let m: CGFloat = 17
        static let l: CGFloat = 25
        static let xl: CGFloat = 34
        static let xxl: CGFloat = 51
    }

    enum Radius {
        static let xs: CGFloat = 8
        static let s: CGFloat = 12
        static let m: CGFloat = 18
        static let l: CGFloat = 28
    }

    /// Body XS, S and M for text; the Display scale for titles and figures.
    /// Each follows Dynamic Type from its own text style.
    enum Text {
        static let xs = allo(12, relativeTo: .caption)
        static let s = allo(14, relativeTo: .subheadline)
        static let m = allo(16, relativeTo: .body)
        /// Body M, medium: a row's title.
        static let title = allo(16, .medium, relativeTo: .body)
        /// Body XS, medium: a section's heading, as the Mac's.
        static let heading = allo(12, .medium, relativeTo: .caption)
        /// Display XXS.
        static let l = allo(24, .semibold, display: true, relativeTo: .title2)
        /// Display S: a screen's title.
        static let xl = allo(32, .semibold, display: true, relativeTo: .largeTitle)
        /// Display XL. The elapsed time while recording: figures that do not dance.
        static let clock = allo(64, .medium, display: true, relativeTo: .largeTitle).monospacedDigit()
    }

    /// Graphical's motion roles: small things, and larger ones (a screen, a sheet).
    enum Motion {
        static let small = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.2)
        static let large = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.36)
        /// What follows a finger or arrives on its own: a soft spring.
        static let spring = Animation.spring(response: 0.42, dampingFraction: 0.82)
    }

    /// Allo at a weight. `display` takes its display cut (the `opsz` axis at 32).
    static func allo(
        _ size: CGFloat, _ weight: Font.Weight = .regular, display: Bool = false, relativeTo style: Font.TextStyle
    ) -> Font {
        registerFonts()
        let cut = switch weight {
        case .medium: "Medium"
        case .semibold: "SemiBold"
        case .bold, .heavy, .black: "Bold"
        default: "Regular"
        }
        return Font.custom("AlloVariable-\(display ? "Display" : "")\(cut)", size: size, relativeTo: style)
    }

    /// Allo for this process (the app or the extension), once.
    static func registerFonts() { _ = fontsRegistered }

    private static let fontsRegistered: Bool = {
        guard let url = Bundle.main.url(forResource: "AlloVariable", withExtension: "woff2") else { return false }
        return CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }()
}

extension Color {
    /// A colour for each appearance, from `0xRRGGBB` values.
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255, alpha: 1)
        })
    }
}

/// The primary action: ink, a pill, pressed a little smaller.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Text.title)
            .foregroundStyle(Theme.onInk)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Space.m)
            .background(Theme.ink.opacity(isEnabled ? 1 : 0.3), in: .capsule)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(Theme.Motion.small, value: configuration.isPressed)
    }
}

/// A secondary action: a quiet pill on `neutral-3`.
struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Text.title)
            .foregroundStyle(Theme.text)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Space.m)
            .background(Theme.surface, in: .capsule)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(Theme.Motion.small, value: configuration.isPressed)
    }
}

/// A row that darkens a little under the finger, as the Mac's rows on hover.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(.rect)
            .background(configuration.isPressed ? Theme.surface : .clear, in: .rect(cornerRadius: Theme.Radius.s))
            .animation(Theme.Motion.small, value: configuration.isPressed)
    }
}

/// A section's heading, small and muted, as the Mac's.
struct SectionHeading: View {
    let text: Text

    init(_ text: Text) { self.text = text }
    init(_ key: LocalizedStringKey) { text = SwiftUI.Text(key) }
    init(verbatim: String) { text = SwiftUI.Text(verbatim: verbatim) }

    var body: some View {
        text
            .font(Theme.Text.heading)
            .foregroundStyle(Theme.muted)
            .textCase(nil)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}
