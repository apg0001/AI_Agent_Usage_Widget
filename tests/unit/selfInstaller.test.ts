import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LINUX_INSTALL_SCRIPT,
  linuxInstallArgs,
  linuxPackageKind,
  MAC_INSTALL_SCRIPT,
  macInstallArgs,
  resolveMacAppBundle,
  sanitizeVersion,
  takeSelfInstallResult
} from "../../src/main/selfInstaller";

// A PID that cannot belong to a live process, so the helper does not wait.
const EXITED_PID = 999_999;
const BUNDLE_ID = "com.apg0001.aiusagewidget";

let workDirectory = "";

beforeEach(() => {
  workDirectory = mkdtempSync(path.join(tmpdir(), "gigacharge-self-install-"));
});

afterEach(() => {
  rmSync(workDirectory, { recursive: true, force: true });
});

function runScript(script: string, args: string[], env: Record<string, string> = {}) {
  const scriptPath = path.join(workDirectory, `helper-${Math.random().toString(16).slice(2)}.sh`);
  writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("/bin/bash", [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000
  });
  return { ...result, scriptRemoved: !existsSync(scriptPath) };
}

function readResult(resultFile: string) {
  return JSON.parse(readFileSync(resultFile, "utf8")) as { status: string; code: string; version: string };
}

describe("자체 설치 도우미 입력", () => {
  it("실행 파일 경로에서 쓸 수 있는 .app 번들만 찾는다", () => {
    expect(resolveMacAppBundle("/Applications/GigaCharge.app/Contents/MacOS/GigaCharge")).toBe("/Applications/GigaCharge.app");
    expect(resolveMacAppBundle("/Users/me/Apps/Giga Charge.app/Contents/MacOS/GigaCharge")).toBe("/Users/me/Apps/Giga Charge.app");
    expect(resolveMacAppBundle("/Volumes/GigaCharge/GigaCharge.app/Contents/MacOS/GigaCharge")).toBeNull();
    expect(resolveMacAppBundle("/private/var/folders/x/AppTranslocation/ID/d/GigaCharge.app/Contents/MacOS/GigaCharge")).toBeNull();
    expect(resolveMacAppBundle("/opt/GigaCharge/gigacharge")).toBeNull();
  });

  it("패키지 종류와 버전을 안전하게 고른다", () => {
    expect(linuxPackageKind("/tmp/quota-bar_0.9.0_amd64.deb")).toBe("deb");
    expect(linuxPackageKind("/tmp/GigaCharge.rpm")).toBe("rpm");
    expect(linuxPackageKind("/tmp/GigaCharge.pacman")).toBe("pacman");
    expect(linuxPackageKind("/tmp/GigaCharge.AppImage")).toBeNull();
    expect(sanitizeVersion("0.9.0-beta.1+build")).toBe("0.9.0-beta.1+build");
    expect(sanitizeVersion('0.9.0","status":"installed')).toBe("0.9.0statusinstalled");
  });

  it("경로를 스크립트에 끼워 넣지 않고 인자로만 넘긴다", () => {
    expect(macInstallArgs({
      appPid: 42,
      updateZip: "/tmp/a b/update.zip",
      targetApp: "/Applications/Giga'Charge.app",
      bundleId: BUNDLE_ID,
      resultFile: "/tmp/result.json",
      version: "0.9.0"
    })).toEqual(["42", "/tmp/a b/update.zip", "/Applications/Giga'Charge.app", BUNDLE_ID, "/tmp/result.json", "1", "0.9.0"]);
    expect(linuxInstallArgs({
      appPid: 42,
      packageFile: "/tmp/p.deb",
      kind: "deb",
      appExecutable: "/opt/GigaCharge/gigacharge",
      resultFile: "/tmp/result.json",
      version: "0.9.0",
      relaunch: false
    })).toEqual(["42", "/tmp/p.deb", "deb", "/opt/GigaCharge/gigacharge", "/tmp/result.json", "0", "0.9.0", "300"]);
    expect(MAC_INSTALL_SCRIPT).not.toContain("/tmp/a b");
  });

  it("도우미 결과는 한 번만 읽고 지운다", () => {
    const resultFile = path.join(workDirectory, "result.json");
    writeFileSync(resultFile, JSON.stringify({ status: "failed", code: "replace", version: "0.9.0" }));
    expect(takeSelfInstallResult(resultFile)).toEqual({ status: "failed", code: "replace", version: "0.9.0" });
    expect(existsSync(resultFile)).toBe(false);
    expect(takeSelfInstallResult(resultFile)).toBeNull();

    writeFileSync(resultFile, "not json");
    expect(takeSelfInstallResult(resultFile)).toBeNull();
    expect(existsSync(resultFile)).toBe(false);
  });
});

