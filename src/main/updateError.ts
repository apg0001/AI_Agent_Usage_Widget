import { UpdateDiagnosticCode, UpdateErrorCode } from "../shared/types.js";

export type NormalizedUpdateError = {
  errorCode: UpdateErrorCode;
  diagnosticCode: UpdateDiagnosticCode;
  /** Unclassified errors only: a constant identifier such as ENOENT, ERR_UPDATER_X, HTTP_404 or TypeError. */
  causeCode?: string;
};

type ErrorLike = {
  code?: unknown;
  statusCode?: unknown;
  message?: unknown;
  name?: unknown;
  cause?: unknown;
};

function classificationText(error: unknown, depth = 0): string {
  if (depth > 2 || error == null) {
    return "";
  }

  if (typeof error !== "object") {
    return String(error);
  }

  const candidate = error as ErrorLike;
  return [
    candidate.code,
    candidate.statusCode,
    candidate.name,
    candidate.message,
    classificationText(candidate.cause, depth + 1)
  ].filter((value) => value != null).join(" ");
}

// Identifiers only: messages, paths and stacks never pass these shapes, so the
// code is safe to show and copy even though the raw error stays private.
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE_ERROR_NAME = /^[A-Z][A-Za-z]{0,39}Error$/;

function safeCauseCode(error: unknown, depth = 0): string | undefined {
  if (depth > 2 || error == null || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as ErrorLike;
  if (typeof candidate.code === "string" && SAFE_ERROR_CODE.test(candidate.code)) {
    return candidate.code;
  }
  if (typeof candidate.statusCode === "number" && Number.isInteger(candidate.statusCode) && candidate.statusCode >= 100 && candidate.statusCode <= 599) {
    return `HTTP_${candidate.statusCode}`;
  }
  const fromCause = safeCauseCode(candidate.cause, depth + 1);
  if (fromCause) {
    return fromCause;
  }
  if (typeof candidate.name === "string" && candidate.name !== "Error" && SAFE_ERROR_NAME.test(candidate.name)) {
    return candidate.name;
  }
  return undefined;
}

export function normalizeUpdateError(error: unknown): NormalizedUpdateError {
  const text = classificationText(error);

  if (
    /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(text) ||
    (/latest(?:-[\w]+)?\.ya?ml/i.test(text) && /(?:404|not found|cannot find)/i.test(text))
  ) {
    return {
      errorCode: "metadata-missing",
      diagnosticCode: "UPDATE_METADATA_MISSING"
    };
  }

  if (/(?:HTTP_ERROR_(?:401|403)|\b(?:401|403)\b|EACCES|EPERM|unauthori[sz]ed|forbidden|permission denied)/i.test(text)) {
    return {
      errorCode: "access-denied",
      diagnosticCode: "UPDATE_ACCESS_DENIED"
    };
  }

  if (/(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|net::ERR_|ERR_(?:NETWORK|INTERNET)|network|offline|socket hang up)/i.test(text)) {
    return {
      errorCode: "network",
      diagnosticCode: "UPDATE_NETWORK"
    };
  }

  if (/ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(text)) {
    return {
      errorCode: "metadata-missing",
      diagnosticCode: "UPDATE_METADATA_MISSING"
    };
  }

  if (/(?:sha512|checksum|signature|integrity|digest mismatch)/i.test(text)) {
    return {
      errorCode: "invalid-release",
      diagnosticCode: "UPDATE_INTEGRITY"
    };
  }

  const causeCode = safeCauseCode(error);
  return {
    errorCode: "unknown",
    diagnosticCode: "UPDATE_UNKNOWN",
    ...(causeCode ? { causeCode } : {})
  };
}
