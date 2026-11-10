"use client";

import Link from "next/link";
import { useActionState } from "react";
import { login, signup } from "@/app/actions/auth";
import type { FormState } from "@/lib/form-state";
import { Field, Notice, inputClass, linkClass } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

const initial: FormState = {};

export function AuthForm({
  mode,
  notice,
}: {
  mode: "login" | "signup";
  notice?: string;
}) {
  const isSignup = mode === "signup";
  const [state, action] = useActionState(isSignup ? signup : login, initial);
  const err = state.errors ?? {};

  return (
    <form action={action} className="space-y-4" noValidate>
      {notice && !state.message && <Notice tone="success">{notice}</Notice>}
      {state.message && <Notice tone="error">{state.message}</Notice>}

      {isSignup && (
        <Field label="Name (optional)" htmlFor="name" error={err.name}>
          <input
            id="name"
            name="name"
            autoComplete="name"
            defaultValue={state.values?.name}
            className={inputClass}
          />
        </Field>
      )}

      <Field label="Email" htmlFor="email" error={err.email}>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state.values?.email}
          aria-invalid={!!err.email}
          aria-describedby={err.email ? "email-error" : undefined}
          className={inputClass}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        error={err.password}
        hint={isSignup ? "At least 8 characters." : undefined}
      >
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={isSignup ? "new-password" : "current-password"}
          required
          aria-invalid={!!err.password}
          aria-describedby={err.password ? "password-error" : undefined}
          className={inputClass}
        />
      </Field>

      {!isSignup && (
        <p className="-mt-1 text-right text-sm">
          <Link href="/forgot-password" className={linkClass}>
            Forgot password?
          </Link>
        </p>
      )}

      <SubmitButton
        className="w-full"
        pendingText={isSignup ? "Creating account…" : "Signing in…"}
      >
        {isSignup ? "Create account" : "Sign in"}
      </SubmitButton>

      <p className="text-center text-sm text-zinc-500">
        {isSignup ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-indigo-600 hover:text-indigo-500">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link href="/signup" className="font-medium text-indigo-600 hover:text-indigo-500">
              Create an account
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
