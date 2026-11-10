import { ResendVerificationButton } from "@/components/settings-forms";

export function VerifyBanner() {
  return (
    <div className="mb-6 flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
      <p>
        <strong className="font-semibold">Verify your email.</strong> We sent a link to your
        inbox. It unlocks AI cover letter drafts.
      </p>
      <ResendVerificationButton variant="ghost" />
    </div>
  );
}
