import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <>
      <h1 className="text-xl font-semibold text-zinc-900">Create your account</h1>
      <p className="mb-6 mt-1 text-sm text-zinc-500">
        Start tracking your job search in one place.
      </p>
      <AuthForm mode="signup" />
    </>
  );
}
