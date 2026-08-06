import { err, ok, type Result, ForbiddenError, ExternalServiceError } from '@app/domain';
import type { UserRepository } from '@app/domain';

export interface ActorAuthDeps {
  users: UserRepository;
}

export async function requireAdminActor(
  actorId: string,
  deps: ActorAuthDeps,
): Promise<Result<void>> {
  if (!actorId) return err(new ForbiddenError('Admin role required'));
  let actor;
  try {
    actor = await deps.users.findByClerkId(actorId);
  } catch (cause) {
    return err(new ExternalServiceError('Failed to check admin role', cause));
  }
  if (!actor || actor.role !== 'admin') {
    return err(new ForbiddenError('Admin role required'));
  }
  return ok(undefined);
}
