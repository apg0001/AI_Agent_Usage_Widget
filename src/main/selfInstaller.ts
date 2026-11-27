import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Approval-based self-install for builds that electron-updater cannot install
 * on its own (unsigned macOS bundles rejected by Squirrel.Mac, and Linux
 * deb/rpm/pacman packages that need root). The pattern follows Agent-Office's
 * installer-based updater: the app writes a small helper script, starts it
 * detached, and quits. The helper waits for the app to exit, installs the
 * update electron-updater already downloaded and verified against the
 * release's SHA-512, records the outcome, and starts the app again. Paths and
 * versions reach the helper only as argv, never interpolated into the script.
 */

export type LinuxPackageKind = "deb" | "rpm" | "pacman";

export type SelfInstallResult = {
  status: "installed" | "failed";
  code: string;
  version: string;
};

export const MAC_INSTALL_SCRIPT = String.raw`#!/bin/bash
# GigaCharge macOS update helper.
# argv: app-pid update-zip target-app bundle-id result-file relaunch(1|0) version
set -u
APP_PID="$1"; ZIP="$2"; TARGET="$3"; BUNDLE_ID="$4"; RESULT="$5"; RELAUNCH="$6"; VERSION="$7"
/bin/rm -f "$0" 2>/dev/null

write_result() {
  printf '{"status":"%s","code":"%s","version":"%s"}\n' "$1" "$2" "$VERSION" > "$RESULT" 2>/dev/null
}
relaunch() {
  if [ "$RELAUNCH" = "1" ]; then /usr/bin/open "$TARGET" >/dev/null 2>&1; fi
}
finish_failed() {
  write_result failed "$1"
  relaunch
  exit 1
}

for _ in $(/usr/bin/seq 1 120); do
  /bin/kill -0 "$APP_PID" 2>/dev/null || break
  /bin/sleep 0.25
done
if /bin/kill -0 "$APP_PID" 2>/dev/null; then
  write_result failed app-still-running
  exit 1
fi

WORK="$(/usr/bin/mktemp -d "${"$"}{TMPDIR:-/tmp}/gigacharge-update.XXXXXX")" || finish_failed workdir
trap '/bin/rm -rf "$WORK"' EXIT
/usr/bin/ditto -x -k "$ZIP" "$WORK/extract" 2>/dev/null || finish_failed extract

NEW_APP=""
for candidate in "$WORK/extract"/*.app; do
  if [ -d "$candidate" ]; then NEW_APP="$candidate"; break; fi
done
[ -n "$NEW_APP" ] || finish_failed missing-app
NEW_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$NEW_APP/Contents/Info.plist" 2>/dev/null)"
[ "$NEW_ID" = "$BUNDLE_ID" ] || finish_failed bundle-id
NEW_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$NEW_APP/Contents/Info.plist" 2>/dev/null)"
[ "$NEW_VERSION" = "$VERSION" ] || finish_failed version
/usr/bin/xattr -dr com.apple.quarantine "$NEW_APP" 2>/dev/null || true

BACKUP="$TARGET.gigacharge-previous"
replace_as_user() {
  [ -w "$(/usr/bin/dirname "$TARGET")" ] || return 1
  /bin/rm -rf "$BACKUP" 2>/dev/null || return 1
  /bin/mv "$TARGET" "$BACKUP" 2>/dev/null || return 1
  if /usr/bin/ditto "$NEW_APP" "$TARGET" 2>/dev/null; then
    /bin/rm -rf "$BACKUP" 2>/dev/null
    return 0
  fi
  /bin/rm -rf "$TARGET" 2>/dev/null
  /bin/mv "$BACKUP" "$TARGET" 2>/dev/null
  return 1
}
replace_as_admin() {
  /usr/bin/osascript - "$NEW_APP" "$TARGET" "$BACKUP" "$(/usr/bin/id -u)" "$(/usr/bin/id -g)" >/dev/null 2>&1 <<'OSA'
on run argv
  set newApp to quoted form of (item 1 of argv)
  set targetApp to quoted form of (item 2 of argv)
  set backupApp to quoted form of (item 3 of argv)
  set owner to quoted form of ((item 4 of argv) & ":" & (item 5 of argv))
  do shell script "/bin/rm -rf " & backupApp & " && /bin/mv " & targetApp & " " & backupApp & " && if /usr/bin/ditto " & newApp & " " & targetApp & "; then /usr/sbin/chown -R " & owner & " " & targetApp & "; /bin/rm -rf " & backupApp & "; else /bin/rm -rf " & targetApp & "; /bin/mv " & backupApp & " " & targetApp & "; exit 1; fi" with administrator privileges
end run
OSA
}

if replace_as_user; then
  :
elif replace_as_admin; then
  :
else
  finish_failed replace
fi

write_result installed ok
relaunch
exit 0
`;

