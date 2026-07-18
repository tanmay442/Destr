import { err, ok, type Result, ForbiddenError } from '@app/domain';
import type { UserRepository } from '@app/domain';

export interface ActorAuthDeps {
  users: UserRepository;
}

export async function requireAdminActor(
  actorId: string,
  deps: ActorAuthDeps,
): Promise<Result<void>> {
  try {
    if (!actorId) return err(new ForbiddenError('Admin role required'));
    const actor = await deps.users.findByClerkId(actorId);
    if (!actor || actor.role !== 'admin') {
      return err(new ForbiddenError('Admin role required'));
    }
    return ok(undefined);
  } catch {
    return err(new ForbiddenError('Admin role required'));
  }
}
