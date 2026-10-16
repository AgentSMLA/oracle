#!/usr/bin/env bash
set -euo pipefail
: "${MACOS_SIGNING_P12:?}" "${MACOS_SIGNING_P12_PASSWORD:?}"
: "${APP_STORE_CONNECT_KEY_ID:?}" "${APP_STORE_CONNECT_ISSUER_ID:?}" "${APP_STORE_CONNECT_API_KEY_P8:?}"
keychain="$RUNNER_TEMP/oracle-signing.keychain-db"
p12="$RUNNER_TEMP/oracle-signing.p12"
original="$RUNNER_TEMP/oracle-keychains.txt"
notary_key="$RUNNER_TEMP/oracle-notary-key.p8"
security list-keychains -d user > "$original"
cleanup() {
  restored=()
  while IFS= read -r entry; do
    entry=${entry#\"}; entry=${entry#"${entry%%[![:space:]]*}"}; entry=${entry#\"}; entry=${entry%\"}
    [[ -z "$entry" ]] || restored+=("$entry")
  done < "$original"
  security list-keychains -d user -s "${restored[@]}"
  security delete-keychain "$keychain" || true
  rm -f "$p12" "$original" "$notary_key"
}
trap cleanup EXIT
phrase=$(openssl rand -hex 24)
printf '%s' "$MACOS_SIGNING_P12" | base64 -D > "$p12"
chmod 600 "$p12"
security create-keychain -p "$phrase" "$keychain"
security unlock-keychain -p "$phrase" "$keychain"
security import "$p12" -k "$keychain" -P "$MACOS_SIGNING_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$phrase" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain"
printf '%s' "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > "$notary_key"
chmod 600 "$notary_key"
xcrun notarytool history --key "$notary_key" --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID" --output-format json > "$RUNNER_TEMP/oracle-notary-history.json"
export CODESIGN_ID='Developer ID Application: Peter Steinberger (Y5PE65HELJ)'
bash vendor/oracle-notifier/build-notifier.sh
binary=vendor/oracle-notifier/OracleNotifier.app/Contents/MacOS/OracleNotifier
architectures=$(lipo -archs "$binary")
test -n "$architectures"
for arch in $architectures; do
  build_version=$(otool -arch "$arch" -l "$binary" | grep -A3 LC_BUILD_VERSION)
  printf '%s: %s\n' "$arch" "$build_version"
  test "$(printf '%s\n' "$build_version" | awk '$1 == "minos" { print $2 }')" = 13.0
done
codesign --verify --deep --strict vendor/oracle-notifier/OracleNotifier.app
codesign -dv --verbose=4 vendor/oracle-notifier/OracleNotifier.app 2>&1 | grep -Fx 'TeamIdentifier=Y5PE65HELJ'
xcrun stapler validate vendor/oracle-notifier/OracleNotifier.app
spctl --assess --type execute --verbose=2 vendor/oracle-notifier/OracleNotifier.app
