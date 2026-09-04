export type ProfileLinkFailureCode =
  | "PROFILE_EXCLUSIVE_CONFLICT"
  | "OWNER_WRITE_FAILED";

/**
 * A profile link/unlink operation was deliberately refused or could not
 * persist its ownership change. Routes use this type to avoid acknowledging
 * an operation that wrote nothing.
 */
export class ProfileLinkFailure extends Error {
  constructor(
    readonly code: ProfileLinkFailureCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ProfileLinkFailure";
  }
}
