export const assistantCommand = {
  name: "assistant",
  description: "Ask the Erxes AI Assistant",
  type: 1,
  options: [
    {
      name: "question",
      description: "Write your question",
      type: 3,
      required: true,
    },
  ],
} as const;

export const applicationCommands = [assistantCommand] as const;
