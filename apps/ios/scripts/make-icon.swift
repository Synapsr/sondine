import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
// The iPhone icon from the Mac's icon (apps/desktop/build/icon.icns): the
// macOS tile (824 px in a 1024 canvas, with its shadow) cropped to the tile,
// brought to 1024 px, on the tile's own colour so no pixel is transparent.
// iOS rounds the corners itself. Nothing of the logo is redrawn.
let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let tile = image.cropping(to: CGRect(x: 100, y: 100, width: 824, height: 824))!
let size = 1024
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(srgbRed: 43 / 255, green: 42 / 255, blue: 42 / 255, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: size, height: size))
context.interpolationQuality = .high
// Only the tile itself: its corners outside are the macOS shadow, which iOS's own mask replaces.
let radius = 1024.0 * 185 / 824
context.addPath(CGPath(roundedRect: CGRect(x: 2, y: 2, width: 1020, height: 1020), cornerWidth: radius, cornerHeight: radius, transform: nil))
context.clip()
context.draw(tile, in: CGRect(x: 0, y: 0, width: size, height: size))
let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
guard CGImageDestinationFinalize(destination) else { exit(1) }
