#!/bin/zsh
# Builds EventRecorder.app around screenrec so macOS grants Screen Recording to
# the bundle itself, regardless of which process launches it.
set -e
cd "${0:A:h}/.."
APP=bin/EventRecorder.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -o "$APP/Contents/MacOS/screenrec" rec/screenrec.swift
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.aen.event-agent.recorder</string>
  <key>CFBundleName</key><string>EventRecorder</string>
  <key>CFBundleExecutable</key><string>screenrec</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>Records online events you registered for, so you can watch them later.</string>
</dict></plist>
PLIST
codesign --force --sign - --identifier com.aen.event-agent.recorder "$APP"
rm -f bin/screenrec
echo "built $APP"
