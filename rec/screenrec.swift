// screenrec — record one app's windows and audio with ScreenCaptureKit.
//
//   screenrec --out DIR [--app BUNDLE_ID | --pid PID] [--max SECONDS]
//             [--window-title SUBSTRING] [--gone-after SECONDS] [--width PX]
//
// Writes DIR/rec.mov as a *fragmented* QuickTime movie (a fragment every 5s),
// so the file stays playable up to the last fragment even if this process is
// killed or the Mac loses power — nothing depends on a clean shutdown.
//
// Stops on SIGINT/SIGTERM, after --max seconds, or — with --window-title — once
// no window of the app whose title contains that substring has existed for
// --gone-after seconds (after having seen one). Prints one JSON line per event.
//
// Audio is the app's own output only: the mic is never captured, and other
// apps' sounds are excluded by the content filter. Muting the Mac's speakers
// does not affect what is captured.
//
// NOTE: macOS ties the Screen Recording grant to this exact (ad-hoc signed)
// build. Rebuilding means re-adding EventRecorder.app in System Settings.

import AVFoundation
import Foundation
import ScreenCaptureKit

func log(_ dict: [String: Any]) {
    var d = dict
    d["t"] = ISO8601DateFormatter().string(from: Date())
    if let data = try? JSONSerialization.data(withJSONObject: d),
       let s = String(data: data, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}

struct Args {
    var out = ""
    var app: String?
    var pid: Int32?
    var max: Double = 4 * 3600
    var windowTitle: String?
    var goneAfter: Double = 120
    var width = 1920
}

func parseArgs() -> Args {
    var a = Args()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let k = it.next() {
        switch k {
        case "--out": a.out = it.next() ?? ""
        case "--app": a.app = it.next()
        case "--pid": a.pid = Int32(it.next() ?? "")
        case "--max": a.max = Double(it.next() ?? "") ?? a.max
        case "--window-title": a.windowTitle = it.next()
        case "--gone-after": a.goneAfter = Double(it.next() ?? "") ?? a.goneAfter
        case "--width": a.width = Int(it.next() ?? "") ?? a.width
        case "--segment": _ = it.next() // accepted for compatibility; fragments replace segments
        default:
            FileHandle.standardError.write("unknown arg \(k)\n".data(using: .utf8)!)
            exit(2)
        }
    }
    if a.out.isEmpty {
        FileHandle.standardError.write("--out DIR is required\n".data(using: .utf8)!)
        exit(2)
    }
    return a
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    static let shared = Recorder()
    let args = parseArgs()
    let q = DispatchQueue(label: "writer") // all writer access happens here
    var stream: SCStream?
    var writer: AVAssetWriter?
    var vIn: AVAssetWriterInput?
    var aIn: AVAssetWriterInput?
    var sessionStarted = false
    var videoFrames = 0
    var audioBuffers = 0
    var started = Date()
    var sawWindow = false
    var lastSawWindow = Date()
    var stopping = false
    var outW = 1920, outH = 1080

    func findApp(_ content: SCShareableContent) -> SCRunningApplication? {
        if let pid = args.pid { return content.applications.first { $0.processID == pid } }
        if let b = args.app {
            let apps = content.applications.filter { $0.bundleIdentifier == b }
            return apps.max { a, b in
                content.windows.filter { $0.owningApplication?.processID == a.processID }.count <
                    content.windows.filter { $0.owningApplication?.processID == b.processID }.count
            }
        }
        return nil
    }

    func start() async throws {
        try FileManager.default.createDirectory(atPath: args.out, withIntermediateDirectories: true)
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard var display = content.displays.first else {
            throw NSError(domain: "screenrec", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"])
        }
        let filter: SCContentFilter
        if args.app != nil || args.pid != nil {
            guard let app = findApp(content) else {
                throw NSError(domain: "screenrec", code: 3, userInfo: [NSLocalizedDescriptionKey: "app not running"])
            }
            let wins = content.windows.filter { $0.owningApplication?.processID == app.processID && $0.isOnScreen }
            if let big = wins.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }),
               let d = content.displays.first(where: { $0.frame.intersects(big.frame) }) {
                display = d
            }
            filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
            log(["event": "target", "app": app.applicationName, "pid": app.processID, "display": display.displayID])
        } else {
            filter = SCContentFilter(display: display, excludingWindows: [])
            log(["event": "target", "display": display.displayID])
        }

        // Scale to --width, keeping the display's aspect, even dimensions for H.264.
        outW = min(args.width, Int(CGFloat(display.width) * CGFloat(filter.pointPixelScale))) & ~1
        outH = Int((Double(outW) * Double(display.height) / Double(display.width)).rounded()) & ~1

        let cfg = SCStreamConfiguration()
        cfg.width = outW
        cfg.height = outH
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 15)
        cfg.showsCursor = false
        cfg.capturesAudio = true
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        cfg.excludesCurrentProcessAudio = true
        cfg.queueDepth = 8
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

        try setupWriter()
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: q)
        stream = s
        try await s.startCapture()
        started = Date()
        log(["event": "recording", "out": args.out, "width": outW, "height": outH])
    }

    func setupWriter() throws {
        let url = URL(fileURLWithPath: args.out).appendingPathComponent("rec.mov")
        try? FileManager.default.removeItem(at: url)
        let w = try AVAssetWriter(outputURL: url, fileType: .mov)
        w.movieFragmentInterval = CMTime(seconds: 5, preferredTimescale: 600)
        w.shouldOptimizeForNetworkUse = false
        let v = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: outW,
            AVVideoHeightKey: outH,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 2_500_000,
                AVVideoMaxKeyFrameIntervalKey: 75,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ])
        v.expectsMediaDataInRealTime = true
        let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 128_000,
        ])
        a.expectsMediaDataInRealTime = true
        guard w.canAdd(v), w.canAdd(a) else {
            throw NSError(domain: "screenrec", code: 5, userInfo: [NSLocalizedDescriptionKey: "writer rejected inputs"])
        }
        w.add(v)
        w.add(a)
        writer = w
        vIn = v
        aIn = a
        log(["event": "file", "file": url.path])
    }

    // Called on q.
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !stopping, let w = writer, sb.isValid else { return }
        switch type {
        case .screen:
            // Only complete frames carry an image; idle ones just say "nothing changed".
            guard let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = atts.first?[.status] as? Int,
                  SCFrameStatus(rawValue: raw) == .complete else { return }
            if !sessionStarted {
                guard w.startWriting() else {
                    log(["event": "fatal", "error": "startWriting: \(w.error?.localizedDescription ?? "?")"])
                    exit(1)
                }
                w.startSession(atSourceTime: sb.presentationTimeStamp)
                sessionStarted = true
                log(["event": "first_frame"])
            }
            if let v = vIn, v.isReadyForMoreMediaData {
                if v.append(sb) { videoFrames += 1 }
            }
        case .audio:
            guard sessionStarted, let a = aIn, a.isReadyForMoreMediaData else { return }
            if a.append(sb) { audioBuffers += 1 }
        default:
            break
        }
        if w.status == .failed {
            log(["event": "writer_failed", "error": w.error?.localizedDescription ?? "?"])
            Task { await self.stop(code: 4) }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log(["event": "stream_error", "error": error.localizedDescription])
        Task { await self.stop(code: 4) }
    }

    func windowStillThere() async -> Bool {
        guard let title = args.windowTitle?.lowercased() else { return true }
        guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false),
              let app = findApp(content) else { return false }
        return content.windows.contains {
            $0.owningApplication?.processID == app.processID && ($0.title ?? "").lowercased().contains(title)
        }
    }

    func tickLoop() async {
        var lastBeat = Date()
        while !stopping {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if stopping { break }
            let now = Date()
            if now.timeIntervalSince(started) >= args.max {
                log(["event": "max_reached"]); await stop(); break
            }
            if args.windowTitle != nil {
                if await windowStillThere() {
                    if !sawWindow { log(["event": "window_seen"]) }
                    sawWindow = true; lastSawWindow = now
                } else if sawWindow && now.timeIntervalSince(lastSawWindow) >= args.goneAfter {
                    log(["event": "window_gone"]); await stop(); break
                }
            }
            if now.timeIntervalSince(lastBeat) >= 60 {
                let (v, a) = q.sync { (videoFrames, audioBuffers) }
                log(["event": "heartbeat", "video_frames": v, "audio_buffers": a])
                lastBeat = now
            }
        }
    }

    func stop(code: Int32 = 0) async {
        if stopping { return }
        stopping = true
        // Never let shutdown hang: the fragmented file is already playable, so a
        // clean finish is a nicety. Hard-exit after 10s whatever happens.
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            log(["event": "stopped", "clean": false])
            exit(code)
        }
        if let s = stream { try? await s.stopCapture() }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            q.async {
                guard let w = self.writer, w.status == .writing else { c.resume(); return }
                self.vIn?.markAsFinished()
                self.aIn?.markAsFinished()
                w.finishWriting { c.resume() }
            }
        }
        let (v, a) = q.sync { (videoFrames, audioBuffers) }
        log(["event": "stopped", "clean": true, "video_frames": v, "audio_buffers": a])
        exit(code)
    }
}

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { Task { await Recorder.shared.stop() } }
    src.resume()
    signalSources.append(src)
}

Task {
    do {
        try await Recorder.shared.start()
        await Recorder.shared.tickLoop()
    } catch {
        log(["event": "fatal", "error": error.localizedDescription])
        exit(1)
    }
}
dispatchMain()
