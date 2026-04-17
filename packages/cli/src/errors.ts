/**
 * Thrown when the user cancels an interactive prompt (Ctrl+C, EOF).
 * Commands should catch this and exit silently.
 */
export class UserCancelledError extends Error {
  constructor() {
    super('User cancelled')
    this.name = 'UserCancelledError'
  }
}

/** Type guard for UserCancelledError. */
export function isUserCancelled(err: unknown): err is UserCancelledError {
  return err instanceof UserCancelledError
}

/** GitHub Issues URL for filing bug reports. */
export const ISSUES_URL = 'https://github.com/akalforge/supaforge/issues/new'
