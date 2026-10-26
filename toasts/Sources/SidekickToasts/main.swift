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

// One controller reused for every toast so new ones replace the previous at top-right.
let toast = MainActor.assumeIsolated { ToastWindowController() }

// Read stdin on a background thread; show each toast on the main actor. Quit when stdin closes (Sidekick exited).
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let msg = try? JSONDecoder().decode(ToastMessage.self, from: data) else { continue }
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                toast.showToast(
                    message: msg.message,
                    icon: msg.icon.map { Image(systemName: $0) },
                    duration: msg.duration ?? 3,
                    position: .topRight(20)
                )
            }
        }
    }
    DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
}

app.run()
