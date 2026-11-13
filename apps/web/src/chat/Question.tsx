import type { AgentClient, TranscriptItem } from "@neo/client";
import { Check, MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { cn, errorText } from "../lib/format";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Avatar";

export type Ask = NonNullable<(TranscriptItem & { type: "tool" })["ask"]>;

export function QuestionCard({ client, ask }: { client: AgentClient; ask: Ask }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Record<string, string>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const answered = ask.answer?.answers ?? sent;
  const single = ask.questions.length === 1;
  const ready = ask.questions.every((q) => drafts[q.id]?.trim());

  const submit = async (answers: Record<string, string>) => {
    setBusy(true);
    setError(undefined);
    try {
      await client.answer(
        { questionId: ask.questionId, answers },
        { clientId: `answer:${ask.questionId}` },
      );
      setSent(answers);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  return (
    <div
      className={cn(
        "animate-up my-1 w-full max-w-[600px] overflow-hidden rounded-2xl border bg-raised shadow-sm",
        answered ? "border-line" : "border-brand/30 ring-4 ring-brand/5",
      )}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[12.5px] font-medium text-muted">
        {answered ? (
          <Check className="size-3.5 text-ok" />
        ) : (
          <MessageCircleQuestion className="size-3.5 text-brand" />
        )}
        {answered ? "Answered" : single ? "Question for you" : `${ask.questions.length} questions for you`}
        {busy && <Spinner className="ml-auto text-faint" />}
      </div>
      <div className="flex flex-col gap-5 p-4">
        {ask.questions.map((q) => {
          const chosen = answered?.[q.id] ?? drafts[q.id];
          const custom = answered && !q.options?.some((o) => o.label === answered[q.id]);
          return (
            <div key={q.id} className="flex flex-col gap-2.5">
              <div className="text-[14px] font-medium">{q.question}</div>
              {q.options?.length ? (
                <div className="flex flex-col gap-1.5">
                  {q.options.map((o) => {
                    const on = chosen === o.label;
                    return (
                      <button
                        key={o.label}
                        type="button"
                        disabled={!!answered || busy}
                        onClick={() =>
                          single
                            ? void submit({ [q.id]: o.label })
                            : setDrafts({ ...drafts, [q.id]: o.label })
                        }
                        className={cn(
                          "flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-all",
                          on
                            ? "border-brand/50 bg-brand/8"
                            : "border-line hover:border-line-strong hover:bg-hover",
                          answered && !on && "opacity-45",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                            on ? "border-brand bg-brand text-white" : "border-line-strong",
                          )}
                        >
                          {on && <Check className="size-2.5" strokeWidth={3} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13.5px] font-medium">{o.label}</span>
                          {o.description && (
                            <span className="block text-[12.5px] text-muted">{o.description}</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {answered ? (
                custom && (
                  <div className="rounded-xl bg-sunken px-3 py-2 text-[13.5px]">
                    {answered[q.id] ?? "—"}
                  </div>
                )
              ) : (
                <input
                  className="h-9 rounded-xl border border-line bg-transparent px-3 text-[13.5px] outline-none placeholder:text-faint focus:border-brand/50"
                  placeholder={q.options?.length ? "Or type your own answer" : "Type your answer"}
                  value={q.options?.some((o) => o.label === drafts[q.id]) ? "" : (drafts[q.id] ?? "")}
                  disabled={busy}
                  onChange={(e) => setDrafts({ ...drafts, [q.id]: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && ready) void submit(drafts);
                  }}
                />
              )}
            </div>
          );
        })}
        {!answered && (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" disabled={!ready || busy} onClick={() => void submit(drafts)}>
              Send answer
            </Button>
          </div>
        )}
        {error && <div className="text-[12.5px] text-danger">{error}</div>}
      </div>
    </div>
  );
}
