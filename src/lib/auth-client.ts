import { createAuthClient } from "better-auth/react";

/** Browser auth client (GitHub sign-in and sign-out; see src/lib/auth.ts). */
export const authClient = createAuthClient();
