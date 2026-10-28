// Todo + reminder tools for agents. Backed by SQLite (todos, reminders tables).
// Natural language ("remind me to X at 12pm tomorrow") is parsed by the agent
// into structured calls — the agent resolves relative dates itself.
import { addTodo, listTodos, completeTodo, addReminder, listReminders } from "./db.js";

export const TODO_TOOL_DEFS = [
  {
    name: "todo_add",
    description: "Save a todo. Use for anything the user wants tracked. Due as ISO datetime or null.",
    parameters: { type: "object", properties: {
      text: { type: "string", description: "Todo text" },
      due: { type: "string", description: "ISO datetime or null" },
      priority: { type: "string", description: "P1 (urgent) to P4" },
      project: { type: "string", description: "Optional project tag" },
    }, required: ["text"] },
  },
  {
    name: "todo_list",
    description: "List open todos (or all). Use before answering 'what are my todos'.",
    parameters: { type: "object", properties: {
      status: { type: "string", description: "open|done|all (default open)" },
    } },
  },
  {
    name: "todo_done",
    description: "Mark a todo done by id.",
    parameters: { type: "object", properties: {
      id: { type: "string", description: "Todo id" },
    }, required: ["id"] },
  },
  {
    name: "remind_add",
    description: "Set a reminder for an exact ISO datetime. Use for 'remind me to X at ...'.",
    parameters: { type: "object", properties: {
      text: { type: "string", description: "Reminder text" },
      at: { type: "string", description: "ISO datetime, e.g. 2026-10-27T12:00:00" },
    }, required: ["text", "at"] },
  },
  {
    name: "remind_list",
    description: "List pending reminders.",
    parameters: { type: "object", properties: {} },
  },
];

export async function runTodoTool(root, name, args, ctx = {}) {
  switch (name) {
    case "todo_add": {
      const id = addTodo(root, { ...args, user: ctx.user ?? "", channelId: ctx.channelId ?? "" });
      return `Saved todo ${id}: ${args.text}`;
    }
    case "todo_list": {
      const rows = listTodos(root, { status: args.status || "open" });
      if (!rows.length) return "No todos.";
      return rows.map((t) => `- ${t.id} [${t.priority}] ${t.text}${t.due ? ` (due ${t.due})` : ""}${t.status === "done" ? " ✓" : ""}`).join("\n");
    }
    case "todo_done": {
      return completeTodo(root, args.id) ? `Done: ${args.id}` : `No open todo '${args.id}'.`;
    }
    case "remind_add": {
      const id = addReminder(root, { ...args, user: ctx.user ?? "", channelId: ctx.channelId ?? "" });
      return `Reminder set ${id} for ${args.at}: ${args.text}`;
    }
    case "remind_list": {
      const rows = listReminders(root, {});
      if (!rows.length) return "No pending reminders.";
      return rows.map((r) => `- ${r.id} @ ${r.at}: ${r.text}`).join("\n");
    }
    default: throw new Error(`Unknown todo tool '${name}'`);
  }
}
