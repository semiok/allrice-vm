import {
  DataAccessError,
  DEntryPersonRolloutConflict,
  IdentityError,
} from '@allrice/database';
import {
  apiProblem,
  isRequestValidationError,
  type ApiProblemOptions,
} from '../api-error-response';
import { getRequestContext } from './session';

export const administrationHeaders = { 'Cache-Control': 'private, no-store' };

export async function requireAdministrationLogin(request: Request) {
  const context = await getRequestContext(request);
  if (!context || context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  return context;
}

export function administrationError(error: unknown) {
  const problem = (options: ApiProblemOptions) => {
    const response = apiProblem(options);
    response.headers.set(
      'Cache-Control',
      administrationHeaders['Cache-Control'],
    );
    return response;
  };
  if (error instanceof IdentityError) {
    if (error.code === 'authentication_failed')
      return problem({
        status: 401,
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
      });
    if (
      error.code === 'authorization_denied' ||
      error.code === 'tenant_context_invalid'
    )
      return problem({
        status: 403,
        code: 'AUTHORIZATION_DENIED',
        message: 'Access denied',
      });
  }
  if (error instanceof DataAccessError) {
    if (error.code === 'authentication_required')
      return problem({
        status: 401,
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
      });
    if (error.code === 'authorization_denied')
      return problem({
        status: 403,
        code: 'AUTHORIZATION_DENIED',
        message: 'Access denied',
      });
    return problem({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
      message: 'Resource not found',
    });
  }
  if (error instanceof DEntryPersonRolloutConflict)
    return problem({
      status: 409,
      code: 'CONFLICT',
      message: 'Rollout policy changed. Refresh before updating.',
    });
  if (isRequestValidationError(error))
    return problem({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed',
    });
  return problem({
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Administration request failed',
  });
}
