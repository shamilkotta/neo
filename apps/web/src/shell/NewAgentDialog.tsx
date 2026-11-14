import { useState } from "react";
import { attempt } from "../lib/toast";
import type { Instance } from "../state/instance";
import { ui } from "../state/ui";
import { Avatar, Spinner } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Field, Input, Textarea } from "../ui/Field";

export function NewAgentDialog({ instance, onCreated }: { instance: Instance; onCreated: (id: string) => void }) {
  const open = ui.newAgent.use();
  return (
    <Dialog open={open} onClose={() => ui.newAgent.set(false)} title="New agent" description="Each agent has its own chat, memory, files and routines.">
      {open && <Form instance={instance} onCreated={onCreated} />}
    </Dialog>
  );
}

function Form({ instance, onCreated }: { instance: Instance; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        const agent = await attempt(() =>
          instance.root.createAgent({
            name: name.trim(),
            ...(title.trim() ? { title: title.trim() } : {}),
            ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
          }),
        );
        setBusy(false);
        if (!agent) return;
        await instance.refresh();
        ui.newAgent.set(false);
        onCreated(agent.id);
      }}
    >
      <div className="flex items-center gap-3">
        <Avatar id={name || "new"} name={name || "?"} size={44} />
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Researcher" className="h-10 text-[15px]" />
      </div>
      <Field label="Title" hint="Optional">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Keeps an eye on the news for me" />
      </Field>
      <Field label="Instructions" hint="Optional. You can change these any time.">
        <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} placeholder="What should it focus on? How should it talk?" />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={() => ui.newAgent.set(false)}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
          {busy ? <Spinner /> : "Create agent"}
        </Button>
      </div>
    </form>
  );
}
