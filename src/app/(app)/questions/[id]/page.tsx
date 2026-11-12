import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  addAnswer,
  deleteAnswer,
  deleteQuestion,
  updateAnswer,
  updateQuestion,
} from "@/app/actions/questions";
import { Card, EmptyState } from "@/components/ui";
import { DeleteButton } from "@/components/delete-button";
import { AnswerForm, CopyButton, QuestionTextForm } from "@/components/question-forms";
import { StatusBadge } from "@/components/status-badge";
import { MAX_ANSWERS_PER_QUESTION } from "@/lib/questions";
import { plural } from "@/lib/format";

export const metadata: Metadata = { title: "Question" };

export default async function QuestionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const question = await db.question.findFirst({
    where: { id, userId: user.id },
    include: {
      answers: { orderBy: { createdAt: "asc" } },
      applications: {
        include: {
          application: { select: { id: true, company: true, jobTitle: true, status: true } },
          answer: { select: { id: true, label: true } },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!question) notFound();

  const usedByAnswer = new Map<string, number>();
  for (const link of question.applications) {
    if (link.answerId) usedByAnswer.set(link.answerId, (usedByAnswer.get(link.answerId) ?? 0) + 1);
  }

  return (
    <>
      <Link href="/questions" className="mb-4 inline-block text-sm text-zinc-500 hover:text-zinc-800">
        ← All questions
      </Link>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight text-zinc-900">Question</h1>
        <DeleteButton
          action={deleteQuestion.bind(null, question.id)}
          confirmMessage={`Delete this question and its ${plural(question.answers.length, "answer")}? ${
            question.applications.length > 0
              ? `It's attached to ${plural(question.applications.length, "application")}; they'll stay but lose it. `
              : ""
          }This can't be undone.`}
        >
          Delete
        </DeleteButton>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <QuestionTextForm
              key={question.updatedAt.getTime()}
              action={updateQuestion.bind(null, question.id)}
              text={question.text}
            />
          </Card>

          <section aria-labelledby="variants-heading" className="space-y-4">
            <h2 id="variants-heading" className="text-sm font-semibold text-zinc-900">
              Answers ({question.answers.length})
            </h2>
            {question.answers.length === 0 && (
              <Card>
                <EmptyState
                  title="No answers yet"
                  description="Write one below. Add more variants for different kinds of roles or lengths."
                />
              </Card>
            )}
            {question.answers.map((a, i) => (
              <Card key={a.id} className="p-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-zinc-900">{a.label || `Variant ${i + 1}`}</h3>
                  <span className="text-xs text-zinc-500">
                    {a.source === "AI" ? "AI draft · " : ""}
                    {usedByAnswer.has(a.id)
                      ? `Chosen for ${plural(usedByAnswer.get(a.id)!, "application")}`
                      : "Not chosen anywhere"}
                  </span>
                </div>
                <AnswerForm
                  key={a.updatedAt.getTime()}
                  id={`answer-${a.id}`}
                  action={updateAnswer.bind(null, a.id)}
                  label={a.label ?? ""}
                  body={a.body}
                  submitLabel="Save"
                  actions={
                    <>
                      <CopyButton text={a.body} />
                      <DeleteButton
                        action={deleteAnswer.bind(null, a.id)}
                        confirmMessage={
                          usedByAnswer.has(a.id)
                            ? `Delete this variant? ${plural(usedByAnswer.get(a.id)!, "application")} chose it and will have no answer picked.`
                            : "Delete this variant?"
                        }
                      >
                        Delete
                      </DeleteButton>
                    </>
                  }
                />
              </Card>
            ))}

            {question.answers.length < MAX_ANSWERS_PER_QUESTION && (
              <Card className="p-5">
                <h3 className="mb-3 text-sm font-medium text-zinc-900">
                  {question.answers.length === 0 ? "Write an answer" : "Add another variant"}
                </h3>
                <AnswerForm
                  id="new-answer"
                  action={addAnswer.bind(null, question.id)}
                  submitLabel="Add answer"
                />
              </Card>
            )}
          </section>
        </div>

        <aside>
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900">Used in</h2>
            {question.applications.length === 0 ? (
              <p className="text-sm text-zinc-500">
                Not attached to any application yet. Attach it from an application&apos;s page.
              </p>
            ) : (
              <ul className="space-y-3">
                {question.applications.map((link) => (
                  <li key={link.applicationId} className="text-sm">
                    <Link
                      href={`/applications/${link.application.id}`}
                      className="font-medium text-indigo-700 hover:text-indigo-600"
                    >
                      {link.application.company}
                    </Link>
                    <span className="text-zinc-500"> · {link.application.jobTitle}</span>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <StatusBadge status={link.application.status} />
                      <span className="text-xs text-zinc-500">
                        {link.answer ? `Answer: ${link.answer.label || "chosen variant"}` : "No answer chosen"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}