export const LINUX_INSTALL_SCRIPT = String.raw`#!/bin/bash
# GigaCharge Linux package update helper.
# argv: app-pid package-file kind(deb|rpm|pacman) app-exe result-file relaunch(1|0) version [timeout-seconds]
set -u
APP_PID="$1"; PACKAGE="$2"; KIND="$3"; APP_EXE="$4"; RESULT="$5"; RELAUNCH="$6"; VERSION="$7"; TIMEOUT_SECONDS="${"$"}{8:-300}"
rm -f "$0" 2>/dev/null

write_result() {
  printf '{"status":"%s","code":"%s","version":"%s"}\n' "$1" "$2" "$VERSION" > "$RESULT" 2>/dev/null
}
relaunch() {
  [ "$RELAUNCH" = "1" ] || return 0
  [ -x "$APP_EXE" ] || return 0
  if command -v setsid >/dev/null 2>&1; then
    setsid "$APP_EXE" >/dev/null 2>&1 < /dev/null &
  else
    nohup "$APP_EXE" >/dev/null 2>&1 < /dev/null &
  fi
}
finish_failed() {
  write_result failed "$1"
  relaunch
  exit 1
}

for _ in $(seq 1 120); do
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$APP_PID" 2>/dev/null; then
  write_result failed app-still-running
  exit 1
fi

PKEXEC="$(command -v pkexec)" || finish_failed no-pkexec
case "$KIND" in
  deb)
    set -- "$PKEXEC" /usr/bin/env DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y "$PACKAGE"
    ;;
  rpm)
    if DNF="$(command -v dnf)"; then
      set -- "$PKEXEC" "$DNF" install -y "$PACKAGE"
    else
      RPM="$(command -v rpm)" || finish_failed no-package-manager
      set -- "$PKEXEC" "$RPM" -U "$PACKAGE"
    fi
    ;;
  pacman)
    PACMAN="$(command -v pacman)" || finish_failed no-package-manager
    set -- "$PKEXEC" "$PACMAN" -U --noconfirm "$PACKAGE"
    ;;
  *)
    finish_failed unknown-package
    ;;
esac

# pkexec can wait forever when the session has no polkit agent. The app has
# already quit, so bound the wait and bring the app back either way.
"$@" >/dev/null 2>&1 < /dev/null &
INSTALL_PID=$!
ticks=0
while kill -0 "$INSTALL_PID" 2>/dev/null; do
  if [ "$ticks" -ge $((TIMEOUT_SECONDS * 4)) ]; then
    kill "$INSTALL_PID" 2>/dev/null
    wait "$INSTALL_PID" 2>/dev/null
    finish_failed timeout
  fi
  sleep 0.25
  ticks=$((ticks + 1))
done
wait "$INSTALL_PID"
STATUS=$?
[ "$STATUS" -eq 0 ] || finish_failed "install-exit-$STATUS"

write_result installed ok
relaunch
exit 0
`;

/** `/Applications/GigaCharge.app/Contents/MacOS/GigaCharge` → `/Applications/GigaCharge.app`. */
export function resolveMacAppBundle(executablePath: string): string | null {
  const macOsDirectory = path.dirname(executablePath);
  const contentsDirectory = path.dirname(macOsDirectory);
  const bundle = path.dirname(contentsDirectory);
  if (path.basename(macOsDirectory) !== "MacOS" || path.basename(contentsDirectory) !== "Contents" || !bundle.endsWith(".app")) {
    return null;
  }
  // A bundle launched from a mounted disk image or through App Translocation
  // lives on a read-only path; replacing it in place cannot work.
  if (bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) {
    return null;
  }
  return bundle;
}

export function linuxPackageKind(packageFile: string): LinuxPackageKind | null {
  if (packageFile.endsWith(".deb")) {
    return "deb";
  }
  if (packageFile.endsWith(".rpm")) {
    return "rpm";
  }
  if (packageFile.endsWith(".pacman")) {
    return "pacman";
  }
  return null;
}

export function hasPkexec(): boolean {
  return ["/usr/bin/pkexec", "/bin/pkexec", "/usr/local/bin/pkexec"].some((candidate) => existsSync(candidate));
}

/** Versions come from release metadata; keep only SemVer characters before handing them to the helper. */
export function sanitizeVersion(version: string): string {
  return version.replace(/[^0-9A-Za-z.+-]/g, "");
}

export function macInstallArgs(input: {
  appPid: number;
  updateZip: string;
  targetApp: string;
  bundleId: string;
  resultFile: string;
  version: string;
  relaunch?: boolean;
}): string[] {
  return [
    String(input.appPid),
    input.updateZip,
    input.targetApp,
    input.bundleId,
    input.resultFile,
    input.relaunch === false ? "0" : "1",
    sanitizeVersion(input.version)
  ];
}

export function linuxInstallArgs(input: {
  appPid: number;
  packageFile: string;
  kind: LinuxPackageKind;
  appExecutable: string;
  resultFile: string;
  version: string;
  relaunch?: boolean;
  timeoutSeconds?: number;
}): string[] {
  return [
    String(input.appPid),
    input.packageFile,
    input.kind,
    input.appExecutable,
    input.resultFile,
    input.relaunch === false ? "0" : "1",
    sanitizeVersion(input.version),
    String(input.timeoutSeconds ?? 300)
  ];
}

/** Writes the helper to a private temp file and starts it detached from the app. */
export function launchDetachedInstaller(script: string, args: string[]): void {
  const directory = mkdtempSync(path.join(tmpdir(), "gigacharge-installer-"));
  const scriptPath = path.join(directory, "install.sh");
  writeFileSync(scriptPath, script, { encoding: "utf8", mode: 0o700 });
  const child = spawn("/bin/bash", [scriptPath, ...args], { detached: true, stdio: "ignore" });
  child.unref();
}

/** Reads and removes the helper's outcome so it is reported once. */
export function takeSelfInstallResult(resultFile: string): SelfInstallResult | null {
  if (!existsSync(resultFile)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(resultFile, "utf8")) as Partial<SelfInstallResult>;
    if ((parsed.status === "installed" || parsed.status === "failed") && typeof parsed.version === "string") {
      return { status: parsed.status, code: typeof parsed.code === "string" ? parsed.code : "unknown", version: parsed.version };
    }
    return null;
  } catch {
    return null;
  } finally {
    rmSync(resultFile, { force: true });
  }
}
