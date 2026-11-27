import path from "node:path";
import { app, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { getTranslations } from "../shared/i18n.js";
import { UpdateStatus } from "../shared/types.js";
import {
  hasPkexec,
  launchDetachedInstaller,
  LINUX_INSTALL_SCRIPT,
  linuxInstallArgs,
  linuxPackageKind,
  MAC_INSTALL_SCRIPT,
  macInstallArgs,
  resolveMacAppBundle,
  takeSelfInstallResult
} from "./selfInstaller.js";
import { getSettings } from "./settingsStore.js";
import { normalizeUpdateError } from "./updateError.js";

const MAC_BUNDLE_ID = "com.apg0001.aiusagewidget";

type UpdateStatusListener = (status: UpdateStatus) => void;

let listener: UpdateStatusListener | null = null;
let latestStatus: UpdateStatus = { state: "idle" };
let initialized = false;
let lastErrorKey = "";
let lastErrorAt = 0;
// 승인 후 앱 밖의 도우미가 설치할 업데이트(macOS zip, Linux deb/rpm/pacman).
let pendingSelfInstall: { file: string; version: string } | null = null;
// 도우미 설치가 실패한 버전은 같은 버전에서 다시 자동 설치를 권하지 않고 수동 안내로 돌린다.
let failedSelfInstallVersion: string | null = null;

// deb/rpm 설치본은 새 버전을 적용하려면 pkexec로 root 권한을 얻어야 한다. GUI polkit
// 인증 에이전트가 없는 세션(미니멀 WM, 일부 원격 데스크톱 등)에서는 pkexec가 응답을
// 영원히 기다리며 앱 전체가 멈춰버리므로, 이 조합에서는 자동 설치를 아예 시도하지
// 않고 사용자가 직접 실행할 수 있는 설치 명령을 안내한다. AppImage는 파일 자체를
// 사용자 권한으로 교체하는 방식이라 root가 필요 없어 해당 없음(APPIMAGE 환경 변수로 판별).
const isLinuxManualInstall = process.platform === "linux" && !process.env.APPIMAGE;

// macOS 빌드는 코드사이닝/공증 없이 배포되는데, electron-updater의 mac 설치 단계(Squirrel.Mac)는
// 실행 중인 앱과 새 번들의 서명이 일치해야만 자동 설치를 진행한다. 다운로드는 latest-mac.yml의
// SHA-512로 검증되므로 Squirrel 단계만 건너뛰고, 승인하면 앱 밖의 도우미가 받아둔 zip으로 번들을
// 교체한 뒤 다시 실행한다(selfInstaller.ts). 도우미를 쓸 수 없으면 zip 위치를 안내한다.
const isMacManualInstall = process.platform === "darwin";
const isManualInstall = isLinuxManualInstall || isMacManualInstall;

function selfInstallResultFile() {
  return path.join(app.getPath("userData"), "update-install-result.json");
}

function canSelfInstall(downloadedFile: string, version: string) {
  if (failedSelfInstallVersion === version) {
    return false;
  }
  if (isMacManualInstall) {
    return downloadedFile.endsWith(".zip") && resolveMacAppBundle(app.getPath("exe")) !== null;
  }
  if (isLinuxManualInstall) {
    return linuxPackageKind(downloadedFile) !== null && hasPkexec();
  }
  return false;
}

function quoteShellPath(filePath: string): string {
  return `'${filePath.replace(/'/g, "'\\''")}'`;
}

function buildManualInstallCommand(downloadedFile: string): string {
  const target = quoteShellPath(downloadedFile);
  if (downloadedFile.endsWith(".rpm")) {
    return `sudo rpm -U ${target}`;
  }
  if (downloadedFile.endsWith(".pacman")) {
    return `sudo pacman -U ${target}`;
  }
  // apt는 dpkg와 달리 새로 추가된 의존성까지 함께 설치해 준다.
  return `sudo apt install -y ${target}`;
}

function emit(status: UpdateStatus) {
  if (status.state !== "error") {
    lastErrorKey = "";
    lastErrorAt = 0;
  }
  latestStatus = status;
  listener?.(status);
}

function emitError(error: unknown) {
  const normalized = normalizeUpdateError(error);
  const key = `${normalized.errorCode}:${normalized.diagnosticCode}:${normalized.causeCode ?? ""}`;
  const now = Date.now();
  if (key === lastErrorKey && now - lastErrorAt < 1_000) {
    return;
  }
  lastErrorKey = key;
  lastErrorAt = now;
  emit({ state: "error", ...normalized });
}

export function getLatestUpdateStatus(): UpdateStatus {
  return latestStatus;
}

export function onUpdateStatusChange(callback: UpdateStatusListener) {
  listener = callback;
}

export function initAutoUpdate() {
  if (initialized || !app.isPackaged) {
    return;
  }
  initialized = true;

  autoUpdater.autoDownload = true;
  // 수동 설치 케이스(리눅스 root 필요 조합, macOS 미서명 빌드)는 앱 종료 시점에도
  // 설치를 자동으로 걸지 않는다(위 주석 참고).
  autoUpdater.autoInstallOnAppQuit = !isManualInstall;

  autoUpdater.on("checking-for-update", () => emit({ state: "checking" }));
  autoUpdater.on("update-available", (info) => emit({ state: "available", version: info.version }));
  autoUpdater.on("update-not-available", (info) => emit({ state: "not-available", version: info.version }));
  autoUpdater.on("download-progress", (progress) => emit({ state: "downloading", progressPercent: Math.round(progress.percent) }));
  const previousSelfInstall = takeSelfInstallResult(selfInstallResultFile());
  if (previousSelfInstall?.status === "failed") {
    failedSelfInstallVersion = previousSelfInstall.version;
  }

  autoUpdater.on("update-downloaded", (info) => {
    if (isManualInstall && canSelfInstall(info.downloadedFile, info.version)) {
      pendingSelfInstall = { file: info.downloadedFile, version: info.version };
      emit({ state: "downloaded", version: info.version, selfInstall: true });
      return;
    }
    pendingSelfInstall = null;
    emitManualInstall(info.version, info.downloadedFile);
  });
  autoUpdater.on("error", emitError);

  void checkForUpdates();
}

function emitManualInstall(version: string, downloadedFile: string) {
  emit({
    state: "downloaded",
    version,
    manualInstallCommand: isLinuxManualInstall ? buildManualInstallCommand(downloadedFile) : undefined,
    manualInstallPath: isMacManualInstall ? downloadedFile : undefined,
    ...(failedSelfInstallVersion === version ? { autoInstallFailed: true } : {})
  });
}

function startSelfInstall(update: { file: string; version: string }) {
  const resultFile = selfInstallResultFile();
  if (isMacManualInstall) {
    const targetApp = resolveMacAppBundle(app.getPath("exe"));
    if (!targetApp) {
      return false;
    }
    launchDetachedInstaller(MAC_INSTALL_SCRIPT, macInstallArgs({
      appPid: process.pid,
      updateZip: update.file,
      targetApp,
      bundleId: MAC_BUNDLE_ID,
      resultFile,
      version: update.version
    }));
    return true;
  }
  const kind = linuxPackageKind(update.file);
  if (!kind) {
    return false;
  }
  launchDetachedInstaller(LINUX_INSTALL_SCRIPT, linuxInstallArgs({
    appPid: process.pid,
    packageFile: update.file,
    kind,
    appExecutable: app.getPath("exe"),
    resultFile,
    version: update.version
  }));
  return true;
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    const t = getTranslations(getSettings().language);
    emit({ state: "not-available", message: t.updates.devModeNote });
    return;
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    emitError(error);
  }
}

export function quitAndInstallUpdate() {
  if (isManualInstall) {
    // 리눅스 pkexec는 세션에 따라 응답 없이 멈출 수 있고, macOS는 미서명 빌드라
    // Squirrel.Mac이 자동 설치를 거부한다. 그래서 앱이 직접 설치하지 않고, 앱 밖의
    // 도우미가 앱 종료 뒤 설치하고 다시 실행한다. 도우미를 띄우지 못하면 수동 안내로 돌린다.
    const update = pendingSelfInstall;
    if (!update) {
      return;
    }
    try {
      if (startSelfInstall(update)) {
        pendingSelfInstall = null;
        app.quit();
        return;
      }
    } catch {
      // 아래 수동 안내로 넘어간다.
    }
    pendingSelfInstall = null;
    failedSelfInstallVersion = update.version;
    emitManualInstall(update.version, update.file);
    return;
  }
  autoUpdater.quitAndInstall();
}

export function revealDownloadedUpdate() {
  const path = latestStatus.state === "downloaded" ? latestStatus.manualInstallPath : undefined;
  if (path) {
    shell.showItemInFolder(path);
  }
}
