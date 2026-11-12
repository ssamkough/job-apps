import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { createApplication } from "@/app/actions/applications";
import { aiEnabled, importAiEnabled, importEnabled } from "@/lib/features";
import { todayDateInput } from "@/lib/format";
import { PageHeader } from "@/components/ui";
import { loadQuestionLibrary } from "@/lib/question-store";
import { ImportBox } from "@/components/import-box";
import {
  ApplicationForm,
  type ApplicationFormValues,
} from "@/components/application-form";

export const metadata: Metadata = { title: "Add application" };

const empty: ApplicationFormValues = {
  company: "",
  jobTitle: "",
  jobUrl: "",
  location: "",
  workType: "",
  salary: "",
  source: "",
  status: "APPLIED",
  dateApplied: "",
  jobDescription: "",
  notes: "",
  coverLetter: "",
  contactName: "",
  contactEmail: "",
  resumeId: "",
};

export default async function NewApplicationPage() {
  const user = await requireUser();
  const [resumes, library] = await Promise.all([
    db.resume.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, fileName: true },
    }),
    loadQuestionLibrary(user.id),
  ]);

  return (
    <>
      <PageHeader
        title="Add application"
        description="Only company and job title are required. You can fill in the rest later."
      />
      {importEnabled() && (
        <ImportBox formId="application-form" queueAvailable={importAiEnabled()} />
      )}
      <ApplicationForm
        id="application-form"
        action={createApplication}
        initial={{ ...empty, dateApplied: todayDateInput() }}
        resumes={resumes}
        library={library}
        aiEnabled={aiEnabled()}
        submitLabel="Add application"
      />
    </>
  );
}
