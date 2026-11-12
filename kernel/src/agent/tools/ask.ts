import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { Question } from "@neo/client";
import Value from "typebox/value";
import { ulid } from "../../ids";
import { refuse, type ToolServices } from "./shared";

export const ASK_TOOL = "ask_user";

export const AskDetails = Type.Object({
  questionId: Type.String(),
  questions: Type.Array(Question),
});

export function askDetails(details: unknown) {
  return Value.Check(AskDetails, details) ? details : undefined;
}

export function askTools(services: ToolServices) {
  return [
    defineTool({
      name: ASK_TOOL,
      description:
        'Ask the person 1-3 questions. They see a card in the chat with your options (and can always type their own answer) and may answer at any time, or never. This does not wait: the answer arrives later as a new message from them that starts with "Answer to your question <id>". Ask only what you cannot reasonably decide yourself. After asking, do what you can without the answer and end your turn; do not repeat the question in your reply.',
      parameters: Type.Object({
        questions: Type.Array(
          Type.Object({
            id: Type.String({
              pattern: "^[a-z0-9_-]{1,40}$",
              description: "A short id for this question, unique in the card.",
            }),
            question: Type.String({ minLength: 1, maxLength: 500 }),
            options: Type.Optional(
              Type.Array(
                Type.Object({
                  label: Type.String({ minLength: 1, maxLength: 100 }),
                  description: Type.Optional(Type.String({ maxLength: 300 })),
                }),
                { maxItems: 6 },
              ),
            ),
          }),
          { minItems: 1, maxItems: 3 },
        ),
      }),
      replay: "safe",
      execute: async (args) => {
        const ids = args.questions.map((q) => q.id);
        if (new Set(ids).size !== ids.length)
          refuse("Each question needs its own id.");
        const questionId = `q_${ulid(services.now())}`;
        return {
          output: [
            {
              type: "text" as const,
              text: `Asked the person (question ${questionId}). Their answer will arrive as a later message; do not wait for it.`,
            },
          ],
          details: { questionId, questions: args.questions },
        };
      },
    }),
  ];
}
