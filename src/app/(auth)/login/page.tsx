import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>;
}) {
  const { reset } = await searchParams;
  return (
    <>
      <h1 className="text-xl font-semibold text-zinc-900">Welcome back</h1>
      <p className="mb-6 mt-1 text-sm text-zinc-500">
        Sign in to see your applications.
      </p>
      <AuthForm
        mode="login"
        notice={reset ? "Password updated. Sign in with your new password." : undefined}
      />
    </>
  );
}
