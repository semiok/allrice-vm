import { PersonVmError, type NativeWebSetupFailure } from '@allrice/person-vm';
import { DEntryNativeUnavailable } from '../d-entry/native-owner.js';

const vmCodes = new Set([
  'AUTHORIZATION_DENIED',
  'LEASE_LOST',
  'LEASE_CONFLICT',
  'RUNTIME_NOT_READY',
  'PROVIDER_FAILED',
  'EGRESS_UNAVAILABLE',
  'EGRESS_BINDING_INVALID',
  'WEB_ENDPOINTS_PREPARING',
  'CLEANUP_INCOMPLETE',
]);

const ioCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_STREAM_PREMATURE_CLOSE',
  'HPE_INVALID_CONSTANT',
]);

type Failure = Omit<NativeWebSetupFailure, 'step' | 'target'>;

/** Project known values only. Never serialize errors, messages, URLs, or headers. */
export function nativeSetupError(error: unknown, status?: number): Failure {
  const httpStatus =
    status !== undefined &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? status
      : undefined;
  const http = httpStatus === undefined ? {} : { httpStatus };
  if (error === 'NATIVE_JOB_EXITED')
    return { errorType: 'NativeJobExit', errorCode: error, ...http };
  try {
    if (error instanceof DEntryNativeUnavailable && error.graphRule) {
      const errorType = 'DEntryNativeUnavailable';
      return { errorType, errorCode: error.graphRule, ...http };
    }
    if (error instanceof PersonVmError) {
      const cause = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
      const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
      return {
        errorType: 'PersonVmError',
        errorCode:
          cause === 'AUTH_ARTIFACT_INVALID' ||
          cause === 'AUTH_ARTIFACT_READ_FAILED'
            ? cause
            : typeof code === 'string' && vmCodes.has(code)
              ? code
              : undefined,
        ...http,
      };
    }
    if (error instanceof DOMException) {
      const name = error.name;
      if (name === 'TimeoutError' || name === 'AbortError')
        return { errorType: name, ...http };
    }
    if (error instanceof Error) {
      const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
      if (typeof code === 'string' && ioCodes.has(code))
        return { errorType: 'SystemError', errorCode: code, ...http };
      if (code === 'ABORT_ERR')
        return { errorType: 'AbortError', errorCode: code, ...http };
      if (error instanceof SyntaxError)
        return { errorType: 'SyntaxError', ...http };
      if (error instanceof TypeError)
        return { errorType: 'TypeError', ...http };
    }
  } catch {
    // Diagnostics also accept opaque abort reasons and cannot throw on them.
  }
  return httpStatus === undefined
    ? { errorType: 'Error' }
    : {
        errorType: 'HttpError',
        errorCode: 'UNEXPECTED_HTTP_RESPONSE',
        ...http,
      };
}

export function nativeSetupTarget(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    if (
      url.protocol === 'http:' &&
      url.port &&
      ['127.0.0.1', '[::1]'].includes(url.hostname)
    )
      return url.host;
  } catch {
    // Invalid configuration is still a reportable stage without a target.
  }
}
