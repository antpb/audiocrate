import Foundation

enum CrateFixtures {
    /// Walks up from this file until `fixtures/<name>` exists (crate root).
    static func url(_ name: String) -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent("fixtures").appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir.deleteLastPathComponent()
        }
        var fallback = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { fallback.deleteLastPathComponent() }
        return fallback.appendingPathComponent("fixtures").appendingPathComponent(name)
    }
}