describe.runIf(process.platform === "darwin")("macOS 자체 설치 도우미", () => {
  function makeApp(parent: string, name: string, bundleId: string, version: string, marker: string) {
    const contents = path.join(parent, name, "Contents");
    mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`);
    writeFileSync(path.join(contents, "MacOS", "marker"), marker);
    return path.join(parent, name);
  }

  function makeUpdateZip(bundleId: string, version: string) {
    const source = path.join(workDirectory, `source-${version}-${bundleId}`);
    const app = makeApp(source, "GigaCharge.app", bundleId, version, `new ${version}`);
    const zip = path.join(workDirectory, `update-${version}-${bundleId}.zip`);
    const zipped = spawnSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
    expect(zipped.status).toBe(0);
    return zip;
  }

  function installArgs(zip: string, target: string, resultFile: string, version: string) {
    return macInstallArgs({
      appPid: EXITED_PID,
      updateZip: zip,
      targetApp: target,
      bundleId: BUNDLE_ID,
      resultFile,
      version,
      relaunch: false
    });
  }

  it("받아둔 zip으로 번들을 교체하고 결과를 남긴다", () => {
    const applications = path.join(workDirectory, "Applications with space");
    const target = makeApp(applications, "GigaCharge.app", BUNDLE_ID, "0.8.0", "old");
    const zip = makeUpdateZip(BUNDLE_ID, "0.9.0");
    const resultFile = path.join(workDirectory, "result.json");

    const run = runScript(MAC_INSTALL_SCRIPT, installArgs(zip, target, resultFile, "0.9.0"));

    expect(run.status).toBe(0);
    expect(run.scriptRemoved).toBe(true);
    expect(readFileSync(path.join(target, "Contents", "MacOS", "marker"), "utf8")).toBe("new 0.9.0");
    expect(existsSync(`${target}.gigacharge-previous`)).toBe(false);
    expect(readResult(resultFile)).toEqual({ status: "installed", code: "ok", version: "0.9.0" });
  });

  it("다른 앱의 번들이면 교체하지 않는다", () => {
    const target = makeApp(path.join(workDirectory, "Applications"), "GigaCharge.app", BUNDLE_ID, "0.8.0", "old");
    const zip = makeUpdateZip("com.example.other", "0.9.0");
    const resultFile = path.join(workDirectory, "result.json");

    const run = runScript(MAC_INSTALL_SCRIPT, installArgs(zip, target, resultFile, "0.9.0"));

    expect(run.status).toBe(1);
    expect(readFileSync(path.join(target, "Contents", "MacOS", "marker"), "utf8")).toBe("old");
    expect(readResult(resultFile)).toMatchObject({ status: "failed", code: "bundle-id" });
  });

  it("릴리스 버전과 번들 버전이 다르면 교체하지 않는다", () => {
    const target = makeApp(path.join(workDirectory, "Applications"), "GigaCharge.app", BUNDLE_ID, "0.8.0", "old");
    const zip = makeUpdateZip(BUNDLE_ID, "0.8.9");
    const resultFile = path.join(workDirectory, "result.json");

    const run = runScript(MAC_INSTALL_SCRIPT, installArgs(zip, target, resultFile, "0.9.0"));

    expect(run.status).toBe(1);
    expect(readFileSync(path.join(target, "Contents", "MacOS", "marker"), "utf8")).toBe("old");
    expect(readResult(resultFile)).toMatchObject({ status: "failed", code: "version" });
  });

  it("압축을 풀 수 없으면 기존 앱을 그대로 둔다", () => {
    const target = makeApp(path.join(workDirectory, "Applications"), "GigaCharge.app", BUNDLE_ID, "0.8.0", "old");
    const zip = path.join(workDirectory, "broken.zip");
    writeFileSync(zip, "not a zip");
    const resultFile = path.join(workDirectory, "result.json");

    const run = runScript(MAC_INSTALL_SCRIPT, installArgs(zip, target, resultFile, "0.9.0"));

    expect(run.status).toBe(1);
    expect(readFileSync(path.join(target, "Contents", "MacOS", "marker"), "utf8")).toBe("old");
    expect(readResult(resultFile)).toMatchObject({ status: "failed", code: "extract" });
  });
});

describe.runIf(process.platform !== "win32")("Linux 패키지 설치 도우미", () => {
  function fakePkexec(exitCode: number, sleepSeconds = 0) {
    const bin = path.join(workDirectory, "bin");
    mkdirSync(bin, { recursive: true });
    const log = path.join(workDirectory, "pkexec-args.txt");
    const pkexec = path.join(bin, "pkexec");
    writeFileSync(pkexec, `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\nsleep ${sleepSeconds}\nexit ${exitCode}\n`);
    chmodSync(pkexec, 0o755);
    return { env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` }, log };
  }

  function args(packageFile: string, resultFile: string, timeoutSeconds = 300) {
    return linuxInstallArgs({
      appPid: EXITED_PID,
      packageFile,
      kind: "deb",
      appExecutable: "/nonexistent/gigacharge",
      resultFile,
      version: "0.9.0",
      relaunch: false,
      timeoutSeconds
    });
  }

  it("pkexec로 apt-get 설치를 요청하고 성공을 기록한다", () => {
    const { env, log } = fakePkexec(0);
    const resultFile = path.join(workDirectory, "result.json");
    const packageFile = path.join(workDirectory, "quota bar_0.9.0_amd64.deb");

    const run = runScript(LINUX_INSTALL_SCRIPT, args(packageFile, resultFile), env);

    expect(run.status).toBe(0);
    expect(run.scriptRemoved).toBe(true);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "/usr/bin/env",
      "DEBIAN_FRONTEND=noninteractive",
      "/usr/bin/apt-get",
      "install",
      "-y",
      packageFile
    ]);
    expect(readResult(resultFile)).toEqual({ status: "installed", code: "ok", version: "0.9.0" });
  });

  it("인증 창을 닫으면 실패 코드를 남긴다", () => {
    const { env } = fakePkexec(126);
    const resultFile = path.join(workDirectory, "result.json");

    const run = runScript(LINUX_INSTALL_SCRIPT, args("/tmp/p.deb", resultFile), env);

    expect(run.status).toBe(1);
    expect(readResult(resultFile)).toMatchObject({ status: "failed", code: "install-exit-126" });
  });

  it("인증 에이전트가 응답하지 않으면 시간 제한 뒤 포기한다", () => {
    const { env } = fakePkexec(0, 10);
    const resultFile = path.join(workDirectory, "result.json");
    const startedAt = Date.now();

    const run = runScript(LINUX_INSTALL_SCRIPT, args("/tmp/p.deb", resultFile, 1), env);

    expect(run.status).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(readResult(resultFile)).toMatchObject({ status: "failed", code: "timeout" });
  });
});
