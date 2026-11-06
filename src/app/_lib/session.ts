import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth } from "@/lib/auth";

export type CurrentUser = { readonly id: string; readonly email: string; readonly name: string };

/**
 * The signed-in user, or `null`. Reads request headers, so call it inside a
 * Suspense boundary. Memoized per request, so several components can call it.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  // Await headers() before touching getAuth(): prerendering stops at headers(),
  // so builds never need auth env vars.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return null;
  return { id: session.user.id, email: session.user.email, name: session.user.name };
});

/** The signed-in user; redirects to /sign-in when there is no valid session. */
export const requireCurrentUser = async (): Promise<CurrentUser> => {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
};
