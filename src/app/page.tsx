import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getCurrentUser } from "@/app/_lib/session";

// src/proxy.ts answers `/` with an HTTP redirect based on the session cookie;
// this verifies the session itself in case the proxy is bypassed.
export default function HomePage() {
  return (
    <Suspense>
      <HomeRedirect />
    </Suspense>
  );
}

async function HomeRedirect(): Promise<null> {
  const user = await getCurrentUser();
  redirect(user ? "/dashboard" : "/sign-in");
}
