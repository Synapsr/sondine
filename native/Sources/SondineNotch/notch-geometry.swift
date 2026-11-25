import CoreGraphics

/// The island the notch becomes during a call or for a card, in its four states, and the
/// frame of the helper's window around it (AppKit's global coordinates:
/// origin at the bottom left). Every state is centred on the notch and hangs
/// from the top of the screen, so the window can grow or shrink around the
/// island without moving it; at rest the window fits the island, so nothing
/// transparent of it sits over another app.
public struct NotchGeometry: Equatable, Sendable {
    /// Each side of the notch while compact: the initial or the app's icon on the left, « ? » and the listening dot on the right.
    public static let wing: CGFloat = 32
    /// The concave corners where the island meets the top of the screen.
    public static let ear: CGFloat = 8
    /// The line below the notch that holds the name while peeking.
    public static let peekLine: CGFloat = 26
    /// Padding on each side of the name while peeking.
    public static let peekPadding: CGFloat = 18
    public static let peekMaxWidth: CGFloat = 320
    /// The width of the island that says a call or a card, and of the open one:
    /// the call's switch stays where it is when the island opens under the pointer.
    public static let openWidth: CGFloat = 340

    public enum State: Equatable, Sendable {
        /// The notch and two narrow wings, in the menu bar's band.
        case compact
        /// Grown down by one line: the name, as wide as it needs.
        case peek(labelWidth: CGFloat)
        /// A call that starts, or a card: `contentHeight` below the notch's band.
        case announce(contentHeight: CGFloat)
        /// The panel: `contentHeight` below the notch's band.
        case open(contentHeight: CGFloat)
    }

    /// The band the camera housing hides, as tall as the menu bar.
    public let notch: CGRect
    public let screen: CGRect

    /// From a screen's frame, its unobscured top corners (`auxiliaryTopLeftArea`
    /// and `auxiliaryTopRightArea`) and its top safe-area inset; nil when the
    /// screen has no notch. Only the corners' widths are read, so their
    /// coordinate space does not matter.
    public init?(screenFrame: CGRect, topLeftArea: CGRect?, topRightArea: CGRect?, topInset: CGFloat) {
        guard let left = topLeftArea, let right = topRightArea,
              left.width > 0, right.width > 0, topInset > 0
        else { return nil }
        let minX = screenFrame.minX + left.width
        let maxX = screenFrame.maxX - right.width
        guard maxX - minX >= 1 else { return nil }
        notch = CGRect(x: minX, y: screenFrame.maxY - topInset, width: maxX - minX, height: topInset)
        screen = screenFrame
    }

    /// The island's body (its ears aside) in a state.
    public func size(_ state: State) -> CGSize {
        let compact = notch.width + 2 * Self.wing
        switch state {
        case .compact:
            return CGSize(width: compact, height: notch.height)
        case let .peek(labelWidth):
            let width = min(max(compact, labelWidth.rounded(.up) + 2 * Self.peekPadding), Self.peekMaxWidth)
            return CGSize(width: max(width, compact), height: notch.height + Self.peekLine)
        case let .announce(contentHeight), let .open(contentHeight):
            let width = min(max(Self.openWidth, compact), screen.width - 2 * Self.ear)
            return CGSize(width: width, height: min(notch.height + contentHeight.rounded(.up), screen.height))
        }
    }

    /// What holds the island in every state, its ears included.
    public var canvas: CGSize {
        let widths = [size(.compact), size(.peek(labelWidth: Self.peekMaxWidth)), size(.open(contentHeight: 0))].map(\.width)
        return CGSize(width: (widths.max() ?? 0) + 2 * Self.ear, height: screen.height)
    }

    /// Whether the pointer is on an island of `size`, its edges included: a
    /// pointer pushed to the top of the screen sits on the top edge itself.
    public func holds(_ point: CGPoint, size: CGSize) -> Bool {
        let island = frame(size)
        return (island.minX...island.maxX).contains(point.x) && (island.minY...island.maxY).contains(point.y)
    }

    /// The window around an island of `size`: its ears included, centred on
    /// the notch, from the top of the screen.
    public func frame(_ size: CGSize) -> CGRect {
        let width = size.width + 2 * Self.ear
        return CGRect(x: notch.midX - width / 2, y: screen.maxY - size.height, width: width, height: size.height)
    }
}
