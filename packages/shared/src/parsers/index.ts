import type { BaseRecord, UserMessage, AssistantMessage } from "../types/index.ts";

export interface CustomTitleRecord {
  type: "custom-title";
  customTitle: string;
  sessionId: string;
}

// <REMOVED UUID HERE> parseJsonlLine :: auto-generated pointer for public function parseJsonlLine
export function parseJsonlLine(line: string): BaseRecord | CustomTitleRecord {
  return JSON.parse(line);
}

// <REMOVED UUID HERE> parseJsonlFile :: auto-generated pointer for public function parseJsonlFile
export function* parseJsonlFile(content: string): Generator<BaseRecord | CustomTitleRecord> {
  for (const line of content.split("\n")) {
    if (line.trim()) {
      yield parseJsonlLine(line);
    }
  }
}

// <REMOVED UUID HERE> isUserMessage :: auto-generated pointer for public function isUserMessage
export function isUserMessage(record: BaseRecord | CustomTitleRecord): record is UserMessage {
  return record.type === "user";
}

// <REMOVED UUID HERE> isAssistantMessage :: auto-generated pointer for public function isAssistantMessage
export function isAssistantMessage(record: BaseRecord | CustomTitleRecord): record is AssistantMessage {
  return record.type === "assistant";
}

// <REMOVED UUID HERE> isCustomTitle :: auto-generated pointer for public function isCustomTitle
export function isCustomTitle(record: BaseRecord | CustomTitleRecord): record is CustomTitleRecord {
  return record.type === "custom-title";
}

// <REMOVED UUID HERE> extractTextContent :: auto-generated pointer for public function extractTextContent
export function extractTextContent(message: UserMessage | AssistantMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}
