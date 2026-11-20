#!/bin/sh
set -eu
cd "$(dirname "$0")"
node --test test/*.test.mjs
python3 test/test_mail.py
xcodebuild -project ios/SunnylandProduction.xcodeproj -scheme SunnylandProduction -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/SunnylandProduction-DerivedData CODE_SIGNING_ALLOWED=NO build
