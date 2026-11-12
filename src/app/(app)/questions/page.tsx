import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { createQuestion } from "@/app/actions/questions";
import { plural } from "@/lib/format";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { CreateQuestionForm } from "@/components/question-forms";

export const metadata: Metadata = { title: "Questions" };

export default async function QuestionsPage() {
  const user = await requireUser();
  const questions = await db.question.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { answers: true, applications: true } } },
  });

  return (
    <>
      <PageHeader
        title="Questions"
        description="Application questions you've met, each with the answers you've written. Attach them to any application."
      />

      <CreateQuestionForm action={createQuestion} />

      {questions.length === 0 ? (
        <Card>
          <EmptyState
            title="No questions yet"
            description="Add one above, or attach questions while adding an application. Importing a posting also finds the ones it asks."
          />
        </Card>
      ) : (
        <Card className="divide-y divide-zinc-100">
          {questions.map((q) => (
            <Link
              key={q.id}
              href={`/questions/${q.id}`}
              className="block p-4 hover:bg-zinc-50 focus-visible:bg-zinc-50"
            >
              <p className="font-medium text-zinc-900">{q.text}</p>
              <p className="mt-1 text-sm text-zinc-500">
                {q._count.answers === 0 ? "No answers yet" : plural(q._count.answers, "answer")} ·{" "}
                {q._count.applications === 0
                  ? "Not used yet"
                  : `Used in ${plural(q._count.applications, "application")}`}
              </p>
            </Link>
          ))}
        </Card>
      )}
    </>
  );
}
