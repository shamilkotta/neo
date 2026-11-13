import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import { memo, type MouseEvent, useMemo } from "react";
import { toast } from "../lib/toast";

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? "").split(/\s/)[0] || "text";
      return `<div class="codeblock"><div class="codeblock-head"><span>${escape(language)}</span><button type="button" data-copy class="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-hover hover:text-fg">${COPY_ICON}<span>Copy</span></button></div><pre><code>${escape(text)}</code></pre></div>`;
    },
    link({ href, text }: Tokens.Link) {
      return `<a href="${escape(href)}" target="_blank" rel="noreferrer noopener">${text}</a>`;
    },
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer noopener");
  }
});

export const render = (text: string) =>
  DOMPurify.sanitize(marked.parse(text, { async: false }), {
    ADD_ATTR: ["target", "data-copy"],
  });

function onClick(e: MouseEvent<HTMLDivElement>) {
  const button = (e.target as HTMLElement).closest("[data-copy]");
  if (!button) return;
  const code = button.closest(".codeblock")?.querySelector("code")?.textContent;
  if (code == null) return;
  void navigator.clipboard.writeText(code).then(() => toast("Copied"));
}

export const Markdown = memo(function Markdown({
  text,
}: {
  text: string;
}) {
  const html = useMemo(() => render(text), [text]);
  return (
    <div
      className="prose"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
