@preconcurrency import AVFoundation
import SwiftUI
import UIKit

/// The camera, reading QR codes only (AVFoundation). iOS asks for the camera
/// when this appears, the first time. Nothing is recorded or kept.
struct QRScannerView: UIViewControllerRepresentable {
    enum Problem { case denied, unavailable }

    let found: @MainActor (String) -> Void
    let failed: @MainActor (Problem) -> Void

    init(found: @escaping @MainActor (String) -> Void, failed: @escaping @MainActor (Problem) -> Void) {
        self.found = found
        self.failed = failed
    }

    func makeUIViewController(context: Context) -> ScannerController {
        ScannerController(found: found, failed: failed)
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    static func dismantleUIViewController(_ controller: ScannerController, coordinator: ()) {
        controller.stop()
    }
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let found: @MainActor (String) -> Void
    private let failed: @MainActor (QRScannerView.Problem) -> Void
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "sondine.scanner")
    private var preview: AVCaptureVideoPreviewLayer?

    init(found: @escaping @MainActor (String) -> Void, failed: @escaping @MainActor (QRScannerView.Problem) -> Void) {
        self.found = found
        self.failed = failed
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        Task { @MainActor in
            guard await AVCaptureDevice.requestAccess(for: .video) else {
                failed(.denied)
                return
            }
            configure()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    private func configure() {
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input)
        else {
            failed(.unavailable)
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            failed(.unavailable)
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer
        let session = session
        queue.async { session.startRunning() }
    }

    func stop() {
        let session = session
        queue.async { session.stopRunning() }
    }

    nonisolated func metadataOutput(
        _ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection
    ) {
        let text = metadataObjects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }.first
        guard let text else { return }
        MainActor.assumeIsolated { found(text) }
    }
}
