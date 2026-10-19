import Foundation

/// The factory patch library, as the web editor wrote it.
///
/// `factory-patches.json` is generated from `editor/src/factoryPatches.ts`
/// by `npm run fixtures:factory`, and a test on that side fails when the file
/// falls behind the patches. So the hundred patches the iOS plugin offers are
/// the browser's hundred by construction. There used to be a second,
/// hand-written copy of all of them in Swift, kept in step by nobody in
/// particular, and a fix made on one side (the hi-hat's level, 2026-09-29)
/// reached only that side.
///
/// Decoded here rather than in the plugin so a Swift test can hold the
/// shipped file to the native engine: every patch decodes, flattens and
/// compiles (`FactoryLibraryTests`).
public struct FactoryLibrary: Decodable, Sendable {
    public let version: Int
    /// Categories in the order a library shows them.
    public let categoryOrder: [String]
    public let patches: [Entry]

    public struct Entry: Decodable, Sendable {
        public let id: String
        public let name: String
        public let category: String
        /// One line, in the words somebody choosing a patch would want.
        public let blurb: String
        /// `instrument`, `effect` or `either`.
        public let slot: String
        public let patch: CratePatch
    }

    public static func decode(_ data: Data) throws -> FactoryLibrary {
        let library = try JSONDecoder().decode(FactoryLibrary.self, from: data)
        guard library.version == 1 else {
            throw ASLCompileError(
                "factory-patches.json is version \(library.version); this build reads version 1."
            )
        }
        return library
    }

    /// The library shipped inside this package, decoded once.
    public static func bundled() throws -> FactoryLibrary {
        if let cached = cache.value { return cached }
        guard let url = Bundle.module.url(forResource: "factory-patches", withExtension: "json") else {
            throw ASLCompileError(
                "factory-patches.json is not in the CrateASL resource bundle. "
                    + "Run `npm run fixtures:factory` and check Package.swift still copies it."
            )
        }
        let library = try decode(try Data(contentsOf: url))
        cache.value = library
        return library
    }

    private static let cache = Cached()

    private final class Cached: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: FactoryLibrary?
        var value: FactoryLibrary? {
            get { lock.lock(); defer { lock.unlock() }; return stored }
            set { lock.lock(); stored = newValue; lock.unlock() }
        }
    }
}
