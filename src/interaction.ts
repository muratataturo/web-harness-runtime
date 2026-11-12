export type InteractionMode = "auto" | "approval";
export function interactionMode(value: unknown = "approval"): InteractionMode {
  if (value !== "auto" && value !== "approval")
    throw new Error("mode は auto または approval です");
  return value;
}
