import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { signOutEverywhere } from "@/app/actions/account";
import { Button, Card, PageHeader } from "@/components/ui";
import {
  ChangePasswordForm,
  DeleteAccountForm,
  ResendVerificationButton,
} from "@/components/settings-forms";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "Settings" };

function Section({
  title,
  description,
  children,
  tone,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <Card className={tone === "danger" ? "border-rose-200 p-5 sm:p-6" : "p-5 sm:p-6"}>
      <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
      {description && <p className="mb-4 mt-1 text-sm text-zinc-500">{description}</p>}
      {!description && <div className="mb-4" />}
      {children}
    </Card>
  );
}

export default async function SettingsPage() {
  const user = await requireUser();

  return (
    <>
      <PageHeader title="Settings" description="Manage your account and security." />
      <div className="space-y-6">
        <Section title="Account">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-zinc-500">Email</dt>
            <dd className="text-zinc-900">
              {user.email}{" "}
              {user.emailVerifiedAt ? (
                <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                  Verified {formatDate(user.emailVerifiedAt)}
                </span>
              ) : (
                <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                  Not verified
                </span>
              )}
            </dd>
            {user.name && (
              <>
                <dt className="text-zinc-500">Name</dt>
                <dd className="text-zinc-900">{user.name}</dd>
              </>
            )}
          </dl>
          {!user.emailVerifiedAt && (
            <div className="mt-4">
              <p className="mb-3 text-sm text-zinc-600">
                Verify your email to use AI cover letter drafts and to make sure you can recover your account.
              </p>
              <ResendVerificationButton />
            </div>
          )}
        </Section>

        <Section title="Change password" description="Other devices will be signed out.">
          <ChangePasswordForm />
        </Section>

        <Section title="Sessions" description="Sign out everywhere, including this device.">
          <form action={signOutEverywhere}>
            <Button type="submit" variant="secondary">Sign out of all devices</Button>
          </form>
        </Section>

        <Section
          tone="danger"
          title="Delete account"
          description="Permanently deletes your account, applications, and uploaded resumes."
        >
          <DeleteAccountForm />
        </Section>
      </div>
    </>
  );
}
