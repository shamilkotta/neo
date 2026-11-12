import { useState } from "react";
import { createStore } from "../lib/store";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Input } from "./Field";

interface Ask {
  title: string;
  body?: string;
  action: string;
  danger?: boolean;
  input?: { placeholder?: string; value?: string };
  resolve: (value: string | null) => void;
}

const asks = createStore<Ask | null>(null);

const open = (ask: Omit<Ask, "resolve">) =>
  new Promise<string | null>((resolve) => asks.set({ ...ask, resolve }));

export const confirm = (ask: Omit<Ask, "resolve" | "input">) =>
  open(ask).then((v) => v !== null);

export const promptText = (
  ask: Omit<Ask, "resolve" | "input"> & { placeholder?: string; value?: string },
) => open({ ...ask, input: { placeholder: ask.placeholder, value: ask.value } });

export function ConfirmHost() {
  const ask = asks.use();
  return ask ? <ConfirmDialog key={ask.title + ask.action} ask={ask} /> : null;
}

function ConfirmDialog({ ask }: { ask: Ask }) {
  const [value, setValue] = useState(ask.input?.value ?? "");
  const done = (v: string | null) => {
    asks.set(null);
    ask.resolve(v);
  };
  const ok = !ask.input || value.trim().length > 0;
  return (
    <Dialog open onClose={() => done(null)} title={ask.title} description={ask.body}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) done(ask.input ? value.trim() : "");
        }}
        className="flex flex-col gap-4"
      >
        {ask.input && (
          <Input
            autoFocus
            value={value}
            placeholder={ask.input.placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button
            type="submit"
            autoFocus={!ask.input}
            variant={ask.danger ? "danger" : "primary"}
            disabled={!ok}
          >
            {ask.action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
