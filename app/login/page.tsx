import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { ADMIN_COOKIE_NAME, adminAuthConfigured, verifyAdminKey } from "@/lib/auth";

export const metadata = {
  title: "Sign in · HEATER Ver1",
};

export const dynamic = "force-dynamic";

/**
 * The dashboard's sign-in page. Deliberately outside the `(dashboard)` route
 * group - it renders on its own, without the sidebar and live stream, since
 * neither means anything before there is a cookie to authenticate them with.
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  // Nothing to sign in to - HEATER_ADMIN_KEY is unset and the API is already
  // open. Sending an admin here would suggest a login that doesn't exist.
  if (!adminAuthConfigured()) redirect("/");

  const jar = await cookies();
  const presented = jar.get(ADMIN_COOKIE_NAME)?.value;
  if (presented && verifyAdminKey(presented)) redirect("/");

  const params = await searchParams;
  const rawNext = typeof params.next === "string" ? params.next : "/";
  // Only ever redirect back into this app - a "next" from the query string is
  // attacker-controlled.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  return (
    <div className="grid min-h-dvh place-items-center bg-surface-muted px-4">
      <LoginForm next={next} />
    </div>
  );
}
