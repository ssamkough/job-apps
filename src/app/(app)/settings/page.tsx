import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import {
  ChangePasswordForm,
  DeleteAccountForm,
  SignOutEverywhereForm,
} from "@/components/settings-forms";

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
              <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                Verified
              </span>
            </dd>
            {user.name && (
              <>
                <dt className="text-zinc-500">Name</dt>
                <dd className="text-zinc-900">{user.name}</dd>
              </>
            )}
          </dl>
        </Section>

        <Section title="Change password" description="Other devices will be signed out.">
          <ChangePasswordForm />
        </Section>

        <Section title="Sessions" description="Sign out everywhere, including this device.">
          <SignOutEverywhereForm />
        </Section>

        <Section
          tone="danger"
          title="Delete account"
          description="Permanently deletes your applications and uploaded resumes, and ends all sessions. Your sign-in details (email and password hash) are held by our sign-in provider and removed on request. See the privacy page."
        >
          <DeleteAccountForm />
        </Section>
      </div>
    </>
  );
}
