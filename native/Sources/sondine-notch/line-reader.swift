import Foundation

/// Reads `handle` on its own thread and hands each line, newline removed, to
/// `onLine`; then calls `onEnd` once at end of file. A line longer than
/// `maxLength` is dropped up to its newline.
func readLines(
    from handle: FileHandle,
    maxLength: Int,
    onLine: @escaping @Sendable (Data) -> Void,
    onTooLong: @escaping @Sendable () -> Void,
    onEnd: @escaping @Sendable () -> Void
) {
    let thread = Thread {
        var buffer = Data()
        var skipping = false
        while true {
            let chunk = handle.availableData
            if chunk.isEmpty {
                onEnd()
                return
            }
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = Data(buffer[buffer.startIndex..<newline])
                buffer.removeSubrange(buffer.startIndex...newline)
                if skipping {
                    skipping = false
                } else if !line.isEmpty {
                    onLine(line)
                }
            }
            if buffer.count > maxLength {
                buffer.removeAll()
                skipping = true
                onTooLong()
            }
        }
    }
    thread.name = "stdin"
    thread.start()
}
