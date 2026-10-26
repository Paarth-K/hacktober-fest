import AppKit
import Foundation
import MacToastKit
import SwiftUI

struct ToastMessage: Decodable {
    let message: String
    let icon: String?
    let duration: Double?
}

// Background accessory app: no Dock icon, no menu bar, never steals focus.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// A fresh controller per toast (MacToastKit doesn't re-show a reused one after it fades);
// keep each alive until its toast has finished.
var live: [ToastWindowController] = []

// Read stdin on a background thread; show each toast on the main actor. Quit when stdin closes (Sidekick exited).
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let msg = try? JSONDecoder().decode(ToastMessage.self, from: data) else { continue }
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                let toast = ToastWindowController()
                live.append(toast)
                let duration = msg.duration ?? 3
                toast.showToast(
                    message: msg.message,
                    icon: msg.icon.map { Image(systemName: $0) },
                    duration: duration,
                    position: .topRight(20)
                )
                DispatchQueue.main.asyncAfter(deadline: .now() + duration + 2) {
                    live.removeAll { $0 === toast }
                }
            }
        }
    }
    DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
}

app.run()
