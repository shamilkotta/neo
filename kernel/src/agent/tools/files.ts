import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { AttachmentError, placeOutgoing } from "../attachments";
import { joinPath, VfsError } from "../../vfs/vfs";
import { refuse, type ToolServices } from "./shared";

export function fileTools(services: ToolServices) {
  return [
    defineTool({
      name: "send_file",
      description:
        "Send the person a file from your workspace (a report, a chart, an export...). The chat shows it to them with a download; mentioning a path in your answer does not. A copy is sent, so later changes to the file do not change what they got. Files the person sends you are listed under <attachments> in their message.",
      parameters: Type.Object({
        path: Type.String({ description: "The file to send." }),
        name: Type.Optional(
          Type.String({
            description: "The name the person sees; defaults to the file's.",
          }),
        ),
        caption: Type.Optional(
          Type.String({
            maxLength: 500,
            description: "A short line shown with the file.",
          }),
        ),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const path = joinPath("/", args.path);
        const file = await placeOutgoing(
          services.vfs,
          path,
          api.callId,
          args.name,
        ).catch(
          (e) =>
            refuse(
              e instanceof AttachmentError || e instanceof VfsError
                ? e.message
                : `Could not send ${path}: ${e instanceof Error ? e.message : String(e)}`,
            ),
        );
        const caption = args.caption?.trim() || null;
        return {
          output: [
            {
              type: "text" as const,
              text: `Sent ${file.name} (${file.mimeType}, ${file.size} bytes) to the person. Their copy is at ${file.path}.`,
            },
          ],
          details: { file: { ...file, caption } },
        };
      },
    }),
  ];
}
